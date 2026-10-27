import { safeOutboundFetch, isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'
import { digest } from './model'

export type Page = { url: string; status: number; type: string; body: string; sha256: string; binary?: { bytes: number; prefix: string } }
export class AccessError extends Error {
  constructor(code: string, readonly retryAt: string | null = null, readonly origin?: string) { super(code) }
}
export function retryAfter(value: string | null, now = Date.now()): string | null {
  if (!value) return null
  const at = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value)
  return Number.isFinite(at) ? new Date(Math.max(now + 1000, at)).toISOString() : null
}
export function safeUrl(value: string): boolean {
  try {
    const url = new URL(value), path = decodeURIComponent(url.pathname)
    if (!isOutboundUrlShapeAllowed(value) || /[{}<>$]/.test(url.hostname) || /[{}<>]|\$[\w{]|\.{3}|…|YOUR[_ -]|REPLACE[_ -]|(?:^|\/)\:[a-z_]/i.test(path)) return false
    return [...url.searchParams.entries()].every(([key, content]) => {
      if (/^(?:x[-_]api[-_]?key|api[-_]?(?:key|token)|access[-_]?(?:key|token)|refresh[-_]?token|id[-_]?token|token|auth(?:orization)?|auth[-_]?token|(?:client[-_]?)?secret|client[-_]?id|private[-_]?key|mnemonic|seed[-_]?phrase|password|email|phone|key|app[-_]?id|signature|sig|awsaccesskeyid|googleaccessid|x[-_](?:amz|goog)[-_](?:credential|signature|security[-_]token))$/i.test(key)
        || /\$[\w{]|YOUR[_ -]|REPLACE[_ -]|\.\.\.|…|[<>]/i.test(content)) return false
      if (/^https?:\/\//i.test(content) && !isOutboundUrlShapeAllowed(content)) return false
      if (/[{}]/.test(content)) {
        try { const parsed: unknown = JSON.parse(content); if (!parsed || typeof parsed !== 'object') return false } catch { return false }
      }
      return true
    })
  } catch { return false }
}
export function safeReadUrl(value: string): boolean {
  if (!safeUrl(value)) return false
  const url = new URL(value)
  const path = decodeURIComponent(url.pathname).replace(/([a-z])([A-Z])/g,'$1-$2')
  return !/(?:^|\/)(?:login|logout|auth|register|session|sessions|credentials|token|tokenizer|sign|send|create|insert|update|set|put|write|save|add|execute|mutate|graphql|delete|remove|purge|reset|revoke|transfer|withdraw|purchase|charge|pay|mint|burn|approve|swap|bridge|claim|deposit|payout|subscribe|unsubscribe|webhook|track|collect)(?:[/.?_-]|$)/i.test(path)
    && !/\/deck\/(?:new|[^/]+\/(?:draw|shuffle|return|pile))(?:\/|$)/i.test(path)
    && ![...url.searchParams.keys()].some(key => /^_?(?:action|method|operation|command|set|delete|create|update|write|save)$/i.test(key))
}
export function safeEndpoint(value: string): boolean {
  if (!safeReadUrl(value)) return false
  const url = new URL(value)
  return !['github.com', 'raw.githubusercontent.com', 'api.apis.guru'].includes(url.hostname)
    && !/(?:^|[/_-])health(?:[/_.-]|$)/i.test(url.pathname)
    && !/^\/(?:[a-z]{2}\/)?(?:developers?|documentation|reference)(?:\/|$)/i.test(url.pathname)
    && !/^(?:[a-z0-9-]*docs|developer|developers|documentation)\./i.test(url.hostname)
    && !/(?:^|\/)config(?:[-_/.]|$)/i.test(url.pathname)
    && !/(?:^|[-_/.])(?:schema|swagger|openapi|manifest)(?:[-_.]|$)/i.test(url.pathname)
    && !/^\/\.well-known(?:\/|$)/i.test(url.pathname)
    && !/(?:^|\/)(?:agent|ai-plugin|mcp)\.json$/i.test(url.pathname)
    && !/(?:^|\/)agents?\/(?:connections|capabilities|manifest|config)\.json$/i.test(url.pathname)
    && !/(?:^|\/)(?:manifest|apis|metadata|available|availability)\.(?:json|webmanifest)$/i.test(url.pathname)
    && !/(?:^|\/)(?:health\w*|ping|status|version|metrics|ready|live|docs?|changelog|swagger|openapi|schema|mcp|capabilities)(?:[/.?_-]|$)/i.test(decodeURIComponent(url.pathname))
}
/** Reject credential material before any response evidence is persisted. */
export function credentialPayload(body: string): boolean {
  const privateMaterial = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|PrivateKey\s*=\s*[A-Za-z0-9+/]{32,}={0,2}/i
  if (privateMaterial.test(body)) return true
  const inspect = (value: unknown, depth = 0): boolean => {
    if (typeof value === 'string') return privateMaterial.test(value)
    if (!value || typeof value !== 'object' || depth > 8) return false
    return Object.entries(value).some(([key,content]) => typeof content === 'string'
      && /^[\$_]*(?:private[-_ ]?key|privkey|vpnkey|client[-_]?secret|access[-_]?token|refresh[-_]?token|api[-_]?key|(?:(?:ssh|vpn|smtp|db|database)[-_])?password|passphrase|authorization|secret|token)$/i.test(key)
      && content.length > 0 && !/[<>]|YOUR_|EXAMPLE|REPLACE_|^(?:null|none|false|redacted|\*+)$/i.test(content)
      || inspect(content,depth + 1))
  }
  try { return inspect(JSON.parse(body)) } catch { return false }
}
export function robotsAllows(body: string, target: string): boolean {
  const groups: { agents: string[]; rules: { path: string; allow: boolean }[] }[] = []
  let group = { agents: [] as string[], rules: [] as { path: string; allow: boolean }[] }
  for (const line of body.split(/\r?\n/)) {
    const match = line.replace(/#.*/, '').trim().match(/^([^:]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1].toLowerCase(), value = match[2].trim()
    if (key === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] } }
      group.agents.push(value.toLowerCase())
    } else if (value && ['allow', 'disallow'].includes(key)) group.rules.push({ path: value, allow: key === 'allow' })
  }
  groups.push(group)
  const named = groups.filter(g => g.agents.some(a => a !== '*' && 'mahshar-freeapi'.includes(a)))
  const path = new URL(target).pathname + new URL(target).search
  const rules = (named.length ? named : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules)
    .filter(r => {
      const end = r.path.endsWith('$')
      const pattern = (end ? r.path.slice(0, -1) : r.path).split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp('^' + pattern + (end ? '$' : '')).test(path)
    }).sort((a, b) => b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length || Number(b.allow) - Number(a.allow))
  return rules[0]?.allow ?? true
}

/** Reuses Mahshar's DNS-pinned HTTPS transport. No credentials or daily counters. */
export class Network {
  private cache = new Map<string, Promise<Page>>()
  private cachedBytes = new Map<string, number>()
  private cacheBytes = 0
  private locks = new Map<string, Promise<unknown>>()
  readonly pauses: Record<string, string>
  constructor(private request: typeof safeOutboundFetch = safeOutboundFetch,
    pauses: Record<string, string> = {}, private record: (event: Record<string, unknown>) => void = () => {},
    private recordPage: (page: Page) => void = () => {},
    private canRequest: () => Promise<boolean> = async () => true) {
    this.pauses = { ...pauses }
  }
  clearDocuments() { this.cache.clear(); this.cachedBytes.clear(); this.cacheBytes = 0 }
  get documentBytes() { return this.cacheBytes }
  async page(url: string, fresh = false): Promise<Page> {
    if (!fresh && this.cache.has(url)) return this.cache.get(url)!
    const pending = this.allowed(url, new Set(), fresh)
    this.remember(url, pending)
    return pending
  }
  private remember(url: string, pending: Promise<Page>) {
    this.cacheBytes -= this.cachedBytes.get(url) ?? 0
    this.cachedBytes.delete(url)
    this.cache.set(url, pending)
    void pending.then(page => {
      if (this.cache.get(url) !== pending) return
      const bytes = Buffer.byteLength(page.body)
      this.cachedBytes.set(url, bytes); this.cacheBytes += bytes
      // Bound retained response memory, never the number of provider requests.
      while (this.cacheBytes > 32 * 1024 * 1024 && this.cachedBytes.size) {
        const oldest = this.cachedBytes.keys().next().value!
        this.cacheBytes -= this.cachedBytes.get(oldest)!
        this.cachedBytes.delete(oldest); this.cache.delete(oldest)
      }
    }, () => {})
  }
  private async allowed(url: string, redirects = new Set<string>(), testing = false): Promise<Page> {
    if (!safeReadUrl(url)) throw new AccessError('unsafe_url')
    const robotsUrl = new URL('/robots.txt', url).href
    let robots = this.cache.get(robotsUrl)
    if (!robots) { robots = this.raw(robotsUrl); this.remember(robotsUrl, robots) }
    const policy = await robots
    if (policy.status === 200 && !robotsAllows(policy.body, url)) throw new AccessError('robots_disallowed')
    if (![200, 404, 410].includes(policy.status)) throw new AccessError('robots_unavailable', new Date(Date.now() + 15 * 60_000).toISOString())
    return this.raw(url, true, redirects, testing)
  }
  private async raw(input: string, checkRedirectPolicy = false, visited = new Set<string>(), testing = false): Promise<Page> {
    let url = input
    for (;;) {
      if (!safeReadUrl(url)) throw new AccessError('unsafe_url')
      if (checkRedirectPolicy && url !== input) {
        // Every redirected destination gets its own DNS and robots checks.
        return this.allowed(url, visited, testing)
      }
      if (visited.has(url) || visited.size >= 5) throw new AccessError('redirect_cycle')
      visited.add(url)
      const origin = new URL(url).origin
      const previous = this.locks.get(origin) ?? Promise.resolve()
      const operation = previous.catch(() => {}).then(async () => {
        if (!await this.canRequest()) throw new AccessError('worker_stopped', new Date().toISOString())
        const delay = Date.parse(this.pauses[origin] ?? '') - Date.now()
        if (delay > 12_000) throw new AccessError('provider_cooldown', this.pauses[origin], origin)
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay))
          if (!await this.canRequest()) throw new AccessError('worker_stopped', new Date().toISOString())
        }
        const started = Date.now()
        try {
          const response = await this.request(url, { method: 'GET', redirect: 'manual', headers: {
            accept: testing ? 'application/json, text/plain;q=0.9, application/xml;q=0.8, image/*;q=0.7'
              : 'application/json, text/html, text/plain, application/yaml',
            'user-agent': 'Mahshar-FreeAPI/3.0', 'accept-encoding': 'identity',
          } }, { timeoutMs: 12_000 })
          const pause = retryAfter(response.headers.get('retry-after'))
          this.record({ url, status: response.status, retryAfter: pause, at: new Date().toISOString(), elapsedMs: Date.now() - started })
          if (pause) this.pauses[origin] = pause
          if (response.status === 429 || response.status === 403 || response.status >= 500) {
            const retryAt = pause ?? new Date(Date.now() + (response.status === 403 ? 3600_000 : 60_000)).toISOString()
            if (response.status === 429 || response.status === 403) this.pauses[origin] = retryAt
            await response.body?.cancel()
            throw new AccessError(response.status === 429 ? 'rate_limited' : response.status === 403 ? 'access_denied' : 'upstream_unavailable', retryAt, origin)
          }
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location'); await response.body?.cancel()
            if (!location) throw new AccessError('redirect_without_location')
            const redirect = new URL(location, url)
            if (pause) this.pauses[redirect.origin] = [pause,this.pauses[redirect.origin] ?? ''].sort().at(-1)!
            return { redirect: redirect.href }
          }
          const chunks: Uint8Array[] = []; let bytes = 0
          const reader = response.body?.getReader()
          try {
            if (reader) for (;;) {
              const part = await reader.read(); if (part.done) break
              bytes += part.value.length
              if (bytes > 4_000_000) throw new AccessError('response_too_large')
              chunks.push(part.value)
            }
          } finally { await reader?.cancel() }
          const buffer = Buffer.concat(chunks), type = response.headers.get('content-type') ?? ''
          const binary = /^image\/(?!svg)/i.test(type) ? { bytes: buffer.length, prefix: buffer.subarray(0, 32).toString('hex') } : undefined
          const page = { url, status: response.status, type, body: binary ? '' : buffer.toString('utf8'), sha256: digest(buffer), ...(binary ? { binary } : {}) }
          if (credentialPayload(page.body)) throw new AccessError('credential_payload_rejected')
          this.recordPage(page)
          return { page }
        } catch (error) {
          if (error instanceof AccessError) throw error
          const rawCode = error && typeof error === 'object' ? (error as { code?: unknown; classification?: unknown }).code
            ?? (error as { classification?: unknown }).classification : null
          const code = typeof rawCode === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'unknown_transport_error'
          const reason = /blocked|invalid_url/.test(code) ? 'unsafe_destination' : /CERT|TLS|SSL|VERIFY_LEAF/.test(code) ? 'tls_failure'
            : /ENOTFOUND|EAI_AGAIN|dns_failure/.test(code) ? 'dns_failure' : /TIMEOUT|timeout|ETIMEDOUT/.test(code) ? 'transport_timeout' : 'transport_failure'
          this.record({ url, status: null, error: reason, code, at: new Date().toISOString() })
          throw new AccessError(reason, new Date(Date.now() + 60_000).toISOString(), origin)
        }
      })
      this.locks.set(origin, operation)
      let outcome
      try { outcome = await operation }
      finally { if (this.locks.get(origin) === operation) this.locks.delete(origin) }
      if (outcome.page) return outcome.page
      url = outcome.redirect!
    }
  }
}
