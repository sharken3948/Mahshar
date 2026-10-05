import 'server-only'
import { boundedJson, type DiscoveryFetcher } from '../fetch'
import { canonicalExternalUrl, durableExternalName, durableExternalSummary } from '../sanitize'
import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'
import type { RawCandidate } from '../types'

const BASE = 'https://api.apis.guru/v2'
const PROVIDERS_LIMIT = 64 * 1024
const DETAIL_LIMIT = 512 * 1024
export const APIS_GURU_PRODUCTS_PER_PROVIDER = 3

type ApiVersion = { key: string; groupKey: string; value: Record<string, unknown>; preferred: boolean }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : undefined
}

function boundedDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

export function parseApisGuruProviders(value: unknown): string[] {
  const data = record(value)?.data
  if (!Array.isArray(data) || data.length === 0 || data.length > 2_000) throw new Error('apis_guru_providers_invalid')
  const providers = data.filter((item): item is string => typeof item === 'string'
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i.test(item)
    && isOutboundUrlShapeAllowed(`https://${item}/`))
  if (!providers.length) throw new Error('apis_guru_providers_invalid')
  return [...new Set(providers.map(item => item.toLowerCase()))].sort((a, b) => a.localeCompare(b))
}

function versionsFor(key: string, value: unknown): ApiVersion[] {
  const api = record(value)
  if (!api) return []
  const versions = record(api.versions)
  const groupKey = key.replace(/(?:[:/@_-])v?\d+(?:\.\d+)*$/i, '')
  if (!versions) return [{ key, groupKey, value: api, preferred: false }]
  const preferred = typeof api.preferred === 'string' ? api.preferred : ''
  return Object.entries(versions).flatMap(([versionKey, versionValue]) => {
    const version = record(versionValue)
    return version ? [{ key: `${key}:${versionKey}`, groupKey, value: version, preferred: versionKey === preferred }] : []
  })
}

function versionParts(item: ApiVersion): number[] {
  const info = record(item.value.info)
  const raw = bounded(info?.version, 64) ?? item.key
  const numericCore = raw.split(/[-+](?=[a-z])/i, 1)[0]
  return (numericCore.match(/\d+/g) ?? []).slice(0, 6).map(Number)
}

function prereleaseRank(item: ApiVersion): number {
  const info = record(item.value.info)
  const raw = (bounded(info?.version, 64) ?? item.key.split(':').at(-1) ?? '').toLowerCase()
  if (/(?:^|[._+-])(?:alpha|a)\d*$/.test(raw)) return 3
  if (/(?:^|[._+-])(?:beta|b)\d*$/.test(raw)) return 2
  if (/(?:^|[._+-])rc\d*$/.test(raw)) return 1
  return /(?:^|[._+-])[a-z][a-z0-9.-]*$/i.test(raw) ? 4 : 0
}

function compareVersion(a: ApiVersion, b: ApiVersion): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference) return difference
  }
  const stability = prereleaseRank(a) - prereleaseRank(b)
  if (stability) return stability
  if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
  return a.key.localeCompare(b.key)
}

function deprecated(item: ApiVersion): boolean {
  const info = record(item.value.info)
  return item.value.deprecated === true || info?.deprecated === true
    || /\b(?:deprecated|obsolete|discontinued|sunset)\b/i.test(`${bounded(info?.title, 200) ?? ''} ${bounded(info?.description, 700) ?? ''}`)
}

function productGroup(item: ApiVersion): string {
  return item.groupKey.normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('und').replace(/\b(?:rest(?:ful)?\s+api|web\s+api|api)\b/gu, ' ')
    .replace(/\bv?\d+(?:\.\d+)*\b/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function candidateContractUrl(api: Record<string, unknown>): string | undefined {
  return canonicalExternalUrl(bounded(api.swaggerUrl, 2048) ?? bounded(api.openapiUrl, 2048))
}

function candidateDocsUrl(api: Record<string, unknown>): string | undefined {
  const externalDocs = record(api.externalDocs)
  const origins = Array.isArray(api['x-origin']) ? api['x-origin'].map(record).filter(Boolean) as Record<string, unknown>[] : []
  return canonicalExternalUrl(
    bounded(externalDocs?.url, 2048) ?? origins.map(origin => bounded(origin.url, 2048)).find(Boolean),
  )
}

function usable(item: ApiVersion): boolean {
  return Boolean(record(item.value.info) && (candidateContractUrl(item.value) || candidateDocsUrl(item.value)))
}

function candidateFor(provider: string, sourceUrl: string, item: ApiVersion): RawCandidate | null {
  const api = item.value
  const info = record(api.info)
  if (!info) return null
  const contact = record(info.contact)
  const contractUrl = candidateContractUrl(api)
  const docsUrl = candidateDocsUrl(api)
  const contactUrl = canonicalExternalUrl(bounded(contact?.url, 2048))
  const title = durableExternalName(bounded(info.title, 200) ?? bounded(item.key.split(':')[0], 200) ?? provider, 200)
  const providerName = durableExternalName(provider, 200)
  if (!title || !providerName) return null
  const description = bounded(info.description, 430)
  const specification = bounded(api.openapi, 24) ?? bounded(api.swagger, 24) ?? bounded(api.openapiVer, 24)
  return {
    sourceType: 'api_directory', sourceUrl: canonicalExternalUrl(sourceUrl) ?? `${BASE}/providers.json`,
    discoveredName: providerName, discoveredDomain: provider, discoveredProduct: title,
    discoveredContractUrl: contractUrl, discoveredDocsUrl: docsUrl, discoveredContactUrl: contactUrl,
    directoryAddedAt: boundedDate(api.added), directoryUpdatedAt: boundedDate(api.updated),
    sourceSummary: durableExternalSummary([
      specification ? `OpenAPI ${specification}.` : 'OpenAPI directory record.', description,
    ].filter(Boolean).join(' '), 700),
  }
}

export function parseApisGuruCandidates(provider: string, sourceUrl: string, value: unknown): RawCandidate[] {
  const apis = record(record(value)?.apis)
  if (!apis) return []
  const selected = new Map<string, ApiVersion>()
  for (const item of Object.entries(apis).flatMap(([key, entry]) => versionsFor(key, entry)).filter(item => !deprecated(item) && usable(item))) {
    const group = productGroup(item)
    if (!group) continue
    const current = selected.get(group)
    if (!current || compareVersion(item, current) < 0) selected.set(group, item)
  }
  return [...selected.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) => candidateFor(provider, sourceUrl, item)).filter((item): item is RawCandidate => item !== null)
    .slice(0, APIS_GURU_PRODUCTS_PER_PROVIDER)
}

export function parseApisGuruCandidate(provider: string, sourceUrl: string, value: unknown): RawCandidate | null {
  return parseApisGuruCandidates(provider, sourceUrl, value)[0] ?? null
}

export async function fetchApisGuruProviderNames(fetcher: DiscoveryFetcher): Promise<string[]> {
  return parseApisGuruProviders(await boundedJson(fetcher, `${BASE}/providers.json`, PROVIDERS_LIMIT))
}

export async function fetchApisGuruCandidates(fetcher: DiscoveryFetcher, provider: string): Promise<RawCandidate[]> {
  const url = `${BASE}/${encodeURIComponent(provider)}.json`
  return parseApisGuruCandidates(provider, url, await boundedJson(fetcher, url, DETAIL_LIMIT))
}
