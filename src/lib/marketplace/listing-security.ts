export const SENSITIVE_CONFIGURATION = ['endpoint_url', 'auth_type', 'encrypted_key', 'auth_param_name', 'method',
  'body_required', 'request_schema', 'dynamic_path_supported', 'path_parameters', 'query_parameters'] as const

// Verification covers the executable configuration plus the representative
// request and accepted response set. Keep this separate from
// SENSITIVE_CONFIGURATION: changing an example/status set invalidates
// verification, but does not by itself require a fresh wallet operation proof.
export const VERIFICATION_CONFIGURATION = [...SENSITIVE_CONFIGURATION, 'example_request', 'expected_status_codes'] as const

export function credentialProxyAllowed(listing: { encrypted_key: unknown; verified_at: unknown }) {
  return !listing.encrypted_key || Boolean(listing.verified_at)
}

const JSONB_CONFIGURATION_KEYS = new Set<string>(['request_schema', 'path_parameters', 'query_parameters'])
const POSTGRES_ARRAY_CONFIGURATION_KEYS = new Set<string>(['expected_status_codes'])

function comparableFilterValue(key: string, value: unknown) {
  if (JSONB_CONFIGURATION_KEYS.has(key)) return JSON.stringify(value)
  if (POSTGRES_ARRAY_CONFIGURATION_KEYS.has(key) && Array.isArray(value)) return `{${value.join(',')}}`
  return value
}

// Compare the exact tested snapshot so concurrent edits cannot inherit old verification.
// JSONB and PostgreSQL array columns need their respective PostgREST literal formats;
// passing JavaScript arrays directly would be template-coerced into invalid filters.
function matchConfigurationKeys<T extends { filter(column: string, operator: string, value: unknown): T }>(
  query: T,
  listing: Record<string, unknown>,
  keys: readonly string[],
): T {
  for (const key of keys) {
    const value = listing[key]
    if (value == null) { query = query.filter(key, 'is', null); continue }
    query = query.filter(key, 'eq', comparableFilterValue(key, value))
  }
  return query
}

export function matchListingConfiguration<T extends { filter(column: string, operator: string, value: unknown): T }>(query: T, listing: Record<string, unknown>): T {
  return matchConfigurationKeys(query, listing, SENSITIVE_CONFIGURATION)
}

export function matchListingVerificationConfiguration<T extends { filter(column: string, operator: string, value: unknown): T }>(query: T, listing: Record<string, unknown>): T {
  return matchConfigurationKeys(query, listing, VERIFICATION_CONFIGURATION)
}

// Normalize a seller-declared list of expected non-2xx status codes.
// Returns { ok: true, codes } — codes is null when the caller omitted the field or supplied []
// Returns { ok: false, error } for any malformed input so the API can reject it.
export function normalizeExpectedStatusCodes(
  raw: unknown,
): { ok: true; codes: number[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, codes: null }
  if (!Array.isArray(raw)) return { ok: false, error: 'expected_status_codes must be an array of integers' }
  if (raw.length === 0) return { ok: true, codes: null }
  if (raw.length > 20) return { ok: false, error: 'expected_status_codes accepts at most 20 codes' }
  const codes: number[] = []
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 300 || item > 599) {
      return { ok: false, error: 'Each expected status code must be an integer between 300 and 599' }
    }
    if (item === 408 || item === 429 || item >= 500) {
      return { ok: false, error: '408, 429, and 5xx statuses cannot be configured as expected responses' }
    }
    if (!codes.includes(item)) codes.push(item)
  }
  codes.sort((a, b) => a - b)
  return { ok: true, codes }
}

export function expectedCodesEqual(a: number[] | null | undefined, b: number[] | null | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}
