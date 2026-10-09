import { z } from 'zod'
import type { AgentListing, DiscoveryClientOptions } from './discovery-client'
import { issuePreparedCallToken, type PreparedCall, verifyPreparedCallToken } from './prepared-call'
import { buildProxyRequest } from './request-builder'

const MAX_PROXY_RESPONSE_BYTES = 4_200_000
const MAX_PAYMENT_REQUIRED_BYTES = 64 * 1024
const MAX_PAYMENT_RESPONSE_BYTES = 16 * 1024
const PURCHASE_ACCESS_HEADER = 'x-mahshar-purchase-access'

const paymentRequirementSchema = z.object({
  scheme: z.string().min(1).max(64),
  network: z.string().min(1).max(128),
  asset: z.string().min(1).max(256),
  amount: z.string().regex(/^\d+$/).max(128),
  payTo: z.string().min(1).max(256),
  maxTimeoutSeconds: z.number().int().nonnegative(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

const paymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({
    url: z.string().url().max(2048),
    description: z.string().max(2048).optional(),
    mimeType: z.string().max(256).optional(),
  }).passthrough(),
  accepts: z.array(paymentRequirementSchema).min(1).max(16),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

const paymentResponseSchema = z.object({
  success: z.literal(true),
  payer: z.string().max(256),
  transaction: z.string().max(1024),
  network: z.string().max(128),
  amount: z.string().max(128).optional(),
}).passthrough()

export class PaidAdapterError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PaidAdapterError'
  }
}
function decodeHeader(raw: string, maximum: number): unknown {
  if (!raw || Buffer.byteLength(raw) > maximum) throw new PaidAdapterError('invalid_payment_protocol_header')
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown
  } catch {
    throw new PaidAdapterError('invalid_payment_protocol_header')
  }
}

async function boundedBody(response: Response) {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_PROXY_RESPONSE_BYTES) {
    return { oversized: true as const }
  }
  if (!response.body) return { oversized: false as const, value: null }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_PROXY_RESPONSE_BYTES) {
      await reader.cancel()
      return { oversized: true as const }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!text) return { oversized: false as const, value: null }
  try { return { oversized: false as const, value: JSON.parse(text) as unknown } }
  catch { return { oversized: false as const, value: text } }
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function retryAfter(response: Response) {
  const value = response.headers.get('retry-after')
  return value && value.length <= 128 ? value : undefined
}

function paidMetadata(body: unknown) {
  const record = safeRecord(body)
  return {
    ...(typeof record.delivery_state === 'string' ? { delivery_state: record.delivery_state } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(typeof record.attemptId === 'string' ? { attempt_id: record.attemptId } : {}),
    ...(typeof record.purchaseId === 'string' ? { purchase_id: record.purchaseId } : {}),
    ...(typeof record.purchase_access_token === 'string' ? { purchase_access_token: record.purchase_access_token } : {}),
    ...(typeof record.retrieve_response === 'string' ? { retrieve_response: record.retrieve_response } : {}),
  }
}

export function createPaidClient(options: DiscoveryClientOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const origin = new URL(options.origin ?? (process.env.MARKETPLACE_ORIGIN || 'http://localhost:3000')).origin
  const timeoutMs = options.timeoutMs ?? 30_000

  async function selfFetch(url: URL, init: RequestInit, signed: boolean) {
    try {
      return await fetcher(url, {
        ...init,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return signed
        ? { transportError: true as const, result: { status: 'transport_outcome_unknown', warning: 'Payment-Signature was submitted. Do not create a fresh authorization; retry only the exact prepared call and signature.' } }
        : { transportError: true as const, result: { status: 'request_rejected', error: 'proxy_unavailable' } }
    }
  }

  return {
    async execute(listing: AgentListing, call: PreparedCall, input: { prepared_call_token?: string; payment_signature?: string }) {
      const signed = Boolean(input.payment_signature)
      if (signed) {
        const verified = verifyPreparedCallToken(input.prepared_call_token as string, call, listing)
        if (!verified.ok) return { status: 'request_rejected', error: verified.code }
      }

      let request
      try { request = buildProxyRequest(listing, call, origin, input.payment_signature) }
      catch (error) {
        return { status: 'request_rejected', error: error instanceof Error ? error.message : 'invalid_request' }
      }
      const fetched = await selfFetch(request.url, request.init, signed)
      if ('transportError' in fetched) return fetched.result
      const response = fetched
      const body = await boundedBody(response)
      if (body.oversized) return { status: 'mcp_response_too_large', http_status: response.status }

      if (!signed && response.status === 402) {
        const raw = response.headers.get('payment-required')
        if (!raw) return { status: 'request_rejected', http_status: 402, error: 'payment_challenge_missing' }
        let challenge
        try { challenge = paymentRequiredSchema.parse(decodeHeader(raw, MAX_PAYMENT_REQUIRED_BYTES)) }
        catch { return { status: 'request_rejected', http_status: 402, error: 'invalid_payment_challenge' } }
        return {
          status: 'payment_required',
          http_status: 402,
          payment_required: raw,
          challenge,
          prepared_call: call,
          prepared_call_token: issuePreparedCallToken(call, listing),
        }
      }

      if (!signed) {
        return {
          status: response.status === 429 ? 'rate_limited' : 'request_rejected',
          http_status: response.status,
          ...(retryAfter(response) ? { retry_after: retryAfter(response) } : {}),
          result: body.value,
        }
      }

      const rawPaymentResponse = response.headers.get('payment-response')
      if (rawPaymentResponse) {
        let settlement
        try { settlement = paymentResponseSchema.parse(decodeHeader(rawPaymentResponse, MAX_PAYMENT_RESPONSE_BYTES)) }
        catch { return { status: 'payment_state_error', http_status: response.status, error: 'invalid_payment_response', ...paidMetadata(body.value) } }
        return {
          status: 'paid_result',
          http_status: response.status,
          payment_response: rawPaymentResponse,
          settlement,
          ...paidMetadata(body.value),
          proxy_result: body.value,
        }
      }

      const record = safeRecord(body.value)
      const paymentState = typeof record.attemptId === 'string' || typeof record.delivery_state === 'string' || record.payment === 'ACCOUNTING_COMPLETE'
      return {
        status: response.status === 429 ? 'rate_limited' : paymentState ? 'payment_state_error' : 'payment_rejected',
        http_status: response.status,
        ...(retryAfter(response) ? { retry_after: retryAfter(response) } : {}),
        ...paidMetadata(body.value),
        result: body.value,
      }
    },

    async recover(input: { api_id: string; buyer_wallet: string; purchase_access_token: string }) {
      const url = new URL('/api/calls/last-response', origin)
      url.searchParams.set('api_id', input.api_id)
      url.searchParams.set('buyer_wallet', input.buyer_wallet.toLowerCase())
      const fetched = await selfFetch(url, {
        method: 'GET',
        headers: { [PURCHASE_ACCESS_HEADER]: input.purchase_access_token },
      }, false)
      if ('transportError' in fetched) return fetched.result
      const response = fetched
      const body = await boundedBody(response)
      if (body.oversized) return { status: 'mcp_response_too_large', http_status: response.status }
      const status = response.ok ? 'paid_result' : response.status === 429 ? 'rate_limited' :
        response.status === 404 ? 'recovery_not_found' : [401, 403].includes(response.status) ? 'recovery_denied' : 'request_rejected'
      return {
        status,
        http_status: response.status,
        ...(retryAfter(response) ? { retry_after: retryAfter(response) } : {}),
        ...paidMetadata(body.value),
        recovery_result: body.value,
      }
    },
  }
}
