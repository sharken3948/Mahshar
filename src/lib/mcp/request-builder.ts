import type { AgentListing } from './discovery-client'
import type { PreparedCall } from './prepared-call'

export type InputScalar = string | number | boolean

function normalizeMap(values: Record<string, InputScalar> | undefined) {
  return Object.fromEntries(Object.entries(values ?? {})
    .map(([key, value]) => [key, String(value).trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right)))
}
function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, normalizeJson(record[key])]))
  }
  return value
}

export function normalizePreparedCall(input: {
  api_id: string
  buyer_wallet: string
  path_values?: Record<string, InputScalar>
  query_values?: Record<string, InputScalar>
  body?: unknown
}, bodyPresent: boolean): PreparedCall {
  return {
    api_id: input.api_id,
    buyer_wallet: input.buyer_wallet.toLowerCase(),
    path_values: normalizeMap(input.path_values),
    query_values: normalizeMap(input.query_values),
    body_present: bodyPresent,
    ...(bodyPresent ? { body: normalizeJson(input.body) } : {}),
  }
}

function suffix(listing: AgentListing, call: PreparedCall) {
  const pathParameters = listing.request.path_parameters
  const queryParameters = listing.request.query_parameters
  const pathNames = new Set(pathParameters.map(parameter => parameter.name))
  const queryNames = new Set(queryParameters.map(parameter => parameter.name))
  if (Object.keys(call.path_values).some(name => !pathNames.has(name)) ||
    Object.keys(call.query_values).some(name => !queryNames.has(name))) {
    throw new Error('undeclared_request_input')
  }

  const segments: string[] = []
  let optionalGap = false
  for (const parameter of pathParameters) {
    const value = call.path_values[parameter.name]
    if (!value) {
      if (parameter.required === true) throw new Error('required_path_input_missing')
      optionalGap = true
      continue
    }
    if (optionalGap) throw new Error('invalid_optional_path_sequence')
    segments.push(encodeURIComponent(value))
  }

  const query = new URLSearchParams()
  for (const parameter of queryParameters) {
    const value = call.query_values[parameter.name]
    if (!value) {
      if (parameter.required === true) throw new Error('required_query_input_missing')
      continue
    }
    query.append(parameter.name, value)
  }
  query.sort()
  const search = query.toString()
  return `${segments.length ? `/${segments.join('/')}` : ''}${search ? `?${search}` : ''}`
}

function checkedProxyUrl(listing: AgentListing, origin: string) {
  const url = new URL(listing.proxy_url)
  if (url.origin !== origin || url.username || url.password || url.hash) throw new Error('invalid_public_proxy_contract')
  const expectedPath = listing.proxy_style === 'path' ? `/api/proxy/${encodeURIComponent(listing.id)}` : '/api/proxy'
  if (url.pathname !== expectedPath || url.search) throw new Error('invalid_public_proxy_contract')
  return url
}

export function buildProxyRequest(listing: AgentListing, call: PreparedCall, origin: string, paymentSignature?: string) {
  if (call.body_present && !listing.request.body.supported) throw new Error('request_body_not_supported')
  const requestSuffix = suffix(listing, call)
  const proxyUrl = checkedProxyUrl(listing, origin)
  const headers = new Headers()
  if (paymentSignature) headers.set('Payment-Signature', paymentSignature)

  if (listing.proxy_style === 'path') {
    if (call.path_values && Object.keys(call.path_values).length > 0) throw new Error('path_values_not_supported')
    proxyUrl.search = requestSuffix.startsWith('?') ? requestSuffix : ''
    if (listing.method === 'POST') {
      headers.set('content-type', 'application/json')
      return { url: proxyUrl, init: { method: 'POST', headers, ...(call.body_present ? { body: JSON.stringify(call.body) } : {}) } satisfies RequestInit }
    }
    return { url: proxyUrl, init: { method: 'GET', headers } satisfies RequestInit }
  }

  headers.set('content-type', 'application/json')
  return {
    url: proxyUrl,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        api_id: call.api_id,
        buyer_wallet: call.buyer_wallet,
        method: listing.method,
        ...(requestSuffix ? { path: requestSuffix } : {}),
        ...(call.body_present ? { body: call.body } : {}),
      }),
    } satisfies RequestInit,
  }
}
