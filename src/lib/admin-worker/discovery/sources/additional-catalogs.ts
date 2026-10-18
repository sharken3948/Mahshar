import { createHash } from 'node:crypto'
import { normalizeWorkerIdentity } from '../../normalization'
import { canonicalExternalUrl, durableExternalName, durableExternalSummary } from '../sanitize'
import { boundedJson, type DiscoveryFetcher } from '../fetch'
import type { SourceEntry, SourcePage } from './adapter'
import { sourceCatalogUrl } from './catalog'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const SHARED = ['x402-list.com', 'payapi.market', 'bolthub.ai', 'amazon.com', 'amazonaws.com', 'api.aws',
  'github.com', 'github.io', 'vercel.app', 'netlify.app', 'workers.dev', 'onrender.com', 'fly.dev', 'railway.app',
  'rapidapi.com', 'postman.com', 'apify.com', 'api.market', 'supabase.co', 'ngrok.io', 'trycloudflare.com']

function pageNumber(page: string | null, initial: number): number {
  if (page !== null && !/^\d{1,7}$/.test(page)) throw new Error('source_page_invalid')
  const result = page === null ? initial : Number(page)
  if (result < initial || result >= 9_999_950) throw new Error('source_page_invalid')
  return result
}

/** Only an explicit external domain is an identity hint; catalog badges prove nothing. */
function entry(id: unknown, name: unknown, link: unknown, summary: unknown, credit = ''): SourceEntry | null {
  const rawId = text(id)
  const title = durableExternalName(text(name), 120)
  const url = canonicalExternalUrl(text(link), 512)
  if (!rawId || rawId.length > 253 || !title || !url) return null
  let domain: string
  try { domain = normalizeWorkerIdentity('domain', new URL(url).hostname) } catch { return null }
  if (SHARED.some(host => domain === host || domain.endsWith('.' + host))) return null
  return { id: createHash('sha256').update(rawId).digest('hex'), domain, title, url,
    summary: durableExternalSummary(`${credit}${text(summary) ?? title}`, 240) }
}

function unique(entries: (SourceEntry | null)[]): SourceEntry[] {
  return [...new Map(entries.filter((item): item is SourceEntry => item !== null).map(item => [item.id, item])).values()]
}

export function parseX402List(value: unknown, page = 1): SourcePage {
  const data = record(value), meta = record(data.meta), provenance = record(data.provenance)
  if (!Array.isArray(data.data) || data.data.length > 50 || meta.page !== page || meta.per_page !== 50
    || !integer(meta.total) || !integer(meta.total_pages) || meta.total_pages !== Math.ceil(meta.total / 50)
    || data.data.length !== Math.min(50, Math.max(0, meta.total - (page - 1) * 50))
    || provenance.license !== 'CC-BY-4.0' || provenance.attribution_required !== true
    || provenance.source !== 'https://x402-list.com') throw new Error('x402_list_catalog_invalid')
  const entries = unique(data.data.map(value => {
    const item = record(value)
    // Do not fetch base_url: it can be a paid execution route, not documentation.
    return entry(item.slug, item.name, item.website_url, item.description,
      'Data: x402-list.com (CC BY 4.0); normalized directory assertion. ')
  }))
  return { entries, nextPage: page < meta.total_pages ? String(page + 1) : null }
}

export async function x402ListCatalog(fetcher: DiscoveryFetcher, page: string | null = null): Promise<SourcePage> {
  const position = pageNumber(page, 1)
  return parseX402List(await boundedJson(fetcher,
    `${sourceCatalogUrl('x402_list')}?per_page=50&page=${position}&sort=newest`), position)
}

export function parsePayApi(value: unknown, offset = 0): SourcePage {
  const data = record(value)
  if (!Array.isArray(data.results) || data.results.length > 50 || data.count !== data.results.length
    || data.offset !== offset || data.limit !== 50 || !integer(data.total) || typeof data.has_more !== 'boolean'
    || (data.count > 0 && offset + data.count > data.total)
    || data.has_more !== (offset + data.count < data.total)
    || (data.has_more && (!integer(data.next_offset) || data.next_offset !== offset + data.count || data.count === 0))
    || (!data.has_more && data.next_offset !== null)) throw new Error('payapi_catalog_invalid')
  const entries = unique(data.results.map(value => {
    const item = record(value), base = canonicalExternalUrl(text(item.base_url))
    // Retain only the origin for subsequent website research, never the executable path.
    return item.status === 'live' && base ? entry(item.id, item.name, new URL(base).origin + '/', item.description) : null
  }))
  return { entries, nextPage: data.has_more ? String(data.next_offset) : null }
}

export async function payApiCatalog(fetcher: DiscoveryFetcher, page: string | null = null): Promise<SourcePage> {
  const offset = pageNumber(page, 0)
  // MCP list_apis has no pagination input; this documented equivalent does.
  return parsePayApi(await boundedJson(fetcher,
    `${sourceCatalogUrl('payapi_market')}?verified_only=false&limit=50&offset=${offset}`), offset)
}

export function parseBolthub(value: unknown, page = 1): SourcePage {
  const data = record(value)
  if (!Array.isArray(data.entries) || data.entries.length > 50 || !integer(data.total) || typeof data.hasMore !== 'boolean'
    || data.entries.length !== Math.min(50, Math.max(0, data.total - (page - 1) * 50))
    || data.hasMore !== (page * 50 < data.total)
    || (data.hasMore && (data.entries.length === 0 || page >= 1000))) throw new Error('bolthub_catalog_invalid')
  const entries = unique(data.entries.map(value => {
    const item = record(value)
    if (!Array.isArray(item.endpoints)) return null
    // A gateway slug or publisher username cannot establish an independent provider.
    // Only explicit external documentation links can enter the ownership pipeline.
    const links = item.endpoints.map(endpoint => record(endpoint).docsUrl)
    for (const link of links) {
      const candidate = entry(item.slug, item.displayTitle ?? item.name, link, item.description ?? item.originDescription)
      if (candidate) return candidate
    }
    return null
  }))
  return { entries, nextPage: data.hasMore ? String(page + 1) : null }
}

export async function bolthubCatalog(fetcher: DiscoveryFetcher, page: string | null = null): Promise<SourcePage> {
  const position = pageNumber(page, 1)
  if (position > 1000) throw new Error('source_page_invalid')
  return parseBolthub(await boundedJson(fetcher,
    `${sourceCatalogUrl('bolthub')}?page=${position}&limit=50`), position)
}
