import { createHash } from 'node:crypto'
import { getDomain } from 'tldts'
import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'

export type Permission = 'ALLOWED' | 'UNKNOWN' | 'REVIEW_REQUIRED' | 'PROHIBITED'
export type Lead = {
  id: string; providerId: string; name: string; description: string; docs: string; sources: string[]
  serviceIdentity?: string
  duplicateOf?: string
  auth: 'none' | 'required' | 'unknown'; endpoints?: string[]
}
export type Evidence = { url: string; sha256: string; note: string; checkedAt: string }
export type Result = {
  responseRights?: string
  technical: 'PASSED' | 'FAILED' | 'UNRESOLVED'; freeAccess: 'VERIFIED' | 'CREDENTIALS_REQUIRED' | 'UNVERIFIED'
  permission: Permission; termsChecked: boolean; endpoint: string | null; docs: string
  lastSuccess: string | null; reason: string; retryAt: string | null; evidence: Evidence[]
  tests: { url: string; status: number | null; reason: string; sha256?: string }[]
}
export type Candidate = { listingId?: string | null; publishedAt?: string | null; historical?: boolean; removedAt?: string | null; completedAt?: string | null; leaseUntil?: string | null; lead: Lead; result: Result | null; attempts: number; retryAt: string | null }
export const OWNER = '0x540a0027509b1c9aa0a2c5c65491cc97083e16de'
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export function domain(url: string) {
  const hostname = new URL(url).hostname
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname
}
export function providerDocument(endpoint: string, document: string): boolean {
  const provider = domain(endpoint)
  const brand = provider.split('.')[0]
  return domain(document) === provider || brand.length >= 4 && new URL(document).hostname.toLowerCase().split(/[.-]/).includes(brand)
}
export function canonical(input: string): string | null {
  try {
    const url = new URL(input); url.hash = ''
    if (!isOutboundUrlShapeAllowed(url.href)) return null
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    return url.href
  } catch { return null }
}
export function lead(input: Omit<Lead, 'id' | 'providerId'>): Lead | null {
  const docs = canonical(input.docs)
  if (!docs || /^(?:OpenAPI(?: Specification)?|Swagger|RAML|API Blueprint)$/i.test(input.name)
    || /\b(?:sdk|fuzzer|swagger (?:ui|tool)|documentation tool|api client)\b/i.test(input.name)
    || /\b(?:(?:javascript|typescript|python|rust|software|client) library|(?:swift|kotlin|java|javascript|typescript|python|rust|go) client|client wrapper|(?:sdk|client|code|openapi) generator|(?:api|web|python) framework|framework (?:for|to) (?:build|creat|develop)\w*|rest api fuzzer)\b/i.test(input.description)) return null
  const parsed = new URL(docs)
  // Hosted repositories are documentation, never API functionality.
  const providerId = ['github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)
    ? `github:${parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLowerCase()}` : domain(docs)
  const identity = `${providerId}:${input.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}`
  return { ...input, docs, providerId, id: digest(identity) }
}
export function usable(result: Result | null): boolean {
  return !!result && result.technical === 'PASSED' && result.freeAccess === 'VERIFIED'
    && !!result.endpoint && !!result.lastSuccess && result.tests.some(test => test.status === 200 && !!test.sha256)
    && result.termsChecked && ['ALLOWED', 'UNKNOWN', 'REVIEW_REQUIRED'].includes(result.permission)
}
export function apiKey(row: Candidate): string {
  return row.result?.endpoint ? canonical(row.result.endpoint) ?? row.lead.id : row.lead.id
}
export function usableCandidates(rows: Candidate[]): Candidate[] {
  const excluded = new Set(rows.filter(row => row.result?.permission === 'PROHIBITED' || !!row.removedAt || !!row.publishedAt).map(apiKey))
  const unique = new Map<string, Candidate>()
  for (const row of [...rows].sort((a,b)=>Number(!!b.historical) - Number(!!a.historical) || a.lead.id.localeCompare(b.lead.id))) {
    if (!row.lead.duplicateOf && !row.removedAt && !row.publishedAt && usable(row.result) && !excluded.has(apiKey(row)) && !unique.has(apiKey(row))) unique.set(apiKey(row), row)
  }
  return [...unique.values()]
}
export function emptyResult(docs: string): Result {
  return { technical: 'UNRESOLVED', freeAccess: 'UNVERIFIED', permission: 'UNKNOWN', termsChecked: false,
    endpoint: null, docs, lastSuccess: null, reason: 'pending', retryAt: null, evidence: [], tests: [] }
}
export function summary(rows: Candidate[]) {
  const permissions = { ALLOWED: 0, UNKNOWN: 0, REVIEW_REQUIRED: 0, PROHIBITED: 0 }
  for (const row of rows) permissions[row.result?.permission ?? 'UNKNOWN']++
  const functional = new Set(rows.filter(row => row.result?.technical === 'PASSED').map(apiKey)).size
  const usableCount = usableCandidates(rows).length
  return { admitted: rows.length, functional, usable: usableCount, permissions,
    termsChecked: rows.filter(row => row.result?.termsChecked).length,
    successPercent: rows.length ? 100 * usableCount / rows.length : 0 }
}
