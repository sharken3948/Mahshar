import { withWalletSession, requireListingOwner } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { matchListingVerificationConfiguration, normalizeExpectedStatusCodes } from '@/lib/marketplace/listing-security'
import { decryptKey } from '@/lib/crypto'
import { NextRequest, NextResponse } from 'next/server'
import { scoreApi, type RealTestResult, type SetupSuggestions } from '@/lib/groq'
import { createServiceClient } from '@/lib/supabase/server'
import { validateEndpointUrl } from '@/lib/url-validation'
import { OutboundPolicyError, safeOutboundFetch } from '@/lib/outbound-fetch'
import { assessRepresentativeResponseSize, MAX_SAFE_SERIALIZED_RESPONSE_BYTES, readResponseBytes,
  ResponseTooLargeError } from '@/lib/proxy-response'
import type { AuthType } from '@/types'
import { enforceRateLimit } from '@/lib/rate-limit'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { validateListingRequestContract } from '@/lib/marketplace/request-contract'
import { buildUpstreamAuthentication } from '@/lib/marketplace/upstream-auth'
import type { DeclaredParameter } from '@/lib/marketplace/proxy-target'
import { LISTING_VERIFICATION_TIMEOUT_MS } from '@/lib/marketplace/listing-verification-timeout'

export const runtime = 'nodejs'

export interface FieldError {
  field: 'method' | 'example_request' | 'endpoint_url' | 'auth_key' | 'path_parameters' | 'query_parameters' |
    'body_required' | 'request_schema' | 'auth_param_name' | 'dynamic_path_supported'
  message: string
}

export interface EndpointTestDiagnostic {
  method: string
  url: string
  body_sent: string | null
  status: number | null
  response_snippet: string | null
}

type AnalysisBody = {
  api_id?: string
  draft?: boolean
  seller_wallet?: unknown
  name?: string
  category?: string
  description?: string
  method?: string
  example_request?: string
  example_response?: string
  endpoint_url?: string
  auth_type?: AuthType
  auth_key?: string
  auth_param_name?: string
  expected_status_codes?: number[]
  body_required?: boolean | null
  request_schema?: Record<string, unknown> | null
  dynamic_path_supported?: boolean
  path_parameters?: unknown[] | null
  query_parameters?: unknown[] | null
}

const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504])
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
const ALLOWED_AUTH = new Set<AuthType>(['public', 'apikey', 'bearer', 'queryparam'])
const CREDENTIAL_QUERY_NAMES = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|auth[_-]?token|appid)$/i

const STATUS_LABELS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
}

const EMPTY_SUGGESTIONS: SetupSuggestions = {
  name: null,
  description: null,
  category: null,
  method: null,
  auth_type: null,
  auth_param_name: null,
  example_request: null,
  example_response: null,
  body_required: null,
  path_parameters: [],
  query_parameters: [],
}

function statusLabel(status: number | null) {
  if (status == null) return 'No response'
  const label = STATUS_LABELS[status]
  return label ? `${status} ${label}` : String(status)
}

function isTransientStatus(status: number | null, timedOut: boolean) {
  return timedOut || (status != null && (TRANSIENT_STATUSES.has(status) || status >= 500))
}

function diagnosticUrl(raw: string) {
  const url = new URL(raw)
  for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '…')
  return url.toString()
}

function responseExample(value: unknown) {
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized.length <= 4_000 ? serialized : null
  } catch { return null }
}

function endpointQueryNames(raw: string) {
  try { return [...new Set(new URL(raw).searchParams.keys())].slice(0, 20) }
  catch { return [] }
}

function querySuggestions(names: string[]): DeclaredParameter[] {
  return names.filter(name => !CREDENTIAL_QUERY_NAMES.test(name) && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)).map(name => ({
    name,
    type: 'string' as const,
    required: true,
    description: `Value for the ${name} query input`,
  }))
}

function deterministicSuggestions(options: {
  endpointUrl: string
  responseBody?: unknown
  allowHeader?: string | null
  authenticateHeader?: string | null
}) {
  const names = endpointQueryNames(options.endpointUrl)
  const credentialName = names.find(name => CREDENTIAL_QUERY_NAMES.test(name)) ?? null
  const allowed = (options.allowHeader ?? '').split(',').map(value => value.trim().toUpperCase())
    .filter(value => ALLOWED_METHODS.has(value))
  const method = allowed.length === 1 ? allowed[0] as SetupSuggestions['method'] : null
  const bearer = /\bbearer\b/i.test(options.authenticateHeader ?? '')
  return {
    ...EMPTY_SUGGESTIONS,
    method,
    auth_type: bearer ? 'bearer' as const : credentialName ? 'queryparam' as const : null,
    auth_param_name: credentialName,
    example_response: options.responseBody === undefined ? null : responseExample(options.responseBody),
    query_parameters: querySuggestions(names),
  }
}

function mergeSuggestions(ai: SetupSuggestions | undefined, deterministic: SetupSuggestions): SetupSuggestions {
  const base = ai ?? EMPTY_SUGGESTIONS
  return {
    ...base,
    method: deterministic.method ?? base.method,
    auth_type: deterministic.auth_type ?? base.auth_type,
    auth_param_name: deterministic.auth_param_name ?? base.auth_param_name,
    example_response: deterministic.example_response ?? base.example_response,
    path_parameters: deterministic.path_parameters.length ? deterministic.path_parameters : base.path_parameters,
    query_parameters: deterministic.query_parameters.length ? deterministic.query_parameters : base.query_parameters,
  }
}

function earlyFailure(message: string, fieldErrors: FieldError[], status = 200) {
  return NextResponse.json({
    score: null,
    suggested_price: null,
    approved: false,
    ai_available: true,
    inconclusive: false,
    critical_issues: [message],
    warnings: [],
    positives: [],
    summary: message,
    endpoint_verified: false,
    endpoint_test_note: 'Endpoint test not completed.',
    endpoint_test_diagnostic: null,
    field_errors: fieldErrors,
    blocking_issue: message,
    suggestions: EMPTY_SUGGESTIONS,
  }, { status })
}

export const POST = withWalletSession(async (request: NextRequest, authenticatedWallet: string) => {
  const limited = await enforceRateLimit({ request, scope: 'ai-score', limit: 10, windowSeconds: 60,
    wallet: authenticatedWallet, failClosed: true })
  if (limited) return limited

  let body: AnalysisBody
  try { body = await readBoundedJson<AnalysisBody>(request, 64 * 1024) }
  catch (error) {
    const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
    return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' },
      { status: tooLarge ? 413 : 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  if (body.draft !== undefined && typeof body.draft !== 'boolean') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  assertWalletClaim(body.seller_wallet, authenticatedWallet)
  const db = createServiceClient()
  const persistedListing = body.api_id ? await requireListingOwner(db, body.api_id, authenticatedWallet) : null
  const persistAnalysis = Boolean(persistedListing && !body.draft)
  if (persistedListing && !body.draft) {
    body.endpoint_url = persistedListing.endpoint_url
    body.method = persistedListing.method ?? 'GET'
    body.auth_type = persistedListing.auth_type
    body.auth_param_name = persistedListing.auth_param_name ?? undefined
    try { body.auth_key = persistedListing.encrypted_key ? decryptKey(persistedListing.encrypted_key) : undefined }
    catch { return NextResponse.json({ error: 'Stored API credentials could not be read' }, { status: 500 }) }
    body.example_request = persistedListing.example_request ?? ''
    body.example_response = persistedListing.example_response ?? body.example_response
    body.expected_status_codes = (persistedListing.expected_status_codes as number[] | null) ?? undefined
    body.body_required = persistedListing.body_required
    body.request_schema = persistedListing.request_schema
    body.dynamic_path_supported = persistedListing.dynamic_path_supported
    body.path_parameters = persistedListing.path_parameters
    body.query_parameters = persistedListing.query_parameters
  } else if (persistedListing && body.auth_type !== 'public' && !body.auth_key?.trim()) {
    const storedCredentialMatchesDraft = typeof body.endpoint_url === 'string'
      && body.endpoint_url.trim() === persistedListing.endpoint_url
      && body.auth_type === persistedListing.auth_type
      && (body.auth_param_name ?? null) === (persistedListing.auth_param_name ?? null)
    if (storedCredentialMatchesDraft) {
      try { body.auth_key = persistedListing.encrypted_key ? decryptKey(persistedListing.encrypted_key) : undefined }
      catch { return NextResponse.json({ error: 'Stored API credentials could not be read' }, { status: 500 }) }
    }
  }

  const endpointUrl = typeof body.endpoint_url === 'string' ? body.endpoint_url.trim() : ''
  if (!endpointUrl) return earlyFailure('Enter an HTTPS endpoint URL to analyze.', [
    { field: 'endpoint_url', message: 'Endpoint URL is required.' },
  ], 400)
  const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'GET'
  if (!ALLOWED_METHODS.has(method)) return earlyFailure('Choose a supported HTTP method.', [
    { field: 'method', message: 'Method must be GET, POST, PUT, or DELETE.' },
  ], 400)
  const authType = body.auth_type ?? 'public'
  if (!ALLOWED_AUTH.has(authType)) return NextResponse.json({ error: 'Invalid authentication type' }, { status: 400 })
  if (authType !== 'public' && !body.auth_key?.trim()) {
    return earlyFailure('Authentication credentials are required before this endpoint can be tested.', [
      { field: 'auth_key', message: 'Add the API key or token used by this endpoint.' },
    ])
  }

  const expectedResult = normalizeExpectedStatusCodes(body.expected_status_codes)
  if (!expectedResult.ok) return NextResponse.json({ error: expectedResult.error }, { status: 400 })
  const requestContract = validateListingRequestContract({
    endpoint_url: endpointUrl,
    method,
    auth_type: authType,
    auth_param_name: body.auth_param_name,
    example_request: body.example_request,
    body_required: body.body_required,
    request_schema: body.request_schema,
    dynamic_path_supported: body.dynamic_path_supported ?? false,
    path_parameters: body.path_parameters ?? null,
    query_parameters: body.query_parameters ?? null,
  })
  if (!requestContract.ok) return earlyFailure(requestContract.error, [
    { field: requestContract.field, message: requestContract.error },
  ])

  const urlValidation = await validateEndpointUrl(endpointUrl)
  if (!urlValidation.valid) return earlyFailure(
    urlValidation.error === 'Could not resolve hostname'
      ? 'The endpoint hostname could not be resolved. Check the URL and try again.'
      : 'This endpoint destination cannot be used. Enter a public HTTPS URL.',
    [{ field: 'endpoint_url', message: 'Enter a public HTTPS endpoint that Mahshar can reach.' }],
    400,
  )

  const bodySent = method !== 'GET' && requestContract.example.body !== null
    ? JSON.stringify(requestContract.example.body) : null
  let transientCount = 0
  if (persistAnalysis) {
    const { data } = await db.from('api_listings').select('consecutive_transient_count').eq('id', body.api_id).single()
    transientCount = data?.consecutive_transient_count ?? 0
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LISTING_VERIFICATION_TIMEOUT_MS)
  const startedAt = Date.now()
  let timedOut = false
  let realTestResult: RealTestResult = { success: false, error: 'Endpoint request failed' }
  let responseBody: unknown
  let contentType: string | null = null
  let allowHeader: string | null = null
  let authenticateHeader: string | null = null
  let responseSizeBytes: number | null = null
  let responseSizeWarning: string | null = null

  try {
    const response = await safeOutboundFetch(requestContract.example.canonical_target, () => {
      const authenticated = buildUpstreamAuthentication(
        new URL(requestContract.example.canonical_target), authType, body.auth_key, body.auth_param_name,
      )
      return { url: authenticated.requestUrl, outboundInit: {
        method,
        headers: authenticated.headers,
        body: bodySent ?? undefined,
        redirect: 'manual',
        signal: controller.signal,
      } }
    }, { timeoutMs: LISTING_VERIFICATION_TIMEOUT_MS })
    clearTimeout(timeoutId)
    const latency = Date.now() - startedAt
    contentType = response.headers.get('content-type')
    allowHeader = response.headers.get('allow')
    authenticateHeader = response.headers.get('www-authenticate')
    let rawBody = ''
    try { rawBody = new TextDecoder().decode(await readResponseBytes(response.body, MAX_SAFE_SERIALIZED_RESPONSE_BYTES)) }
    catch (error) {
      if (error instanceof ResponseTooLargeError) {
        realTestResult = { success: false, status: response.status, latency_ms: latency,
          error: 'Response exceeds Mahshar\'s delivery size limit' }
        responseBody = undefined
        throw new ResponseTooLargeError()
      }
      throw error
    }
    if (body.auth_key) rawBody = rawBody.split(body.auth_key).join('[redacted]')
    try { responseBody = rawBody ? JSON.parse(rawBody) : null }
    catch { responseBody = rawBody }
    const snippet = rawBody ? `${rawBody.slice(0, 240)}${rawBody.length > 240 ? '…' : ''}` : null
    const size = assessRepresentativeResponseSize(responseBody)
    responseSizeBytes = size.serializedBytes
    responseSizeWarning = size.warning && !size.exceedsLimit
      ? 'The response is near Mahshar\'s delivery size limit. Consider pagination.' : null
    if (size.exceedsLimit) {
      realTestResult = { success: false, status: response.status, latency_ms: latency,
        error: 'Response exceeds Mahshar\'s delivery size limit' }
    } else if (response.status >= 300 && response.status < 400) {
      realTestResult = { success: false, status: response.status, latency_ms: latency,
        error: `Redirect (${response.status})`, response_snippet: snippet ?? undefined }
    } else if (response.ok) {
      realTestResult = { success: true, status: response.status, latency_ms: latency, body: responseBody }
    } else {
      realTestResult = { success: false, status: response.status, latency_ms: latency,
        error: `HTTP ${response.status}`, response_snippet: snippet ?? undefined }
    }
  } catch (error) {
    clearTimeout(timeoutId)
    if (!(error instanceof ResponseTooLargeError)) {
      timedOut = (error instanceof OutboundPolicyError && error.classification === 'timeout') ||
        (error instanceof Error && error.name === 'AbortError')
      realTestResult = { success: false, latency_ms: Date.now() - startedAt,
        error: timedOut ? 'Request timed out after 15 seconds' : 'Endpoint request failed' }
    }
  }

  const diagnostic: EndpointTestDiagnostic = {
    method,
    url: diagnosticUrl(requestContract.example.canonical_target),
    body_sent: bodySent,
    status: realTestResult.status ?? null,
    response_snippet: realTestResult.success ? null : (realTestResult.response_snippet ?? null),
  }

  if (persistAnalysis) {
    const transient = isTransientStatus(realTestResult.status ?? null, timedOut)
    transientCount = transient ? transientCount + 1 : 0
    await db.from('api_listings').update({ consecutive_transient_count: transientCount })
      .eq('id', body.api_id).ilike('seller_wallet', authenticatedWallet)
  }

  let blockingIssue: string | null = null
  let fieldErrors: FieldError[] = []
  const status = realTestResult.status ?? null
  const declaredExpected = !realTestResult.success && status != null && !timedOut &&
    !isTransientStatus(status, false) && (expectedResult.codes ?? []).includes(status)
  if (declaredExpected) realTestResult.declared_expected = true

  if (!realTestResult.success && !declaredExpected) {
    if (/delivery size limit/i.test(realTestResult.error ?? '')) {
      blockingIssue = 'The endpoint response is too large for Mahshar to deliver. Reduce it or add pagination.'
    } else if (timedOut || status == null) {
      blockingIssue = transientCount >= 3
        ? 'The endpoint has repeatedly timed out. Check its firewall, allowlist, availability, or response time.'
        : 'The endpoint did not respond within 15 seconds. Check that it is publicly reachable and try again.'
    } else if (isTransientStatus(status, false)) {
      blockingIssue = `${statusLabel(status)} may be temporary. Wait a moment, then analyze the endpoint again.`
    } else if (status === 405) {
      blockingIssue = `${method} is not accepted by this endpoint. Choose a supported HTTP method.`
      fieldErrors = [{ field: 'method', message: allowHeader
        ? `The endpoint allows: ${allowHeader}.` : `The endpoint rejected ${method}.` }]
    } else if (status === 401 || status === 403) {
      blockingIssue = `${statusLabel(status)}. Add the authentication credentials required by this endpoint.`
      fieldErrors = [{ field: 'auth_key', message: 'Add or correct the API key or token, then analyze again.' }]
    } else if (status === 404) {
      blockingIssue = 'The endpoint returned 404 Not Found. Check the URL and path.'
      fieldErrors = [{ field: 'endpoint_url', message: 'Check that this exact endpoint path exists.' }]
    } else if (status === 400 || status === 422) {
      blockingIssue = `${statusLabel(status)}. Add the request inputs this endpoint expects, then analyze again.`
      fieldErrors = [{ field: 'example_request', message: 'Update the request example or declared parameters.' }]
    } else if (status >= 300 && status < 400) {
      blockingIssue = `The endpoint redirects with ${status}. Use the final HTTPS destination URL.`
      fieldErrors = [{ field: 'endpoint_url', message: 'Replace this URL with the final destination.' }]
    } else {
      blockingIssue = `${statusLabel(status)}. Check that the endpoint is running correctly.`
    }
  }

  // Verification is a deterministic fact. Persist it before the advisory model
  // call so Groq availability can never strand an otherwise valid listing.
  if (persistAnalysis && realTestResult.success) {
    const { data, error } = await matchListingVerificationConfiguration(db.from('api_listings')
      .update({ verified_at: new Date().toISOString(), consecutive_transient_count: 0 })
      .eq('id', body.api_id).ilike('seller_wallet', authenticatedWallet), persistedListing!).select('id')
    if (error) return NextResponse.json({ error: 'Endpoint verification could not be saved' }, { status: 500 })
    if (!data?.length) return NextResponse.json({ error: 'Listing changed during analysis; retry' }, { status: 409 })
  }

  const deterministic = deterministicSuggestions({ endpointUrl, responseBody, allowHeader, authenticateHeader })
  let aiResult: Awaited<ReturnType<typeof scoreApi>> | null = null
  let aiAvailable = true
  let inconclusive = false
  try {
    aiResult = await scoreApi({
      name: body.name ?? '',
      category: body.category ?? '',
      description: body.description ?? '',
      endpoint_url: endpointUrl,
      method,
      auth_type: authType,
      auth_param_name: body.auth_param_name,
      endpoint_query_parameter_names: endpointQueryNames(endpointUrl),
      example_request: body.example_request,
      example_response: body.example_response,
    }, realTestResult)
  } catch {
    aiAvailable = false
    inconclusive = true
  }

  if (persistAnalysis && aiResult && (realTestResult.success || declaredExpected)) {
    const { data, error } = await matchListingVerificationConfiguration(db.from('api_listings')
      .update({ score: aiResult.score }).eq('id', body.api_id).ilike('seller_wallet', authenticatedWallet),
    persistedListing!).select('id')
    if (error || !data?.length) {
      // Score persistence is advisory. Deterministic verification above remains
      // authoritative and publishing must not depend on this optional write.
      aiAvailable = false
      inconclusive = true
      aiResult = null
    }
  }

  const suggestions = mergeSuggestions(aiResult?.suggestions, deterministic)
  const verified = realTestResult.success === true
  const endpointNote = verified
    ? `${statusLabel(status)} in ${realTestResult.latency_ms}ms`
    : timedOut ? 'No response within 15 seconds' : statusLabel(status)
  const positives = [...(aiResult?.positives ?? [])]
  if (verified && !positives.some(item => /reachable/i.test(item))) positives.unshift('Endpoint is reachable')
  if (contentType?.toLowerCase().includes('json') && !positives.some(item => /json/i.test(item))) {
    positives.push('JSON response detected')
  }

  return NextResponse.json({
    score: aiResult?.score ?? null,
    suggested_price: aiResult?.suggested_price ?? null,
    approved: verified && (aiResult?.approved ?? true),
    ai_available: aiAvailable,
    inconclusive,
    critical_issues: blockingIssue ? [blockingIssue, ...(aiResult?.critical_issues ?? [])] : (aiResult?.critical_issues ?? []),
    warnings: responseSizeWarning
      ? [...(aiResult?.warnings ?? []), responseSizeWarning] : (aiResult?.warnings ?? []),
    positives,
    summary: aiResult?.summary ?? (verified
      ? 'Endpoint checks passed. You can review the setup and publish without AI suggestions.'
      : blockingIssue ?? 'Endpoint analysis could not be completed.'),
    endpoint_verified: verified,
    endpoint_test_note: endpointNote,
    endpoint_test_diagnostic: diagnostic,
    field_errors: fieldErrors,
    blocking_issue: blockingIssue,
    suggestions,
    analysis: {
      method,
      status,
      status_text: statusLabel(status),
      latency_ms: realTestResult.latency_ms ?? null,
      content_type: contentType,
      json_response: Boolean(contentType?.toLowerCase().includes('json')),
      authentication_likely: status === 401 || status === 403 || Boolean(authenticateHeader),
      detected_parameter_count: suggestions.path_parameters.length + suggestions.query_parameters.length,
    },
    response_size_bytes: responseSizeBytes,
    response_size_warning: responseSizeWarning,
  })
})
