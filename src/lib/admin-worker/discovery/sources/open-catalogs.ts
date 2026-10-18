import { createHash } from 'node:crypto'
import { normalizeWorkerIdentity } from '../../normalization'
import { canonicalExternalUrl, durableExternalName, durableExternalSummary } from '../sanitize'
import { boundedJson, type DiscoveryFetcher } from '../fetch'
import type { RawCandidate } from '../types'
import type { SourceEntry, SourcePage } from './adapter'
import { sourceCatalogUrl, type DiscoverySourceId } from './catalog'

const SHARED_HOSTS = ['rapidapi.com', 'postman.com', 'github.com', 'apify.com', 'apifyusercontent.com', 'publicapis.dev',
  'public-api-lists.github.io', 'apis.guru', 'api.market', 'zylalabs.com', 'allthingsdev.co']

function externalDomain(url: string): string | null {
  try {
    const domain = normalizeWorkerIdentity('domain', new URL(url).hostname)
    return SHARED_HOSTS.some(host => domain === host || domain.endsWith('.' + host)) ? null : domain
  } catch { return null }
}

export function directoryObservation(sourceId: DiscoverySourceId, entry: SourceEntry): RawCandidate | null {
  if (!entry.domain || !entry.url || !entry.title) return null
  return { sourceType: 'api_directory', sourceId, sourceRecordId: entry.id, sourceUrl: sourceCatalogUrl(sourceId),
    discoveredDomain: entry.domain, discoveredName: entry.domain, discoveredProduct: entry.title,
    discoveredDocsUrl: entry.url, sourceSummary: `Directory assertion: ${entry.summary ?? entry.title}` }
}

/** Read only Markdown table records from the two MIT datasets, never website HTML. */
export function parseMarkdownCatalog(text: string): SourceEntry[] {
  if (Buffer.byteLength(text) > 512 * 1024) throw new Error('directory_dataset_too_large')
  const entries = new Map<string, SourceEntry>()
  for (const line of text.split('\n')) {
    const match = /^\|\s*\[([^\]]+)\]\((https:\/\/[^\s)]+)\)\s*\|\s*([^|]*)/.exec(line)
    if (!match) continue
    const url = canonicalExternalUrl(match[2]); const title = durableExternalName(match[1], 120)
    const domain = url && externalDomain(url)
    if (!url || !title || !domain || url.length > 512) continue
    const id = createHash('sha256').update(url).digest('hex')
    entries.set(id, { id, domain, title, url, summary: durableExternalSummary(match[3], 80) })
    if (entries.size > 2000) throw new Error('directory_dataset_too_large')
  }
  if (!entries.size) throw new Error('directory_dataset_invalid')
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function markdownCatalog(source: DiscoverySourceId, fetcher: DiscoveryFetcher): Promise<SourceEntry[]> {
  const response = await fetcher(sourceCatalogUrl(source), { accept: 'text/plain' })
  if (response.status !== 200 || !response.contentType.toLowerCase().includes('text/plain')) throw new Error('directory_dataset_invalid')
  return parseMarkdownCatalog(response.body)
}

/** Actor metadata is not proof of an API or of the developer's website ownership. */
export async function apifyCatalog(fetcher: DiscoveryFetcher, page: string | null = null): Promise<SourcePage> {
  if (page !== null && !/^\d{1,7}$/.test(page)) throw new Error('source_page_invalid')
  const offset = page === null ? 0 : Number(page)
  const response = await boundedJson<{ data: { items: unknown[]; total: number; count: number; offset: number } }>(fetcher,
    `${sourceCatalogUrl('apify_store')}?limit=20&offset=${offset}&sortBy=newest`)
  const data = response.data
  if (!data || !Array.isArray(data.items) || data.items.length > 20 || data.count !== data.items.length
    || data.offset !== offset || !Number.isSafeInteger(data.total) || data.total < offset + data.count) throw new Error('apify_catalog_invalid')
  const entries: SourceEntry[] = data.items.map(value => {
    const actor = value as { id?: string; username?: string; name?: string; title?: string }
    if (!actor || typeof actor.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(actor.id)
      || typeof actor.username !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(actor.username)) throw new Error('apify_catalog_invalid')
    const title = durableExternalName(actor.title ?? actor.name, 120)
    if (!title) throw new Error('apify_catalog_invalid')
    return { id: actor.id, domain: '', publisher: actor.username, title }
  })
  if (data.count === 0 && offset < data.total) throw new Error('apify_catalog_no_progress')
  return { entries, nextPage: offset + data.count < data.total ? String(offset + data.count) : null }
}

export async function resolveApifyProvider(entry: SourceEntry, fetcher: DiscoveryFetcher): Promise<SourceEntry> {
  if (!entry.publisher || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.publisher)) throw new Error('apify_publisher_invalid')
  const response = await boundedJson<{ data?: { username?: string; profile?: { websiteUrl?: string } } }>(fetcher,
    'https://api.apify.com/v2/users/' + encodeURIComponent(entry.publisher))
  if (response.data?.username !== entry.publisher) throw new Error('apify_publisher_mismatch')
  const url = canonicalExternalUrl(response.data.profile?.websiteUrl)
  const domain = url?.startsWith('https://') ? externalDomain(url) : null
  return domain && url ? { ...entry, domain, url } : entry
}
