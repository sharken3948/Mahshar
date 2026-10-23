import type { AuthType } from '@/types'

export const PROVIDER_AUTH_TYPES = ['public', 'apikey', 'bearer', 'queryparam', 'basic', 'headers', 'authorization',
  'oauth_client_credentials', 'oauth_pkce'] as const satisfies readonly AuthType[]
export const isOAuth = (type: string) => type === 'oauth_client_credentials' || type === 'oauth_pkce'

export class ProviderAuthError extends Error {
  constructor() { super('Provider authentication is invalid or unavailable') }
}
export function credentialString(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ProviderAuthError()
  try { encodeURIComponent(value) } catch { throw new ProviderAuthError() }
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderAuthError()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ProviderAuthError()
}
export function credentialObject(value: string | undefined) {
  try { return object(JSON.parse(credentialString(value, 24000))) } catch { throw new ProviderAuthError() }
}
const RESERVED = new Set(['authorization', 'proxy-authorization', 'proxy-authenticate', 'www-authenticate',
  'host', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding', 'te', 'trailer', 'content-length',
  'content-type', 'content-encoding', 'accept-encoding', 'expect', 'cookie', 'set-cookie', 'origin', 'referer',
  'forwarded', 'via', 'range', 'accept', 'user-agent', 'payment', 'payment-signature', 'payment-required',
  'payment-response', 'x-payment', 'x-payment-response', 'x-http-method-override', 'x-method-override',
  'x-original-url', 'x-rewrite-url', 'max-forwards', 'idempotency-key', 'x-idempotency-key',
  'cache-control', 'pragma', 'date', 'x-real-ip', 'true-client-ip', 'client-ip', 'x-http-method', 'x-method'])
export function validateCredentialHeader(raw: unknown): string {
  const name = credentialString(raw, 64).toLowerCase()
  const reservedName = name.replace(/[_.]/g, '-')
  if (!/^[a-z][a-z0-9_.-]*$/.test(name) || RESERVED.has(reservedName) ||
    /^(?:sec-|proxy-|access-control-|x-forwarded-|x-arc-|x-mahshar-|x-vercel-|x-middleware-|x-envoy-|x-original-|x-rewrite-|if-|cf-)/.test(reservedName)) throw new ProviderAuthError()
  return name
}
export type OAuthConfiguration = { provider: string; client_id: string; client_secret?: string; account_mode: 'seller' | 'buyer';
  resource_headers?: Record<string, string> }
export function oauthConfiguration(credential?: string): OAuthConfiguration {
  const config = credentialObject(credential)
  keys(config, ['provider', 'client_id', 'client_secret', 'account_mode', 'headers'])
  if (config.account_mode !== 'seller' && config.account_mode !== 'buyer') throw new ProviderAuthError()
  const provider = credentialString(config.provider, 64)
  if (!/^[a-z][a-z0-9_-]*$/.test(provider)) throw new ProviderAuthError()
  return { provider, client_id: credentialString(config.client_id, 1024),
    ...(config.client_secret !== undefined ? { client_secret: credentialString(config.client_secret, 4096) } : {}),
    ...(config.headers !== undefined ? { resource_headers: staticAuthentication('headers', JSON.stringify({ headers: config.headers })).headers } : {}),
    account_mode: config.account_mode }
}

/** New credential bundles live entirely inside the existing AES-GCM encrypted_key. */
export function staticAuthentication(authType: AuthType, credential?: string, param?: string | null) {
  const headers: Record<string, string> = {}
  const secrets: string[] = []
  const secret = (value: unknown, max?: number) => { const text = credentialString(value, max); secrets.push(text); return text }
  if (authType === 'public') return { headers, secrets }
  // Preserve legacy credential lengths; new bundle limits must not invalidate
  // previously stored provider keys or large bearer tokens.
  if (authType === 'apikey') headers['x-api-key'] = secret(credential, Number.MAX_SAFE_INTEGER)
  else if (authType === 'bearer') headers.authorization = `Bearer ${secret(credential, Number.MAX_SAFE_INTEGER)}`
  else if (authType === 'queryparam') {
    if (!param || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(param)) throw new ProviderAuthError()
    if (typeof credential !== 'string' || !credential.trim()) throw new ProviderAuthError()
    try { encodeURIComponent(credential) } catch { throw new ProviderAuthError() }
    // URLSearchParams safely encodes query credentials, including legacy
    // multiline values. They are never interpreted as HTTP header text.
    secrets.push(credential)
  } else if (authType === 'basic') {
    const config = credentialObject(credential); keys(config, ['username', 'password'])
    const component = (value: unknown, max: number) => {
      if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ProviderAuthError()
      try { encodeURIComponent(value) } catch { throw new ProviderAuthError() }
      if (value) secrets.push(value)
      return value
    }
    const username = component(config.username, 1024), password = component(config.password, 4096)
    if (!username.trim() && !password.trim()) throw new ProviderAuthError()
    if (username.includes(':')) throw new ProviderAuthError()
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
    secrets.push(`${username}:${password}`, encoded)
    headers.authorization = `Basic ${encoded}`
  } else if (authType === 'authorization') {
    const config = credentialObject(credential); keys(config, ['scheme', 'token'])
    const scheme = config.scheme === 'Token' ? 'Token' : config.scheme === 'ApiKey' ? 'ApiKey' : null
    if (!scheme) throw new ProviderAuthError()
    const token = secret(config.token)
    if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new ProviderAuthError()
    headers.authorization = `${scheme} ${token}`
  } else if (authType === 'headers') {
    const config = credentialObject(credential); keys(config, ['headers', 'authorization'])
    if (!Array.isArray(config.headers) || !config.headers.length || config.headers.length > 8) throw new ProviderAuthError()
    for (const raw of config.headers) {
      const entry = object(raw); keys(entry, ['name', 'value'])
      const name = validateCredentialHeader(entry.name)
      if (Object.hasOwn(headers, name)) throw new ProviderAuthError()
      const value = secret(entry.value, 4096)
      if (!/^[\x20-\x7e]+$/.test(value)) throw new ProviderAuthError()
      headers[name] = value
    }
    if (config.authorization !== undefined) {
      const authorization = object(config.authorization)
      if (authorization.scheme === 'Basic') {
        keys(authorization, ['scheme', 'username', 'password'])
        const extra = staticAuthentication('basic', JSON.stringify({ username: authorization.username, password: authorization.password }))
        Object.assign(headers, extra.headers); secrets.push(...extra.secrets)
      } else if (authorization.scheme === 'Bearer') {
        keys(authorization, ['scheme', 'token'])
        const token = secret(authorization.token)
        if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new ProviderAuthError()
        headers.authorization = `Bearer ${token}`
      } else {
        const extra = staticAuthentication('authorization', JSON.stringify(authorization))
        Object.assign(headers, extra.headers); secrets.push(...extra.secrets)
      }
    }
  } else if (isOAuth(authType)) {
    const config = oauthConfiguration(credential)
    if (authType === 'oauth_client_credentials' && (config.account_mode !== 'seller' || !config.client_secret)) throw new ProviderAuthError()
    secrets.push(config.client_id, ...(config.client_secret ? [config.client_secret] : []), ...Object.values(config.resource_headers ?? {}))
  } else throw new ProviderAuthError()
  if (!['apikey', 'bearer', 'queryparam'].includes(authType) && Buffer.byteLength(JSON.stringify(headers)) > 16384) throw new ProviderAuthError()
  for (const value of Object.values(headers)) secrets.push(value)
  return { headers, secrets }
}

export function validateProviderCredential(type: unknown, credential: unknown, param?: string | null) {
  try {
    if (!PROVIDER_AUTH_TYPES.includes(type as AuthType) || (credential != null && typeof credential !== 'string')) return false
    staticAuthentication(type as AuthType, credential as string | undefined, param)
    return true
  } catch { return false }
}

export const AUTH_BUNDLE_EXAMPLES: Partial<Record<AuthType, string>> = {
  basic: '{"username":"token-id","password":"secret"}',
  headers: '{"headers":[{"name":"X-Client-ID","value":"id"},{"name":"X-Client-Secret","value":"secret"}]}',
  authorization: '{"scheme":"Token","token":"secret"}',
  oauth_client_credentials: '{"provider":"approved-profile","client_id":"id","client_secret":"secret","account_mode":"seller"}',
  oauth_pkce: '{"provider":"approved-profile","client_id":"id","client_secret":"secret","account_mode":"seller"}',
}
