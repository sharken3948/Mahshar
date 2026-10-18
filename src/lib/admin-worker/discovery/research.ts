import 'server-only'
import { createHash } from 'node:crypto'
import { officialContractLinks } from './contract-links'
import { WorkerMailInfrastructureError } from './provider-history'
import { officialNamingMetadata } from '../invitation-names'
import { normalizeWorkerIdentity } from '../normalization'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { canonicalExternalUrl, durableExternalSummary } from './sanitize'
import type { BudgetClaimResult, ProvenanceFact, RawCandidate } from './types'

export type ResearchResult = {
  facts: ProvenanceFact[]
  docsVerified: boolean
  failureCode: string | null
  compatibilityFailure: string | null
}

export type ResearchPurpose = 'contract' | 'ownership_docs' | 'ownership_root' | `link:${string}` | `redirect:${string}`

class ResearchBudgetError extends Error {}

type OpenApiInspection = {
  valid: boolean
  failureCode: string | null
  summary?: string
  endpointUrl?: string
}

const SUPPORTED_METHODS = new Set(['get', 'post', 'put', 'delete'])
const HTTP_METHODS = new Set([...SUPPORTED_METHODS, 'patch', 'options', 'head', 'trace'])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function inspectSecuritySchemes(specification: Record<string, unknown>): string | null {
  const components = record(specification.components)
  const schemes = record(components?.securitySchemes) ?? record(specification.securityDefinitions)
  if (!schemes || Object.keys(schemes).length === 0) return null
  let supported = false
  for (const value of Object.values(schemes)) {
    const scheme = record(value)
    if (!scheme || typeof scheme.type !== 'string') return 'malformed_auth_pattern'
    const type = scheme.type.toLowerCase()
    if (type === 'apikey') {
      if (typeof scheme.name !== 'string' || !['header', 'query', 'cookie'].includes(String(scheme.in).toLowerCase())) return 'malformed_auth_pattern'
      supported = true
    } else if (type === 'http') {
      if (!['basic', 'bearer'].includes(String(scheme.scheme).toLowerCase())) return 'malformed_auth_pattern'
      supported = true
    } else if (type === 'basic') supported = true
  }
  return supported ? null : 'unsupported_auth_pattern'
}

function endpointUrl(value: unknown, safeBaseUrl?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const direct = canonicalExternalUrl(value)
  if (direct) return direct
  if (!safeBaseUrl) return undefined
  try { return canonicalExternalUrl(new URL(value, safeBaseUrl).toString()) } catch { return undefined }
}

function inspectEndpoint(specification: Record<string, unknown>, openapi: string | null, swagger: string | null,
  safeBaseUrl?: string): { endpointUrl?: string; failureCode?: string } {
  if (openapi) {
    const servers = specification.servers
    if (!Array.isArray(servers) || servers.length === 0) {
      const fallback = endpointUrl('/', safeBaseUrl)
      return fallback ? { endpointUrl: fallback } : { failureCode: 'api_endpoint_missing' }
    }
    const urls = servers.map(server => endpointUrl(record(server)?.url, safeBaseUrl))
    if (urls.some(url => !url)) return { failureCode: 'unsafe_api_endpoint' }
    return { endpointUrl: urls[0] }
  }
  if (swagger === '2.0') {
    let base: URL | null = null
    try { base = safeBaseUrl ? new URL(safeBaseUrl) : null } catch { base = null }
    const host = typeof specification.host === 'string' ? specification.host.trim() : base?.host ?? ''
    const declaredSchemes = Array.isArray(specification.schemes)
      ? specification.schemes.filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase()) : []
    const schemes = declaredSchemes.length ? declaredSchemes : base?.protocol === 'https:' ? ['https'] : []
    if (!host || !/^[A-Za-z0-9.-]+(?::443)?$/.test(host)) return { failureCode: 'api_endpoint_missing' }
    if (!schemes.includes('https')) return { failureCode: 'unsafe_api_endpoint' }
    const basePath = typeof specification.basePath === 'string' ? specification.basePath : '/'
    if (!basePath.startsWith('/') || basePath.includes('\\') || basePath.split('/').includes('..')) return { failureCode: 'unsafe_api_endpoint' }
    const endpointUrl = canonicalExternalUrl(`https://${host}${basePath}`)
    return endpointUrl ? { endpointUrl } : { failureCode: 'unsafe_api_endpoint' }
  }
  return { failureCode: 'api_endpoint_missing' }
}

export function inspectOpenApiDocument(body: string, safeBaseUrl?: string): OpenApiInspection {
  let specification: Record<string, unknown> | null
  try { specification = record(JSON.parse(body)) } catch { return { valid: false, failureCode: 'malformed_api_spec' } }
  if (!specification) return { valid: false, failureCode: 'malformed_api_spec' }
  const openapi = typeof specification.openapi === 'string' ? specification.openapi : null
  const swagger = typeof specification.swagger === 'string' ? specification.swagger : null
  if (!(openapi && /^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(openapi)) && swagger !== '2.0') {
    return { valid: false, failureCode: 'unsupported_api_spec_version' }
  }
  const paths = record(specification.paths)
  if (!paths || Object.keys(paths).length === 0) return { valid: false, failureCode: 'api_spec_paths_missing' }
  const methods = Object.values(paths).flatMap(path => Object.keys(record(path) ?? {}))
    .map(method => method.toLowerCase()).filter(method => HTTP_METHODS.has(method))
  if (!methods.some(method => SUPPORTED_METHODS.has(method))) return { valid: false, failureCode: 'unsupported_http_method' }
  const authFailure = inspectSecuritySchemes(specification)
  if (authFailure) return { valid: false, failureCode: authFailure }
  const endpoint = inspectEndpoint(specification, openapi, swagger, safeBaseUrl)
  if (endpoint.failureCode) return { valid: false, failureCode: endpoint.failureCode }
  const info = record(specification.info)
  const description = durableExternalSummary(typeof info?.description === 'string' ? info.description : undefined, 360)
  const methodSummary = [...new Set(methods.filter(method => SUPPORTED_METHODS.has(method)).map(method => method.toUpperCase()))].sort().join(', ')
  return {
    valid: true, failureCode: null, endpointUrl: endpoint.endpointUrl,
    summary: durableExternalSummary(`Structured OpenAPI contract verified with ${Object.keys(paths).length} path(s) and supported methods ${methodSummary}.${description ? ` ${description}` : ''}`, 500),
  }
}

function providerOwnsUrl(url: string, normalizedDomain: string): boolean {
  try {
    const hostname = new URL(url).hostname
    return normalizeWorkerIdentity('domain', hostname) === normalizedDomain
      || hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
  } catch {
    return false
  }
}

function providerIdentityEstablished(body: string, candidate: RawCandidate, normalizedDomain: string): boolean {
  const text = body.slice(0, 64 * 1024).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLocaleLowerCase('und')
  const labels = [normalizedDomain, candidate.discoveredName, candidate.discoveredProduct]
    .flatMap(value => value?.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('und').match(/[\p{L}\p{N}.-]{3,}/gu) ?? [])
    .filter(value => !['api', 'apis', 'rest', 'http', 'https', 'www'].includes(value))
  return labels.some(label => text.includes(label))
}

export function sourceTrustRank(fact: ProvenanceFact): number {
  return fact.sourceRole === 'official_site' ? 1
    : fact.sourceRole === 'official_docs' ? 2
      : fact.sourceRole === 'official_pricing' || fact.sourceRole === 'official_contact' ? 3 : 6
}

export async function researchCandidate(input: {
  candidate: RawCandidate
  normalizedDomain: string
  deadlineMs?: number
  claimResearchBudget: (purpose: ResearchPurpose) => Promise<BudgetClaimResult>
  fetcher?: DiscoveryFetcher
  now?: () => string
}): Promise<ResearchResult> {
  const checkedAt = input.now?.() ?? new Date().toISOString()
  const sourceUrl = canonicalExternalUrl(input.candidate.sourceUrl)
  const facts: ProvenanceFact[] = sourceUrl ? [{
    sourceType: 'api_directory', sourceRole: 'directory_assertion', url: sourceUrl,
    title: sourceUrl.startsWith('https://api.apis.guru/') ? 'APIs.guru directory assertion' : 'Retained provider discovery assertion',
    factualSummary: durableExternalSummary(input.candidate.sourceSummary, 700), checkedAt,
  }] : []
  for (const [url, label] of [
    [input.candidate.discoveredPricingUrl, 'Directory asserted pricing URL.'],
    [input.candidate.discoveredContactUrl, 'Directory asserted contact URL.'],
  ] as const) {
    const canonical = canonicalExternalUrl(url)
    if (canonical) facts.push({
      sourceType: 'api_directory', sourceRole: 'directory_assertion', url: canonical,
      factualSummary: label, checkedAt,
    })
  }
  const contractUrl = canonicalExternalUrl(input.candidate.discoveredContractUrl)
  const docsUrl = canonicalExternalUrl(input.candidate.discoveredDocsUrl)
  if (!contractUrl && !docsUrl) return { facts, docsVerified: false, failureCode: 'structured_api_contract_missing', compatibilityFailure: null }
  if (!contractUrl && docsUrl && !providerOwnsUrl(docsUrl, input.normalizedDomain)) {
    facts.push({ sourceType: 'api_directory', sourceRole: 'directory_assertion', url: docsUrl,
      factualSummary: 'Directory asserted documentation URL; provider ownership was not verified.', checkedAt })
    return { facts, docsVerified: false, failureCode: 'official_linkage_unverified', compatibilityFailure: null }
  }
  const contractClaim = await input.claimResearchBudget('contract')
  if (contractClaim !== 'claimed') return { facts, docsVerified: false,
    failureCode: contractClaim === 'replayed' ? 'research_claim_replayed'
      : contractClaim === 'deadline_reached' ? 'run_budget_exhausted' : 'research_budget_exhausted', compatibilityFailure: null }
  try {
    const transport = input.fetcher ?? boundedDiscoveryFetch
    let requests = 0
    const fetcher: DiscoveryFetcher = async (url, options) => {
      let first = true
      const beforeRequest = async (redirect?: string) => {
        if (Date.now() >= (input.deadlineMs ?? Infinity)) throw new ResearchBudgetError('run_budget_exhausted')
        if (++requests > 12) throw new ResearchBudgetError('official_docs_unreachable')
        if (!first) {
          const key = createHash('sha256').update(redirect ?? url).digest('hex').slice(0, 32)
          const claim = await input.claimResearchBudget(`redirect:${key}`)
          if (claim !== 'claimed') throw new ResearchBudgetError(claim === 'replayed' ? 'research_claim_replayed'
            : claim === 'deadline_reached' ? 'run_budget_exhausted' : 'research_budget_exhausted')
        }
        first = false
      }
      await beforeRequest()
      let initial = true
      return transport(url, { ...options, timeoutMs: Math.max(1, Math.min(6000, (input.deadlineMs ?? Infinity) - Date.now())),
        beforeRequest: async redirect => {
          if (initial) { initial = false; return }
          await beforeRequest(redirect)
        } })
    }
    let structuredUrl = contractUrl ?? docsUrl
    if (!structuredUrl) throw new Error('structured_api_contract_missing')
    let response = await fetcher(structuredUrl, { maxBytes: 256 * 1024, accept: 'application/json,text/html;q=0.8' })
    let finalUrl = canonicalExternalUrl(response.url)
    if (!finalUrl) return { facts, docsVerified: false, failureCode: 'structured_api_contract_missing', compatibilityFailure: null }
    if (response.status < 200 || response.status >= 300) return { facts, docsVerified: false, failureCode: 'official_docs_unreachable', compatibilityFailure: null }
    let linkedOfficialPage: string | null = null
    if (!response.contentType.toLowerCase().includes('json')) {
      const queue: Array<{ url: string; kind: 'contract' | 'docs'; page: string; depth: number }> = []
      const visited = new Set([structuredUrl, finalUrl])
      let ownershipMissing = false
      let linksTruncated = false
      const append = (page: string, body: string, depth: number) => {
        if (!providerOwnsUrl(page, input.normalizedDomain)) return
        const links = officialContractLinks(body, page)
        linksTruncated ||= links.length >= 16
        for (const link of links) {
          if (link.kind === 'contract' && !providerOwnsUrl(link.url, input.normalizedDomain)
            && !providerIdentityEstablished(body, input.candidate, input.normalizedDomain)) { ownershipMissing = true; continue }
          if (link.kind === 'docs' && (depth >= 1 || !providerOwnsUrl(link.url, input.normalizedDomain))) continue
          if (!visited.has(link.url) && !queue.some(item => item.url === link.url) && queue.length < 16) queue.push({ ...link, page, depth })
        }
        queue.sort((a, b) => Number(a.kind === 'docs') - Number(b.kind === 'docs'))
      }
      if (response.contentType.toLowerCase().includes('html')) append(finalUrl, response.body, 0)
      if (docsUrl && !visited.has(docsUrl) && providerOwnsUrl(docsUrl, input.normalizedDomain)) {
        queue.push({ url: docsUrl, kind: 'docs', page: docsUrl, depth: 0 })
      }
      let temporary = false
      let invalid: string | null = null
      let resolved = false
      for (let index = 0; index < 4 && queue.length; index++) {
        const link = queue.shift()!
        visited.add(link.url)
        const claim = await input.claimResearchBudget(`link:${createHash('sha256').update(link.url).digest('hex').slice(0, 32)}`)
        if (claim !== 'claimed') throw new ResearchBudgetError(claim === 'replayed' ? 'research_claim_replayed'
          : claim === 'deadline_reached' ? 'run_budget_exhausted' : 'research_budget_exhausted')
        try {
          const allowed = (url: string) => Boolean(canonicalExternalUrl(url)) && !new URL(url).search && !new URL(url).hash && (providerOwnsUrl(url, input.normalizedDomain)
            || (link.kind === 'contract' && new URL(url).hostname === new URL(link.url).hostname))
          const next = await fetcher(link.url, { maxBytes: 256 * 1024, accept: 'application/json,text/html;q=0.8', validateUrl: allowed })
          const nextUrl = canonicalExternalUrl(next.url)
          if (!nextUrl || !allowed(nextUrl)) continue
          if (next.status < 200 || next.status >= 300) { temporary ||= ![404, 410].includes(next.status); continue }
          if (next.contentType.toLowerCase().includes('json')) {
            const owned = providerOwnsUrl(nextUrl, input.normalizedDomain)
            const inspection = inspectOpenApiDocument(next.body, owned ? nextUrl : undefined)
            if (!inspection.valid) { invalid = inspection.failureCode; continue }
            // A third-party specification host needs an explicit official link AND a provider-owned API endpoint.
            if (!owned && !(inspection.endpointUrl && providerOwnsUrl(inspection.endpointUrl, input.normalizedDomain))) {
              ownershipMissing = true; continue
            }
            response = next; finalUrl = nextUrl; structuredUrl = link.url
            linkedOfficialPage = link.page; resolved = true; break
          }
          if (/\b(?:yaml|yml)\b/i.test(next.contentType)) invalid = 'unsupported_api_spec_format'
          if (next.contentType.toLowerCase().includes('html')) append(nextUrl, next.body, link.depth + 1)
        } catch (error) {
          if (error instanceof ResearchBudgetError || error instanceof WorkerMailInfrastructureError) throw error
          temporary = true
        }
      }
      if (!resolved) return { facts, docsVerified: false,
        failureCode: temporary || queue.length || linksTruncated ? 'official_docs_unreachable'
          : ownershipMissing ? 'provider_ownership_unverified' : invalid ?? 'structured_api_contract_missing',
        compatibilityFailure: temporary || queue.length || linksTruncated || ownershipMissing ? null : invalid }
      facts.push({ sourceType: 'website', sourceRole: 'official_docs', url: linkedOfficialPage!,
        factualSummary: 'Provider-owned documentation explicitly links the verified structured API contract.', checkedAt })
    }
    const contractIsProviderOwned = providerOwnsUrl(finalUrl, input.normalizedDomain)
    const inspection = inspectOpenApiDocument(response.body, contractIsProviderOwned ? finalUrl : undefined)
    if (!inspection.valid) return { facts, docsVerified: false, failureCode: inspection.failureCode, compatibilityFailure: inspection.failureCode }
    const endpointIsProviderOwned = Boolean(inspection.endpointUrl && providerOwnsUrl(inspection.endpointUrl, input.normalizedDomain))
    facts.push(contractIsProviderOwned ? {
      sourceType: 'website', sourceRole: 'official_docs', url: finalUrl, namingEvidence: [],
      title: input.candidate.discoveredProduct?.slice(0, 200), factualSummary: inspection.summary, checkedAt,
    } : {
      sourceType: 'api_directory', sourceRole: 'directory_assertion', url: finalUrl,
      title: input.candidate.discoveredProduct?.slice(0, 200),
      factualSummary: durableExternalSummary(`Structured contract observed via directory; this is not official provider documentation. ${inspection.summary ?? ''}`, 1000), checkedAt,
    })
    let ownershipVerified = contractIsProviderOwned || linkedOfficialPage !== null
    if (!linkedOfficialPage && docsUrl && docsUrl !== structuredUrl && providerOwnsUrl(docsUrl, input.normalizedDomain)) {
      const ownershipDocsClaim = await input.claimResearchBudget('ownership_docs')
      if (ownershipDocsClaim !== 'claimed') {
        return { facts, docsVerified: false,
          failureCode: ownershipDocsClaim === 'replayed' ? 'research_claim_replayed'
            : ownershipDocsClaim === 'deadline_reached' ? 'run_budget_exhausted' : 'research_budget_exhausted', compatibilityFailure: null }
      }
      try {
        const docsResponse = await fetcher(docsUrl, { maxBytes: 256 * 1024, accept: 'text/html,application/json' })
        const officialUrl = canonicalExternalUrl(docsResponse.url)
        if (officialUrl && providerOwnsUrl(officialUrl, input.normalizedDomain) && docsResponse.status >= 200 && docsResponse.status < 300
          && providerIdentityEstablished(docsResponse.body, input.candidate, input.normalizedDomain)) {
          facts.push({ sourceType: 'website', sourceRole: 'official_docs', url: officialUrl,
            factualSummary: 'Provider-owned documentation linked from the directory contract.', ...officialNamingMetadata(officialUrl, docsResponse.body, input.normalizedDomain), checkedAt })
          ownershipVerified = true
        }
      } catch (error) { if (error instanceof ResearchBudgetError || error instanceof WorkerMailInfrastructureError) throw error /* Continue to the bounded provider-root fallback. */ }
    }
    if (!ownershipVerified && endpointIsProviderOwned) {
      const ownershipRootClaim = await input.claimResearchBudget('ownership_root')
      if (ownershipRootClaim !== 'claimed') {
        return { facts, docsVerified: false,
          failureCode: ownershipRootClaim === 'replayed' ? 'research_claim_replayed'
            : ownershipRootClaim === 'deadline_reached' ? 'run_budget_exhausted' : 'research_budget_exhausted', compatibilityFailure: null }
      }
      const rootUrl = `https://${input.normalizedDomain}/`
      try {
        const rootResponse = await fetcher(rootUrl, { maxBytes: 128 * 1024, accept: 'text/html,text/plain,application/json' })
        const finalRoot = canonicalExternalUrl(rootResponse.url)
        if (finalRoot && providerOwnsUrl(finalRoot, input.normalizedDomain)
          && rootResponse.status >= 200 && rootResponse.status < 300
          && providerIdentityEstablished(rootResponse.body, input.candidate, input.normalizedDomain)) {
          facts.push({ sourceType: 'website', sourceRole: 'official_site', url: finalRoot,
            factualSummary: 'Provider-owned site independently verified for this directory contract.', ...officialNamingMetadata(finalRoot, rootResponse.body, input.normalizedDomain), checkedAt })
          ownershipVerified = true
        }
      } catch (error) { if (error instanceof ResearchBudgetError || error instanceof WorkerMailInfrastructureError) throw error /* Ambiguous ownership remains non-terminal in the processor. */ }
    }
    if (!ownershipVerified) {
      return { facts, docsVerified: false, failureCode: 'provider_ownership_unverified', compatibilityFailure: null }
    }
    return { facts: facts.sort((a, b) => sourceTrustRank(a) - sourceTrustRank(b)), docsVerified: true, failureCode: null, compatibilityFailure: null }
  } catch (error) {
    if (error instanceof WorkerMailInfrastructureError) throw error
    return { facts, docsVerified: false, failureCode: error instanceof ResearchBudgetError ? error.message : 'official_docs_unreachable', compatibilityFailure: null }
  }
}
