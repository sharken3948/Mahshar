export const SENSITIVE_CONFIGURATION = ['endpoint_url', 'auth_type', 'encrypted_key', 'auth_param_name', 'method',
  'body_required', 'dynamic_path_supported', 'path_parameters', 'query_parameters'] as const

export function credentialProxyAllowed(listing: { encrypted_key: unknown; verified_at: unknown }) {
  return !listing.encrypted_key || Boolean(listing.verified_at)
}

const JSONB_CONFIGURATION_KEYS = new Set<string>(['path_parameters', 'query_parameters'])

// Compare the exact tested snapshot so concurrent edits cannot inherit old verification.
// jsonb columns must be serialized: PostgREST filter values are template-coerced,
// so an array would become "" or "[object Object]" and Postgres would reject the cast.
export function matchListingConfiguration<T extends { filter(column: string, operator: string, value: unknown): T }>(query: T, listing: Record<string, unknown>): T {
  for (const key of SENSITIVE_CONFIGURATION) {
    const value = listing[key]
    if (value == null) { query = query.filter(key, 'is', null); continue }
    query = query.filter(key, 'eq', JSONB_CONFIGURATION_KEYS.has(key) ? JSON.stringify(value) : value)
  }
  return query
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
