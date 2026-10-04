import {
  authorizeProxyTarget,
  declaredParameters,
  validateDeclaredParameterMetadata,
  validateDeclaredParameterValue,
  type DeclaredParameter,
  type ProxyTargetListing,
} from './proxy-target'
import { validateRequestBody, validateSupportedRequestSchema } from './request-body-schema'

export const SUPPORTED_LISTING_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const
export type SupportedListingMethod = typeof SUPPORTED_LISTING_METHODS[number]

export type ListingRequestContract = ProxyTargetListing & {
  method?: unknown
  example_request?: unknown
  body_required?: unknown
  request_schema?: unknown
}

export type ExecutableRequestExample = {
  path: Record<string, string>
  query: Record<string, string>
  body: unknown
  suffix: string
  canonical_target: string
}

export type RequestContractValidation =
  | { ok: true; method: SupportedListingMethod; example: ExecutableRequestExample }
  | { ok: false; error: string; field: 'method' | 'dynamic_path_supported' | 'path_parameters' | 'query_parameters' | 'example_request' | 'body_required' | 'request_schema' | 'auth_param_name' | 'endpoint_url' }

function scalarString(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function parsedJson(value: unknown): { present: boolean; value?: unknown; error?: string } {
  if (value == null || value === '') return { present: false }
  if (typeof value !== 'string') return { present: true, error: 'Example request must be stored as JSON text' }
  if (!value.trim()) return { present: false }
  try { return { present: true, value: JSON.parse(value) } }
  catch { return { present: true, error: 'Example request must be valid JSON' } }
}

function exampleValues(parameters: DeclaredParameter[], location: 'path' | 'query', requireDeclaredExample = true) {
  const values: Record<string, string> = {}
  for (const parameter of parameters) {
    if (parameter.example === undefined) {
      if (requireDeclaredExample && parameter.required === true) return { ok: false as const, error: `Required ${location} parameter "${parameter.name}" needs an example value` }
      continue
    }
    const value = scalarString(parameter.example)
    if (value === null || !validateDeclaredParameterValue(value, parameter)) {
      return { ok: false as const, error: `Example for ${location} parameter "${parameter.name}" does not match its declared constraints` }
    }
    values[parameter.name] = value
  }
  return { ok: true as const, values }
}

function appendExampleSuffix(pathParameters: DeclaredParameter[], path: Record<string, string>, query: Record<string, string>) {
  const segments: string[] = []
  let optionalGap = false
  for (const parameter of pathParameters) {
    const value = path[parameter.name]
    if (value === undefined) { optionalGap = true; continue }
    if (optionalGap) return { ok: false as const, error: `Path parameter "${parameter.name}" cannot follow an omitted optional path parameter` }
    segments.push(encodeURIComponent(value))
  }
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) search.append(name, value)
  const queryString = search.toString()
  return { ok: true as const, suffix: `${segments.length ? `/${segments.join('/')}` : ''}${queryString ? `?${queryString}` : ''}` }
}

/** Deterministically validates the persisted listing contract and builds its representative request. */
export function validateListingRequestContract(listing: ListingRequestContract): RequestContractValidation {
  const method = typeof listing.method === 'string' ? listing.method.toUpperCase() : 'GET'
  if (!SUPPORTED_LISTING_METHODS.includes(method as SupportedListingMethod)) {
    return { ok: false, field: 'method', error: 'Method must be GET, POST, PUT, or DELETE' }
  }
  if (listing.dynamic_path_supported !== true && listing.dynamic_path_supported !== false && listing.dynamic_path_supported != null) {
    return { ok: false, field: 'dynamic_path_supported', error: 'Dynamic path support must be enabled or disabled explicitly' }
  }
  if (!validateDeclaredParameterMetadata(listing.path_parameters ?? null)) {
    return { ok: false, field: 'path_parameters', error: 'Path parameters contain an invalid, duplicate, or unsafe declaration' }
  }
  if (!validateDeclaredParameterMetadata(listing.query_parameters ?? null)) {
    return { ok: false, field: 'query_parameters', error: 'Query parameters contain an invalid, duplicate, or unsafe declaration' }
  }
  const schema = validateSupportedRequestSchema(listing.request_schema)
  if (!schema.ok) return { ok: false, field: 'request_schema', error: schema.error }

  const pathParameters = declaredParameters(listing.path_parameters)
  const queryParameters = declaredParameters(listing.query_parameters)
  if (pathParameters.length && listing.dynamic_path_supported !== true) {
    return { ok: false, field: 'path_parameters', error: 'Enable variable paths before declaring path parameters' }
  }
  if (listing.dynamic_path_supported === true && pathParameters.length === 0) {
    return { ok: false, field: 'path_parameters', error: 'Variable paths require at least one declared path parameter' }
  }
  let optionalPathSeen = false
  for (const parameter of pathParameters) {
    if (parameter.required === false) optionalPathSeen = true
    else if (optionalPathSeen) return { ok: false, field: 'path_parameters', error: 'Required path parameters cannot follow optional path parameters' }
  }

  let endpoint: URL
  try { endpoint = new URL(listing.endpoint_url) }
  catch { return { ok: false, field: 'endpoint_url', error: 'Endpoint URL is invalid' } }
  const baseNames = [...endpoint.searchParams.keys()].map(name => name.toLowerCase())
  if (new Set(baseNames).size !== baseNames.length) {
    return { ok: false, field: 'endpoint_url', error: 'Endpoint URL contains duplicate query parameter names' }
  }
  for (const parameter of queryParameters) {
    if (baseNames.includes(parameter.name.toLowerCase())) {
      return { ok: false, field: 'query_parameters', error: `Buyer query parameter "${parameter.name}" duplicates a fixed endpoint query parameter` }
    }
  }
  if (listing.auth_type === 'queryparam') {
    const credentialName = listing.auth_param_name?.trim()
    if (!credentialName || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(credentialName)) {
      return { ok: false, field: 'auth_param_name', error: 'Query credential parameter name is required and must use a safe parameter name' }
    }
    const credentialKey = credentialName.toLowerCase()
    if (baseNames.includes(credentialKey)) {
      return { ok: false, field: 'endpoint_url', error: `Endpoint URL must not contain the credential parameter "${credentialName}"` }
    }
    if (queryParameters.some(parameter => parameter.name.toLowerCase() === credentialKey)) {
      return { ok: false, field: 'query_parameters', error: `Buyer query parameters must not use the credential name "${credentialName}"` }
    }
  }

  const pathExamples = exampleValues(pathParameters, 'path')
  if (!pathExamples.ok) return { ok: false, field: 'path_parameters', error: pathExamples.error }
  const queryExamples = exampleValues(queryParameters, 'query', method !== 'GET')
  if (!queryExamples.ok) return { ok: false, field: 'query_parameters', error: queryExamples.error }
  const parsed = parsedJson(listing.example_request)
  if (parsed.error) return { ok: false, field: 'example_request', error: parsed.error }

  let body: unknown = null
  const query = { ...queryExamples.values }
  if (method === 'GET') {
    if (listing.body_required === true) return { ok: false, field: 'body_required', error: 'GET listings cannot require or forward a request body' }
    if (parsed.present) {
      if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        return { ok: false, field: 'example_request', error: 'A legacy GET example must be a JSON object of declared query values' }
      }
      const byName = new Map(queryParameters.map(parameter => [parameter.name.toLowerCase(), parameter]))
      for (const [name, rawValue] of Object.entries(parsed.value as Record<string, unknown>)) {
        if (listing.auth_type === 'queryparam' && name.toLowerCase() === listing.auth_param_name?.toLowerCase()) {
          return { ok: false, field: 'example_request', error: `GET example must not include the seller credential parameter "${name}"` }
        }
        const parameter = byName.get(name.toLowerCase())
        if (!parameter) return { ok: false, field: 'example_request', error: `GET example uses undeclared query parameter "${name}"` }
        const value = scalarString(rawValue)
        if (value === null || !validateDeclaredParameterValue(value, parameter)) {
          return { ok: false, field: 'example_request', error: `GET example value for "${name}" does not match its declared constraints` }
        }
        query[parameter.name] = value
      }
    }
    const missingRequired = queryParameters.find(parameter => parameter.required === true && query[parameter.name] === undefined)
    if (missingRequired) return { ok: false, field: 'example_request', error: `Required query parameter "${missingRequired.name}" needs an example value` }
  } else {
    if (listing.body_required !== undefined && listing.body_required !== null && typeof listing.body_required !== 'boolean') {
      return { ok: false, field: 'body_required', error: 'Body required must be true, false, or unset' }
    }
    if (listing.body_required === true && (!parsed.present || parsed.value === null)) {
      return { ok: false, field: 'example_request', error: `${method} listing requires a JSON body example` }
    }
    body = parsed.present ? parsed.value : null
    if (parsed.present && listing.request_schema != null) {
      const bodyResult = validateRequestBody(listing.request_schema, parsed.value)
      if (!bodyResult.ok) return { ok: false, field: 'example_request', error: bodyResult.error }
    }
  }

  const built = appendExampleSuffix(pathParameters, pathExamples.values, query)
  if (!built.ok) return { ok: false, field: 'path_parameters', error: built.error }
  try {
    const canonical = authorizeProxyTarget(listing, built.suffix).toString()
    return { ok: true, method: method as SupportedListingMethod, example: {
      path: pathExamples.values, query, body, suffix: built.suffix, canonical_target: canonical,
    } }
  } catch {
    return { ok: false, field: 'example_request', error: 'Representative request cannot be executed by the declared listing contract' }
  }
}
