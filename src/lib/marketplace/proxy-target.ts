export type DeclaredParameter = {
  name: string
  required?: boolean
  enum?: string[]
  pattern?: string
  type?: 'string' | 'integer' | 'number' | 'boolean'
  minLength?: number
  maxLength?: number
}

export class ProxyTargetError extends Error {
  constructor(readonly code: 'dynamic_path_not_allowed' | 'invalid_dynamic_path' | 'undeclared_path' |
    'undeclared_query_parameter' | 'invalid_query_parameter' | 'credential_query_collision') {
    super(code)
    this.name = 'ProxyTargetError'
  }
}

function parameters(value: unknown): DeclaredParameter[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new ProxyTargetError('invalid_dynamic_path')
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ProxyTargetError('invalid_dynamic_path')
    const candidate = item as Record<string, unknown>
    if (typeof candidate.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate.name)) {
      throw new ProxyTargetError('invalid_dynamic_path')
    }
    if (candidate.required !== undefined && typeof candidate.required !== 'boolean') throw new ProxyTargetError('invalid_dynamic_path')
    if (candidate.enum !== undefined && (!Array.isArray(candidate.enum) || candidate.enum.length > 100 ||
      candidate.enum.some(value => typeof value !== 'string' || value.length > 512))) throw new ProxyTargetError('invalid_dynamic_path')
    if (candidate.pattern !== undefined) {
      if (typeof candidate.pattern !== 'string' || candidate.pattern.length > 256) throw new ProxyTargetError('invalid_dynamic_path')
      try { new RegExp(`^(?:${candidate.pattern})$`, 'u') } catch { throw new ProxyTargetError('invalid_dynamic_path') }
    }
    if (candidate.type !== undefined && !['string', 'integer', 'number', 'boolean'].includes(String(candidate.type))) {
      throw new ProxyTargetError('invalid_dynamic_path')
    }
    for (const key of ['minLength', 'maxLength'] as const) {
      if (candidate[key] !== undefined && (!Number.isInteger(candidate[key]) || Number(candidate[key]) < 0 || Number(candidate[key]) > 2048)) {
        throw new ProxyTargetError('invalid_dynamic_path')
      }
    }
    if (candidate.minLength !== undefined && candidate.maxLength !== undefined && Number(candidate.minLength) > Number(candidate.maxLength)) {
      throw new ProxyTargetError('invalid_dynamic_path')
    }
    return candidate as DeclaredParameter
  })
}

export function validateDeclaredParameterMetadata(value: unknown) {
  try {
    const parsed = parameters(value)
    const names = new Set<string>()
    for (const parameter of parsed) {
      const key = parameter.name.toLowerCase()
      if (names.has(key)) return false
      names.add(key)
    }
    return true
  } catch { return false }
}

function validateValue(value: string, parameter: DeclaredParameter) {
  if (value.length > 2048 || (parameter.minLength !== undefined && value.length < parameter.minLength) ||
    (parameter.maxLength !== undefined && value.length > parameter.maxLength)) return false
  if (parameter.enum && !parameter.enum.includes(value)) return false
  if (parameter.pattern && !new RegExp(`^(?:${parameter.pattern})$`, 'u').test(value)) return false
  if (parameter.type === 'integer' && !/^-?(?:0|[1-9]\d*)$/.test(value)) return false
  if (parameter.type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) return false
  if (parameter.type === 'boolean' && value !== 'true' && value !== 'false') return false
  return true
}

function assertNoTraversal(rawPathname: string) {
  let decoded = rawPathname
  for (let pass = 0; pass < 5; pass++) {
    if (decoded.includes('\\') || decoded.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new ProxyTargetError('invalid_dynamic_path')
    }
    let next: string
    try { next = decodeURIComponent(decoded) } catch { throw new ProxyTargetError('invalid_dynamic_path') }
    if (next === decoded) return
    decoded = next
  }
  throw new ProxyTargetError('invalid_dynamic_path')
}

export type ProxyTargetListing = {
  endpoint_url: string
  dynamic_path_supported?: boolean | null
  path_parameters?: unknown[] | null
  query_parameters?: unknown[] | null
  auth_type?: string | null
  auth_param_name?: string | null
}

/** Returns the exact canonical credential-free URL authorized by listing metadata. */
export function authorizeProxyTarget(listing: ProxyTargetListing, dynamicPath: unknown): URL {
  const supplied = dynamicPath == null ? '' : dynamicPath
  if (typeof supplied !== 'string' || supplied.length > 8192 || /[\u0000-\u001f\u007f]/.test(supplied)) {
    throw new ProxyTargetError('invalid_dynamic_path')
  }
  if (!supplied) return new URL(listing.endpoint_url)
  if (listing.dynamic_path_supported !== true) throw new ProxyTargetError('dynamic_path_not_allowed')
  if (!supplied.startsWith('/') && !supplied.startsWith('?')) throw new ProxyTargetError('invalid_dynamic_path')
  if (supplied.includes('#')) throw new ProxyTargetError('invalid_dynamic_path')

  const queryIndex = supplied.indexOf('?')
  const rawPathname = queryIndex === -1 ? supplied : supplied.slice(0, queryIndex)
  const rawQuery = queryIndex === -1 ? '' : supplied.slice(queryIndex + 1)
  assertNoTraversal(rawPathname)
  if (/%2f|%5c/i.test(rawPathname)) throw new ProxyTargetError('invalid_dynamic_path')

  const pathRules = parameters(listing.path_parameters)
  const segments = rawPathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment) } catch { throw new ProxyTargetError('invalid_dynamic_path') }
  })
  if (segments.length > 0 && pathRules.length === 0) throw new ProxyTargetError('undeclared_path')
  if (segments.length > pathRules.length || pathRules.slice(segments.length).some(rule => rule.required !== false)) {
    throw new ProxyTargetError('undeclared_path')
  }
  if (segments.some((segment, index) => !validateValue(segment, pathRules[index]))) throw new ProxyTargetError('undeclared_path')

  const queryRules = parameters(listing.query_parameters)
  const rulesByName = new Map(queryRules.map(rule => [rule.name.toLowerCase(), rule]))
  const suppliedNames = new Set<string>()
  const buyerQuery = new URLSearchParams(rawQuery)
  const credentialName = listing.auth_type === 'queryparam' ? listing.auth_param_name?.toLowerCase() : null
  const base = new URL(listing.endpoint_url)
  for (const [name, value] of buyerQuery) {
    const key = name.toLowerCase()
    if (!name || suppliedNames.has(key) || [...base.searchParams.keys()].some(existing => existing.toLowerCase() === key)) {
      throw new ProxyTargetError('invalid_query_parameter')
    }
    suppliedNames.add(key)
    if (credentialName && key === credentialName) throw new ProxyTargetError('credential_query_collision')
    const rule = rulesByName.get(key)
    if (!rule) throw new ProxyTargetError('undeclared_query_parameter')
    if (!validateValue(value, rule)) throw new ProxyTargetError('invalid_query_parameter')
  }
  if (queryRules.some(rule => rule.required === true && !suppliedNames.has(rule.name.toLowerCase()))) {
    throw new ProxyTargetError('invalid_query_parameter')
  }

  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  base.pathname = `${basePath}${rawPathname}` || '/'
  for (const [name, value] of buyerQuery) base.searchParams.append(name, value)
  base.searchParams.sort()
  return base
}
