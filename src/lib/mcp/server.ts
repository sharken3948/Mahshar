import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  createDiscoveryClient,
  DiscoverySourceError,
  publicListingSummary,
  type DiscoveryClientOptions,
} from './discovery-client'
import { createPaidClient } from './paid-client'
import { normalizePreparedCall } from './request-builder'

export const searchApisInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict()

export const getApiInputSchema = z.object({
  api_id: z.string().uuid(),
}).strict()

const walletSchema = z.string().regex(/^0x[\da-f]{40}$/i).refine(value => !/^0x0{40}$/i.test(value), 'Zero address is not allowed')
const inputScalarSchema = z.union([z.string().max(2048), z.number().finite(), z.boolean()])
const valueMapSchema = z.record(z.string().min(1).max(128), inputScalarSchema).superRefine((value, context) => {
  if (Object.keys(value).length > 64) context.addIssue({ code: 'custom', message: 'At most 64 values are allowed' })
})

export const executeApiCallInputSchema = z.object({
  api_id: z.string().uuid(),
  buyer_wallet: walletSchema,
  path_values: valueMapSchema.optional(),
  query_values: valueMapSchema.optional(),
  body: z.json().optional(),
  prepared_call_token: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).optional()
    .describe('Sensitive bearer value returned by the unsigned call. Supply this exact value only with payment_signature and identical API/call arguments; do not log or share it.'),
  payment_signature: z.string().min(1).max(32 * 1024).regex(/^[A-Za-z0-9+/_=-]+$/).optional()
    .describe('Sensitive Payment-Signature generated externally by the caller wallet from the returned live challenge. Supply it only with the exact prepared_call_token; never provide a private key, and do not log or share this value.'),
}).strict().superRefine((value, context) => {
  if (Boolean(value.prepared_call_token) !== Boolean(value.payment_signature)) {
    context.addIssue({ code: 'custom', message: 'prepared_call_token and payment_signature must be supplied together' })
  }
})

export const getPurchaseResponseInputSchema = z.object({
  api_id: z.string().uuid(),
  buyer_wallet: walletSchema,
  purchase_access_token: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .describe('Bearer-sensitive purchase capability returned by paid execution. It authorizes recovery of that exact purchase response; do not log or share it.'),
}).strict()

type McpHandlerOptions = DiscoveryClientOptions
const MAX_MCP_STRUCTURED_RESULT_BYTES = 4_300_000

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function paidResult(value: Record<string, unknown>) {
  const response = {
    content: [{ type: 'text' as const, text: `Mahshar result: ${String(value.status ?? 'completed')}` }],
    structuredContent: value,
  }
  if (Buffer.byteLength(JSON.stringify(response)) <= MAX_MCP_STRUCTURED_RESULT_BYTES) return response
  const bounded = {
    status: 'mcp_response_too_large',
    ...(typeof value.http_status === 'number' ? { http_status: value.http_status } : {}),
    ...(typeof value.delivery_state === 'string' ? { delivery_state: value.delivery_state } : {}),
    ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
    ...(typeof value.attempt_id === 'string' ? { attempt_id: value.attempt_id } : {}),
    ...(typeof value.purchase_id === 'string' ? { purchase_id: value.purchase_id } : {}),
    ...(typeof value.purchase_access_token === 'string' ? { purchase_access_token: value.purchase_access_token } : {}),
    ...(typeof value.retrieve_response === 'string' ? { retrieve_response: value.retrieve_response } : {}),
  }
  return {
    content: [{ type: 'text' as const, text: 'Mahshar result: mcp_response_too_large' }],
    structuredContent: bounded,
    isError: true,
  }
}

function toolError(code: 'api_not_found' | 'discovery_unavailable', details: Record<string, unknown> = {}) {
  return {
    ...result({ error: code, ...details }),
    isError: true,
  }
}

export function createMahsharMcpServer(options: McpHandlerOptions = {}) {
  const server = new McpServer(
    { name: 'mahshar-public-discovery', version: '1.0.0' },
    {
      maxToolInputElements: 4096,
      capabilities: { tools: { listChanged: false } },
    },
  )
  const discovery = createDiscoveryClient(options)
  const paid = createPaidClient(options)

  server.registerTool('search_apis', {
    title: 'Search Mahshar APIs',
    description: 'Search or page public active Mahshar API listing summaries.',
    inputSchema: searchApisInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset }) => {
    try {
      const page = await discovery.page(limit, offset)
      const apis = page.apis.map(publicListingSummary)

      return result({
        apis,
        pagination: {
          ...page.pagination,
          returned: apis.length,
        },
      })
    } catch (error) {
      if (error instanceof DiscoverySourceError) return toolError('discovery_unavailable')
      throw error
    }
  })

  server.registerTool('get_api', {
    title: 'Get Mahshar API',
    description: 'Return the public Mahshar agent execution contract for one active listing.',
    inputSchema: getApiInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ api_id }) => {
    try {
      const api = await discovery.find(api_id)
      return api ? result({ api }) : toolError('api_not_found', { api_id })
    } catch (error) {
      if (error instanceof DiscoverySourceError) return toolError('discovery_unavailable')
      throw error
    }
  })

  server.registerTool('execute_api_call', {
    title: 'Execute a Mahshar API call',
    description: 'Paid execution uses two calls to this same tool. First call without payment_signature and without prepared_call_token; the result returns status payment_required, the live payment challenge, a prepared_call_token, and normalized prepared-call arguments. Sign only that returned challenge externally with the caller\'s own wallet. Then call this same tool again with identical API/call arguments plus the exact returned prepared_call_token and the externally generated payment_signature; do not change any call argument between calls. Mahshar never accepts private keys, never signs on behalf of the caller, and never custodies buyer funds. If a signed submission returns transport_outcome_unknown, do not create a fresh authorization. Use get_purchase_response with the returned purchase capability for durable response recovery.',
    inputSchema: executeApiCallInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const listing = await discovery.find(input.api_id)
      if (!listing) return { ...paidResult({ status: 'request_rejected', error: 'api_not_found', api_id: input.api_id }), isError: true }
      const call = normalizePreparedCall(input, Object.prototype.hasOwnProperty.call(input, 'body'))
      const value = await paid.execute(listing, call, input)
      const output = paidResult(value)
      return value.status === 'payment_required' || value.status === 'paid_result' ? output : { ...output, isError: true }
    } catch (error) {
      if (error instanceof DiscoverySourceError) return { ...paidResult({ status: 'request_rejected', error: 'discovery_unavailable' }), isError: true }
      throw error
    }
  })

  server.registerTool('get_purchase_response', {
    title: 'Recover a paid Mahshar API response',
    description: 'Retrieve the exact durable response for one paid purchase using the purchase capability returned by paid execution. Recovery uses that bearer capability only and never falls back to a browser session. The capability is sensitive: do not log or share it.',
    inputSchema: getPurchaseResponseInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const value = await paid.recover(input)
    const output = paidResult(value)
    return value.status === 'paid_result' ? output : { ...output, isError: true }
  })

  return server
}

export function createMahsharMcpHandler(options: McpHandlerOptions = {}) {
  return createMcpHandler(
    () => createMahsharMcpServer(options),
    {
      legacy: 'reject',
      responseMode: 'json',
      maxSubscriptions: 0,
      maxRequestBodySize: 384 * 1024,
      onerror(error) {
        console.error('[mcp] protocol error:', error.message)
      },
    },
  )
}
