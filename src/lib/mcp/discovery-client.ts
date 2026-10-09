import { z } from 'zod'

const MAX_DISCOVERY_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_DISCOVERY_OFFSET = 10_000

const parameterSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  type: z.enum(['string', 'integer', 'number', 'boolean']).optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

const listingSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  price_per_call_usdc: z.number(),
  payment_model: z.literal('x402-pay-per-call'),
  auth: z.object({
    type: z.string(),
    injected_by: z.enum(['none', 'mahshar']),
    credential_location: z.string().nullable(),
    seller_credentials_exposed: z.literal(false),
  }),
  auth_type: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  score: z.number().nullable(),
  verified: z.boolean(),
  example_request: z.unknown().nullable(),
  example_response: z.unknown().nullable(),
  total_calls: z.number(),
  success_rate: z.number().nullable(),
  avg_latency_ms: z.number().nullable(),
  proxy_url: z.string().url(),
  proxy_style: z.enum(['path', 'envelope']),
  request: z.object({
    outer_method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    content_type: z.string().nullable(),
    body: z.object({
      supported: z.boolean(),
      required: z.boolean(),
      schema: z.unknown().nullable(),
      example: z.unknown().nullable(),
      delete_body_supported: z.boolean(),
    }),
    dynamic_path: z.object({
      supported: z.boolean(),
      transport: z.string().nullable(),
    }),
    query_transport: z.string(),
    path_parameters: z.array(parameterSchema),
    query_parameters: z.array(parameterSchema),
    example: z.object({
      path_values: z.record(z.string(), z.string()),
      query_values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      body: z.unknown().nullable(),
      proxy_url: z.string().url(),
      envelope: z.record(z.string(), z.unknown()).nullable(),
    }).nullable(),
    incoming_headers: z.object({
      supported: z.literal(false),
      reason: z.string(),
    }),
  }),
  response: z.object({
    content_type: z.string(),
    schema: z.unknown().nullable(),
    example: z.unknown().nullable(),
    wrapper: z.object({
      response: z.string(),
      latency_ms: z.string(),
      payment: z.string(),
      delivery_state: z.string(),
      attemptId: z.string(),
      purchase_access_token: z.string(),
    }),
  }),
})

const discoveryPageSchema = z.object({
  apis: z.array(listingSchema).max(100),
  pagination: z.object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(MAX_DISCOVERY_OFFSET),
    returned: z.number().int().min(0).max(100),
    next_offset: z.number().int().min(1).max(MAX_DISCOVERY_OFFSET + 100).nullable(),
  }),
})

export type AgentListing = z.infer<typeof listingSchema>

export class DiscoverySourceError extends Error {
  constructor(readonly status?: number) {
    super('discovery_source_unavailable')
    this.name = 'DiscoverySourceError'
  }
}

export type DiscoveryClientOptions = {
  fetcher?: typeof fetch
  origin?: string
  timeoutMs?: number
}

async function boundedJson(response: Response) {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_DISCOVERY_RESPONSE_BYTES) {
    throw new DiscoverySourceError(response.status)
  }

  if (!response.body) throw new DiscoverySourceError(response.status)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel()
        throw new DiscoverySourceError(response.status)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof DiscoverySourceError) throw error
    throw new DiscoverySourceError(response.status)
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new DiscoverySourceError(response.status)
  }
}

function validatePagination(
  page: z.infer<typeof discoveryPageSchema>,
  requestedLimit: number,
  requestedOffset: number,
) {
  const expectedNextOffset = page.apis.length === requestedLimit
    ? requestedOffset + requestedLimit
    : null
  if (page.pagination.limit !== requestedLimit ||
    page.pagination.offset !== requestedOffset ||
    page.pagination.returned !== page.apis.length ||
    page.pagination.next_offset !== expectedNextOffset) {
    throw new DiscoverySourceError()
  }
  return page
}

function configuredMarketplaceOrigin() {
  const configured = process.env.MARKETPLACE_ORIGIN?.trim()
  const fallback = process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000'
  const candidate = configured || fallback
  if (!candidate) throw new DiscoverySourceError()

  try {
    const url = new URL(candidate)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('origin_required')
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('https_required')
    return url.origin
  } catch {
    throw new DiscoverySourceError()
  }
}

export function createDiscoveryClient(options: DiscoveryClientOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const origin = options.origin ?? configuredMarketplaceOrigin()
  const timeoutMs = options.timeoutMs ?? 10_000

  async function page(limit: number, offset: number) {
    const url = new URL('/api/agent/discover', origin)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new DiscoverySourceError()
    }
    if (!response.ok) throw new DiscoverySourceError(response.status)

    try {
      const parsed = discoveryPageSchema.parse(await boundedJson(response))
      return validatePagination(parsed, limit, offset)
    } catch {
      throw new DiscoverySourceError(response.status)
    }
  }

  return {
    page,
    async find(apiId: string) {
      const limit = 100
      let offset = 0

      while (offset <= MAX_DISCOVERY_OFFSET) {
        const result = await page(limit, offset)
        const match = result.apis.find(api => api.id === apiId)
        if (match) return match
        if (result.pagination.next_offset === null || result.pagination.next_offset <= offset) return null
        offset = result.pagination.next_offset
      }
      return null
    },
  }
}

export const publicListingSummary = (listing: AgentListing) => ({
  id: listing.id,
  name: listing.name,
  description: listing.description,
  category: listing.category,
  price_per_call_usdc: listing.price_per_call_usdc,
  payment_model: listing.payment_model,
  auth_type: listing.auth_type,
  method: listing.method,
  score: listing.score,
  verified: listing.verified,
  total_calls: listing.total_calls,
  success_rate: listing.success_rate,
  avg_latency_ms: listing.avg_latency_ms,
  proxy_url: listing.proxy_url,
  proxy_style: listing.proxy_style,
})
