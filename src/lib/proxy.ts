import { credentialProxyAllowed } from '@/lib/marketplace/listing-security'
import { authorizeProxyTarget } from '@/lib/marketplace/proxy-target'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptKey } from '@/lib/crypto'
import type { ApiListing, PaymentModel } from '@/types'
import { buildUpstreamFailureDiagnostic, fetchUpstreamWithoutRedirects, readResponseBytes, ResponseTooLargeError,
  serializedJsonByteLength } from '@/lib/proxy-response'
import { buildUpstreamAuthentication } from '@/lib/marketplace/upstream-auth'
import { OutboundPolicyError } from '@/lib/outbound-fetch'

export type DeliveryOutcome = 'succeeded' | 'failed_final' | 'failed_retryable' | 'unknown'

export interface ProxyResult {
  status: number
  body: unknown
  latencyMs: number
  deliveryOutcome: DeliveryOutcome
  errorCode?: string
  responsePersisted: boolean
  callId?: string
}

export const MAX_SAFE_SERIALIZED_RESPONSE_BYTES = 4_000_000
const MAX_UPSTREAM_BYTES = MAX_SAFE_SERIALIZED_RESPONSE_BYTES
const CLIENT_FAULT_CODES = new Set([400, 404, 405, 422])

function classifyStatus(status: number): boolean | null {
  if (status >= 200 && status < 400) return null
  if (CLIENT_FAULT_CODES.has(status)) return true
  return false
}

export function proxyResponseEnvelope(input: {
  body: unknown
  latencyMs: number
  deliveryState: string
  retryable: boolean
  attemptId: string
  purchaseAccessToken: string
}) {
  return {
    response: input.body,
    latency_ms: input.latencyMs,
    payment: 'ACCOUNTING_COMPLETE',
    delivery_state: input.deliveryState,
    retryable: input.retryable,
    attemptId: input.attemptId,
    purchase_access_token: input.purchaseAccessToken,
  }
}

function persistenceFailure(latencyMs: number): ProxyResult {
  return {
    status: 503,
    body: { error: 'Durable response persistence unavailable' },
    latencyMs,
    deliveryOutcome: 'unknown',
    errorCode: 'response_persistence_unavailable',
    responsePersisted: false,
  }
}

export async function proxyRequest(params: {
  apiId: string
  buyerWallet: string
  paymentType: PaymentModel
  purchaseId?: string
  deliveryAttemptId?: string
  purchaseAccessToken?: string
  method: string
  dynamicPath?: string
  canonicalTarget: string
  incomingHeaders: Record<string, string>
  body?: unknown
  requireActive?: boolean
}): Promise<ProxyResult> {
  const supabase = createServiceClient()
  let listingQuery = supabase.from('api_listings').select('*').eq('id', params.apiId)
  if (params.requireActive !== false) listingQuery = listingQuery.eq('is_active', true)
  const { data: listing, error } = await listingQuery.single<ApiListing>()

  if (error || !listing) {
    return { status: 404, body: { error: 'API not found' }, latencyMs: 0, deliveryOutcome: 'failed_retryable',
      errorCode: 'listing_unavailable', responsePersisted: false }
  }
  if (!credentialProxyAllowed(listing)) {
    return { status: 409, body: { error: 'Endpoint requires verification' }, latencyMs: 0,
      deliveryOutcome: 'failed_retryable', errorCode: 'listing_verification_required', responsePersisted: false }
  }

  let targetUrl: string
  try { targetUrl = authorizeProxyTarget(listing, params.dynamicPath ?? '').toString() }
  catch {
    return { status: 409, body: { error: 'Listing request contract changed' }, latencyMs: 0,
      deliveryOutcome: 'failed_retryable', errorCode: 'listing_contract_changed', responsePersisted: false }
  }
  if (targetUrl !== params.canonicalTarget) {
    return { status: 409, body: { error: 'Listing request contract changed' }, latencyMs: 0,
      deliveryOutcome: 'failed_retryable', errorCode: 'listing_contract_changed', responsePersisted: false }
  }

  const log = async (input: { success: boolean; isClientError: boolean | null; isDeclaredExpected?: boolean; responseBody?: unknown }, latencyMs: number) => {
    const row: Record<string, unknown> = {
      api_id: params.apiId,
      buyer_wallet: params.buyerWallet.toLowerCase(),
      payment_type: params.paymentType,
      latency_ms: latencyMs,
      success: input.success,
      is_client_error: input.isClientError,
      is_declared_expected: input.isDeclaredExpected ?? false,
      ...(params.purchaseId ? { purchase_id: params.purchaseId } : {}),
      ...(params.deliveryAttemptId ? { delivery_attempt_id: params.deliveryAttemptId } : {}),
      ...(input.responseBody !== undefined ? {
        response_body: input.responseBody,
        response_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      } : {}),
    }
    const { data, error: insertError } = await supabase.from('api_calls').insert(row).select('id').single()
    if (insertError || !data?.id) throw new Error('api_call_persistence_failed')
    await checkAndAutoDeactivate(supabase, params.apiId)
    return String(data.id)
  }

  const logFailure = async (result: Omit<ProxyResult, 'responsePersisted'>, input: {
    isClientError: boolean | null; isDeclaredExpected?: boolean; responseBody?: unknown
  }): Promise<ProxyResult> => {
    try {
      const callId = await log({ success: false, ...input }, result.latencyMs)
      return { ...result, responsePersisted: false, callId }
    } catch { return persistenceFailure(result.latencyMs) }
  }

  const start = Date.now()
  let upstreamResponse: Response
  try {
    upstreamResponse = await fetchUpstreamWithoutRedirects(targetUrl, (validatedUrl: URL) => {
      const credential = listing.encrypted_key && ['apikey', 'bearer', 'queryparam'].includes(listing.auth_type)
        ? decryptKey(listing.encrypted_key) : undefined
      const { requestUrl, headers } = buildUpstreamAuthentication(validatedUrl, listing.auth_type, credential, listing.auth_param_name)
      return { url: requestUrl, outboundInit: {
        method: params.method,
        headers,
        body: params.method !== 'GET' && params.body !== undefined ? JSON.stringify(params.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      } }
    })
  } catch (err) {
    const latencyMs = Date.now() - start
    const safelyRetryable = err instanceof OutboundPolicyError &&
      ['invalid_url', 'blocked_destination', 'dns_failure', 'blocked_port'].includes(err.classification)
    return logFailure({
      status: 502, body: { error: 'Upstream unreachable' }, latencyMs,
      deliveryOutcome: safelyRetryable ? 'failed_retryable' : 'unknown',
      errorCode: safelyRetryable ? 'upstream_not_dispatched' : 'upstream_outcome_unknown',
    }, { isClientError: false })
  }

  const latencyMs = Date.now() - start
  const tooLarge = async () => logFailure({
    status: 502, body: { error: 'Upstream response exceeds the safe serialized response limit' }, latencyMs,
    deliveryOutcome: 'failed_final', errorCode: 'upstream_response_too_large',
  }, { isClientError: false })

  const declaredLength = Number(upstreamResponse.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    await upstreamResponse.body?.cancel().catch(() => undefined)
    return tooLarge()
  }

  let bytes: Uint8Array
  try { bytes = await readResponseBytes(upstreamResponse.body, MAX_UPSTREAM_BYTES) }
  catch (err) {
    if (err instanceof ResponseTooLargeError) return tooLarge()
    return logFailure({ status: 502, body: { error: 'Upstream unreachable' }, latencyMs,
      deliveryOutcome: 'unknown', errorCode: 'upstream_response_interrupted' }, { isClientError: false })
  }

  const rawText = new TextDecoder().decode(bytes)
  const contentType = upstreamResponse.headers.get('content-type') ?? ''
  let responseBody: unknown
  if (contentType.includes('application/json')) {
    try { responseBody = JSON.parse(rawText) } catch { responseBody = rawText }
  } else responseBody = rawText

  const success = upstreamResponse.status >= 200 && upstreamResponse.status < 300
  const declaredCodes = listing.expected_status_codes ?? []
  const isDeclaredExpected = !success && upstreamResponse.status !== 408 && upstreamResponse.status !== 429 &&
    upstreamResponse.status < 500 && declaredCodes.includes(upstreamResponse.status)

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    return logFailure({ status: 502, body: { error: 'Upstream redirects are not supported' }, latencyMs,
      deliveryOutcome: 'failed_final', errorCode: 'upstream_redirect_rejected' }, {
      isClientError: false,
      responseBody: buildUpstreamFailureDiagnostic(upstreamResponse.status, contentType, rawText),
    })
  }

  if (!success) {
    const finalEnvelope = params.purchaseAccessToken && params.deliveryAttemptId
      ? proxyResponseEnvelope({ body: responseBody, latencyMs, deliveryState: 'FAILED_FINAL', retryable: false,
          attemptId: params.deliveryAttemptId, purchaseAccessToken: params.purchaseAccessToken })
      : responseBody
    if (serializedJsonByteLength(finalEnvelope) > MAX_SAFE_SERIALIZED_RESPONSE_BYTES) return tooLarge()
    return logFailure({ status: upstreamResponse.status, body: responseBody, latencyMs,
      deliveryOutcome: 'failed_final', errorCode: 'upstream_http_error' }, {
      isClientError: classifyStatus(upstreamResponse.status), isDeclaredExpected,
      responseBody: buildUpstreamFailureDiagnostic(upstreamResponse.status, contentType, rawText),
    })
  }

  if (params.purchaseAccessToken && params.deliveryAttemptId) {
    const finalEnvelope = proxyResponseEnvelope({ body: responseBody, latencyMs, deliveryState: 'SUCCEEDED', retryable: false,
      attemptId: params.deliveryAttemptId, purchaseAccessToken: params.purchaseAccessToken })
    if (serializedJsonByteLength(finalEnvelope) > MAX_SAFE_SERIALIZED_RESPONSE_BYTES) return tooLarge()
  }

  try {
    const callId = await log({ success: true, isClientError: null, responseBody }, latencyMs)
    return { status: upstreamResponse.status, body: responseBody, latencyMs, deliveryOutcome: 'succeeded',
      responsePersisted: true, callId }
  } catch { return persistenceFailure(latencyMs) }
}

async function checkAndAutoDeactivate(supabase: ReturnType<typeof createServiceClient>, apiId: string): Promise<void> {
  try {
    const { data: recent } = await supabase.from('api_calls')
      .select('success, is_client_error, is_declared_expected, buyer_wallet')
      .eq('api_id', apiId).order('created_at', { ascending: false }).limit(50)
    if (!recent) return
    const nonClientFault = recent.filter(row => row.is_client_error !== true && row.is_declared_expected !== true)
    const last5 = nonClientFault.slice(0, 5)
    if (last5.length >= 5 && last5.every(row => !row.success && row.is_client_error === false) &&
      new Set(last5.map(row => row.buyer_wallet as string)).size >= 2) {
      await supabase.from('api_listings').update({ is_active: false }).eq('id', apiId)
      return
    }
    const last20 = nonClientFault.slice(0, 20)
    if (last20.length >= 20 && last20.filter(row => row.success).length / 20 < 0.8 &&
      new Set(last20.map(row => row.buyer_wallet as string)).size >= 2) {
      await supabase.from('api_listings').update({ is_active: false }).eq('id', apiId)
    }
  } catch {
    // Health monitoring is awaited but cannot change an already-recorded result.
  }
}
