import 'server-only'
import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'groq-sdk'

// Provider bodies/messages can contain prompts and credentials. Copy only these
// known machine labels, never a free-form message, response, headers or cause.
const PROVIDER_LABELS = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error',
  'server_error', 'api_error', 'tokens', 'requests', 'rate_limit_exceeded',
  'invalid_api_key', 'model_not_found', 'model_decommissioned', 'model_permission_blocked',
  'json_validate_failed', 'context_length_exceeded', 'insufficient_quota',
  'billing_hard_limit_reached', 'organization_restricted',
])
const label = (value: unknown) => typeof value === 'string' && PROVIDER_LABELS.has(value) ? value : null

function requestId(headers?: Headers): string | null {
  const value = headers?.get('x-request-id')
  // Groq request IDs are req_<opaque id>; also accept a canonical UUID.
  return value && /^(?:req_[A-Za-z0-9]{8,100}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(value) ? value : null
}

function retryAfter(headers?: Headers): number | null {
  const value = headers?.get('retry-after')?.trim()
  if (!value) return null
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Math.ceil(Number(value))
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      ? Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000)) : NaN
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null
}

export class GroqAnalysisError extends Error {
  readonly details: {
    status: number | null
    error_type: 'authentication' | 'permission' | 'rate_limit' | 'upstream' | 'timeout' | 'network' | 'aborted' | 'request' | 'unknown'
    provider_error_type: string | null
    provider_error_code: string | null
    request_id: string | null
    retry_after_seconds: number | null
  }

  constructor(error: unknown) {
    const sdk = error instanceof APIError ? error : null
    const status = sdk && Number.isInteger(sdk.status) && sdk.status! >= 400 && sdk.status! <= 599 ? sdk.status! : null
    const kind = error instanceof APIConnectionTimeoutError ? 'timeout'
      : error instanceof APIUserAbortError ? 'aborted'
      : error instanceof APIConnectionError ? 'network'
      : status === 401 ? 'authentication' : status === 403 ? 'permission'
      : status === 429 ? 'rate_limit' : status !== null && status >= 500 ? 'upstream'
      : status !== null ? 'request' : 'unknown'
    const reason = {
      authentication: 'authentication failed; check the configured API key.',
      permission: 'access denied; check account and model permissions.',
      rate_limit: 'rate limit reached; retry manually later.',
      upstream: 'provider service error; retry manually later.',
      timeout: 'request timed out.', network: 'connection failed.',
      aborted: 'request was cancelled.', request: 'provider rejected the analysis request.',
      unknown: 'request failed; provider details unavailable.',
    }[kind]
    super(`Groq${status === null ? '' : ` HTTP ${status}`}: ${reason}`)
    this.name = 'GroqAnalysisError'
    const envelope = sdk?.error as Record<string, unknown> | undefined
    const body = envelope?.error && typeof envelope.error === 'object'
      ? envelope.error as Record<string, unknown> : envelope
    this.details = {
      status, error_type: kind, provider_error_type: label(body?.type), provider_error_code: label(body?.code),
      request_id: requestId(sdk?.headers), retry_after_seconds: retryAfter(sdk?.headers),
    }
  }
}
