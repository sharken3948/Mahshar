import { createHash } from 'node:crypto'
import { normalizeWorkerIdentity } from '../../normalization'
import { canonicalExternalUrl, durableExternalName, durableExternalSummary } from '../sanitize'
import { boundedJson, type DiscoveryFetcher } from '../fetch'
import { fetchApisGuruCandidates, fetchApisGuruProviderNames } from './apis-guru'
import type { RawCandidate } from '../types'

export const DISCOVERY_SOURCE_IDS = ['apis_guru', 'public_api_lists'] as const
export type DiscoverySourceId = typeof DISCOVERY_SOURCE_IDS[number]
export type SourceEntry = { id: string; domain: string; candidate?: RawCandidate }
export type SourceSnapshot = {
  entries: SourceEntry[]; cursor: number; revision: string | null; fetchedAt: string | null
  refreshAfter: string | null; retryAfter: string | null; failures: number
}
export type DiscoverySourceState = { sourceId: DiscoverySourceId; version: number; snapshot: SourceSnapshot }
export type DiscoverySourceAdapter = {
  id: DiscoverySourceId
  catalog(fetcher: DiscoveryFetcher): Promise<SourceEntry[]>
  candidate(entry: SourceEntry, fetcher: DiscoveryFetcher, selection: number): Promise<RawCandidate | null>
}

export const PUBLIC_API_LISTS_URL = 'https://public-api-lists.github.io/public-api-lists/api/all.json'

/** MIT dataset metadata is an assertion, never ownership, contact or contract proof. */
export function parsePublicApiLists(value: unknown): SourceEntry[] {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!Array.isArray(data?.entries) || data.entries.length > 2000 || !data.entries.length) throw new Error('public_api_lists_invalid')
  const entries = new Map<string, SourceEntry>()
  for (const raw of data.entries) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const url = canonicalExternalUrl(typeof item.url === 'string' ? item.url : undefined)
    const name = durableExternalName(typeof item.name === 'string' ? item.name : undefined, 200)
    if (!url || !url.startsWith('https://') || !name) continue
    let domain: string
    try { domain = normalizeWorkerIdentity('domain', new URL(url).hostname) } catch { continue }
    // A marketplace/shared directory URL cannot identify its underlying provider.
    if (['rapidapi.com', 'postman.com', 'github.com', 'public-api-lists.github.io', 'apis.guru', 'api.market'].some(host => domain === host || domain.endsWith(`.${host}`))) continue
    const id = createHash('sha256').update(url).digest('hex')
    entries.set(id, { id, domain, candidate: {
      sourceType: 'api_directory', sourceId: 'public_api_lists', sourceRecordId: id,
      sourceUrl: PUBLIC_API_LISTS_URL, discoveredName: domain, discoveredDomain: domain,
      discoveredProduct: name, discoveredDocsUrl: url,
      sourceSummary: durableExternalSummary(`Directory API assertion: ${typeof item.description === 'string' ? item.description : name}`, 350),
    } })
  }
  if (!entries.size) throw new Error('public_api_lists_invalid')
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export const discoverySourceAdapters: readonly DiscoverySourceAdapter[] = [
  {
    id: 'apis_guru',
    catalog: async fetcher => (await fetchApisGuruProviderNames(fetcher)).map(domain => ({ id: domain, domain })),
    candidate: async (entry, fetcher, selection) => {
      const candidates = await fetchApisGuruCandidates(fetcher, entry.domain)
      const candidate = candidates[selection % candidates.length]
      return candidate ? { ...candidate, sourceId: 'apis_guru', sourceRecordId: entry.id } : null
    },
  },
  {
    id: 'public_api_lists',
    catalog: async fetcher => parsePublicApiLists(await boundedJson(fetcher, PUBLIC_API_LISTS_URL)),
    candidate: async entry => entry.candidate ?? null,
  },
]

export function catalogRevision(entries: SourceEntry[]): string {
  return createHash('sha256').update(JSON.stringify([...entries].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex')
}
