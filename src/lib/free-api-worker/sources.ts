/** Source adapters only; qualification remains in the existing pipeline. */
import { catalog, SOURCES, text } from './discovery'
import { canonical, digest, domain, lead, type Lead } from './model'
import { safeUrl, safeEndpoint, type Page } from './network'

export type Source = { id: string; name: string; url: string; kind: 'catalog' | 'guru' | 'mixed' | 'met' | 'markdown' }
export const DISCOVERY_SOURCES: Source[] = [
  ...SOURCES.map((url, index) => ({ id: ['freepublicapis', 'public-apis', 'marcelscruz', 'public-api-lists'][index],
    name: ['FreePublicAPIs', 'public-apis/public-apis', 'marcelscruz/public-apis', 'public-api-lists/public-api-lists'][index], url, kind: 'catalog' as const })),
  { id: 'mixed-analytics', name: 'Mixed Analytics — Free Open APIs', url: 'https://mixedanalytics.com/blog/list-actually-free-open-no-auth-needed-apis/', kind: 'mixed' },
  { id: 'met-norway', name: 'MET Norway — official Weather API products', url: 'https://api.met.no/weatherapi/', kind: 'met' },
  { id: 'n0shake', name: 'n0shake/Public-APIs', url: 'https://raw.githubusercontent.com/n0shake/Public-APIs/master/README.md', kind: 'markdown' },
  { id: 'apis-guru', name: 'APIs.guru OpenAPI Directory', url: 'https://api.apis.guru/v2/providers.json', kind: 'guru' },
]
export type DiscoveryProgress = {
  source: number; urls: string[]; seen: string[]; refreshAt: string | null
  stats: Record<string, { name: string; pages: number; observed: number; admitted: number; duplicates: number; errors: string[] }>
}
export const freshDiscovery = (): DiscoveryProgress => ({ source: 0, urls: [], seen: [], refreshAt: null, stats: {} })
const clean = (value: string) => text(value).replace(/\s+/g, ' ').trim()
function link(cell: string, base: string) {
  const found = [...cell.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].find(match => clean(match[2]))
  if (!found) return null
  try { const url = new URL(found[1].replace(/&amp;/g, '&'), base).href; return safeUrl(url) ? { url, name: clean(found[2]) } : null } catch { return null }
}
export function sourcePage(source: Source, page: Page): { leads: Lead[]; next: string[] } {
  const leads: Lead[] = [], next: string[] = []
  const add = (input: Parameters<typeof lead>[0], identity?: string, provider?: string) => {
    const item = lead(input)
    if (item) leads.push(identity ? { ...item, providerId: provider ?? item.providerId, id: digest(identity), serviceIdentity: identity } : item)
  }
  if (source.kind === 'catalog') return { leads: catalog(page.body, source.url), next }
  if (source.kind === 'guru') {
    const parsed = JSON.parse(page.body)
    if (page.url.endsWith('/providers.json')) {
      if (!Array.isArray(parsed.data)) throw new Error('invalid_provider_directory')
      for (const provider of parsed.data) if (typeof provider === 'string' && /^[a-z0-9._:-]+$/i.test(provider)) {
        next.push(`https://api.apis.guru/v2/${encodeURIComponent(provider)}.json`)
      }
    } else {
      for (const [key, value] of Object.entries(parsed.apis ?? parsed) as Array<[string, any]>) {
        // The provider endpoint returns flattened preferred APIs under `apis`;
        // the full directory format also supports an explicit versions map.
        const version = value?.versions ? value.versions[value.preferred] : value
        if (!version || typeof version.swaggerUrl !== 'string' || typeof version.info?.title !== 'string') continue
        const info = version.info, provider = key.split(':')[0].toLowerCase()
        const official = (Array.isArray(info['x-origin']) ? info['x-origin'] : []).map((origin: any) => origin?.url)
          .filter((url: unknown): url is string => typeof url === 'string' && !!canonical(url))
        // The catalog's preferred spec identifies a service, not each version or operation.
        add({ name: info.title, description: clean(String(info.description ?? info.title)), docs: version.swaggerUrl,
          sources: [...new Set([source.url, page.url, ...official])], auth: 'unknown' }, `apis.guru:${key}`, provider)
      }
    }
  } else if (source.kind === 'mixed') {
    for (const row of page.body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])
      if (cells.length !== 5) continue
      const api = link(cells[2], page.url)
      if (!api || /API Directories/i.test(clean(cells[1]))) continue
      const sample = link(cells[4], page.url)
      const input = { name: api.name, description: clean(cells[3]), docs: api.url, sources: [source.url], auth: 'none' as const,
        ...(sample && safeEndpoint(sample.url) ? { endpoints: [sample.url] } : {}) }
      const item = lead(input)
      const identity = input.endpoints?.[0] ? lead({ ...input, docs: input.endpoints[0] }) : null
      if (item) leads.push(identity ? { ...item, id: identity.id, providerId: identity.providerId } : item)
    }
  } else if (source.kind === 'met') {
    for (const row of page.body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])
      const product = cells.map(cell => link(cell, page.url)).find(value => value && /\/weatherapi\/[^/]+\/\d/.test(value.url))
      if (!product) continue
      const name = product.name.replace(/\s+\d+(?:\.\d+)*\s*$/, '')
      add({ name: 'MET Norway ' + name, description: clean(cells.join(' ')), docs: product.url, sources: [source.url], auth: 'unknown' },
        `met.no:${new URL(product.url).pathname.split('/')[2].toLowerCase()}`, 'met.no')
    }
  } else {
    // This independent collection has its own three-column service table format.
    for (const line of page.body.split(/\r?\n/)) {
      if (!line.startsWith('|')) continue
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
      const match = cells[0]?.match(/^\[(?:\*\*)?([^\]]+?)(?:\*\*)?\]\((https:\/\/[^\s)]+)\)$/)
      if (!match || cells.length !== 3) continue
      const description = clean(cells[1])
      if (/\bsdk\b/i.test(description) && !/\bapis?\b/i.test(description)) continue
      add({ name: match[1].replace(/\*\*/g, ''), description, docs: match[2], sources: [source.url], auth: 'unknown' })
    }
  }
  return { leads, next: [...new Set(next)] }
}
