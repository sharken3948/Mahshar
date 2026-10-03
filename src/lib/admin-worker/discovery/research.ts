import 'server-only'
import { normalizeWorkerIdentity } from '../normalization'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { canonicalExternalUrl, durableExternalSummary } from './sanitize'
import type { ProvenanceFact, RawCandidate } from './types'

export type ResearchResult = {
  facts: ProvenanceFact[]
  docsVerified: boolean
  failureCode: string | null
  compatibilityFailure: string | null
}

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

function inspectEndpoint(specification: Record<string, unknown>, openapi: string | null, swagger: string | null): { endpointUrl?: string; failureCode?: string } {
  if (openapi) {
    const servers = specification.servers
    if (!Array.isArray(servers) || servers.length === 0) return { failureCode: 'api_endpoint_missing' }
    const urls = servers.map(server => canonicalExternalUrl(typeof record(server)?.url === 'string' ? String(record(server)?.url) : undefined))
    if (urls.some(url => !url)) return { failureCode: 'unsafe_api_endpoint' }
    return { endpointUrl: urls[0] }
  }
  if (swagger === '2.0') {
    const host = typeof specification.host === 'string' ? specification.host.trim() : ''
    const schemes = Array.isArray(specification.schemes) ? specification.schemes : []
    if (!host || !/^[A-Za-z0-9.-]+(?::443)?$/.test(host)) return { failureCode: 'api_endpoint_missing' }
    if (!schemes.includes('https')) return { failureCode: 'unsafe_api_endpoint' }
    const basePath = typeof specification.basePath === 'string' ? specification.basePath : '/'
    if (!basePath.startsWith('/') || basePath.includes('\\') || basePath.split('/').includes('..')) return { failureCode: 'unsafe_api_endpoint' }
    const endpointUrl = canonicalExternalUrl(`https://${host}${basePath}`)
    return endpointUrl ? { endpointUrl } : { failureCode: 'unsafe_api_endpoint' }
  }
  return { failureCode: 'api_endpoint_missing' }
}

export function inspectOpenApiDocument(body: string): OpenApiInspection {
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
  const endpoint = inspectEndpoint(specification, openapi, swagger)
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
  claimResearchBudget: (purpose: 'contract' | 'ownership_docs' | 'ownership_root') => Promise<boolean>
  fetcher?: DiscoveryFetcher
  now?: () => string
}): Promise<ResearchResult> {
  const checkedAt = input.now?.() ?? new Date().toISOString()
  const sourceUrl = canonicalExternalUrl(input.candidate.sourceUrl)
  const facts: ProvenanceFact[] = sourceUrl ? [{
    sourceType: 'api_directory', sourceRole: 'directory_assertion', url: sourceUrl,
    title: 'APIs.guru directory assertion',
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
  if (!await input.claimResearchBudget('contract')) return { facts, docsVerified: false, failureCode: 'research_budget_exhausted', compatibilityFailure: null }
  try {
    const fetcher = input.fetcher ?? boundedDiscoveryFetch
    const structuredUrl = contractUrl ?? docsUrl
    if (!structuredUrl) throw new Error('structured_api_contract_missing')
    const response = await fetcher(structuredUrl, { maxBytes: 256 * 1024, accept: 'application/json' })
    const finalUrl = canonicalExternalUrl(response.url)
    if (!finalUrl) return { facts, docsVerified: false, failureCode: 'structured_api_contract_missing', compatibilityFailure: null }
    if (response.status < 200 || response.status >= 300) return { facts, docsVerified: false, failureCode: 'official_docs_unreachable', compatibilityFailure: null }
    const type = response.contentType.toLowerCase()
    if (!type.includes('json')) {
      facts.push({ sourceType: 'api_directory', sourceRole: 'directory_assertion', url: finalUrl, factualSummary: 'Directory-linked page reached; no structured API contract was verified.', checkedAt })
      return { facts, docsVerified: false, failureCode: 'structured_api_contract_missing', compatibilityFailure: null }
    }
    const inspection = inspectOpenApiDocument(response.body)
    if (!inspection.valid) return { facts, docsVerified: false, failureCode: inspection.failureCode, compatibilityFailure: inspection.failureCode }
    const contractIsProviderOwned = providerOwnsUrl(finalUrl, input.normalizedDomain)
    const endpointIsProviderOwned = Boolean(inspection.endpointUrl && providerOwnsUrl(inspection.endpointUrl, input.normalizedDomain))
    facts.push(contractIsProviderOwned ? {
      sourceType: 'website', sourceRole: 'official_docs', url: finalUrl,
      title: input.candidate.discoveredProduct?.slice(0, 200), factualSummary: inspection.summary, checkedAt,
    } : {
      sourceType: 'api_directory', sourceRole: 'directory_assertion', url: finalUrl,
      title: input.candidate.discoveredProduct?.slice(0, 200),
      factualSummary: durableExternalSummary(`Structured contract observed via directory; this is not official provider documentation. ${inspection.summary ?? ''}`, 1000), checkedAt,
    })
    let ownershipVerified = contractIsProviderOwned
    if (docsUrl && docsUrl !== structuredUrl && providerOwnsUrl(docsUrl, input.normalizedDomain)) {
      if (!await input.claimResearchBudget('ownership_docs')) {
        return { facts, docsVerified: false, failureCode: 'research_budget_exhausted', compatibilityFailure: null }
      }
      const docsResponse = await fetcher(docsUrl, { maxBytes: 256 * 1024, accept: 'text/html,application/json' })
      const officialUrl = canonicalExternalUrl(docsResponse.url)
      if (officialUrl && providerOwnsUrl(officialUrl, input.normalizedDomain) && docsResponse.status >= 200 && docsResponse.status < 300
        && providerIdentityEstablished(docsResponse.body, input.candidate, input.normalizedDomain)) {
        facts.push({ sourceType: 'website', sourceRole: 'official_docs', url: officialUrl,
          factualSummary: 'Provider-owned documentation linked from the directory contract.', checkedAt })
        ownershipVerified = true
      }
    }
    if (!ownershipVerified && endpointIsProviderOwned) {
      if (!await input.claimResearchBudget('ownership_root')) {
        return { facts, docsVerified: false, failureCode: 'research_budget_exhausted', compatibilityFailure: null }
      }
      const rootUrl = `https://${input.normalizedDomain}/`
      const rootResponse = await fetcher(rootUrl, { maxBytes: 128 * 1024, accept: 'text/html,text/plain,application/json' })
      const finalRoot = canonicalExternalUrl(rootResponse.url)
      if (finalRoot && providerOwnsUrl(finalRoot, input.normalizedDomain)
        && rootResponse.status >= 200 && rootResponse.status < 300
        && providerIdentityEstablished(rootResponse.body, input.candidate, input.normalizedDomain)) {
        facts.push({ sourceType: 'website', sourceRole: 'official_site', url: finalRoot,
          factualSummary: 'Provider-owned site independently verified for this directory contract.', checkedAt })
        ownershipVerified = true
      }
    }
    if (!ownershipVerified) {
      return { facts, docsVerified: false, failureCode: 'provider_ownership_unverified', compatibilityFailure: null }
    }
    return { facts: facts.sort((a, b) => sourceTrustRank(a) - sourceTrustRank(b)), docsVerified: true, failureCode: null, compatibilityFailure: null }
  } catch {
    return { facts, docsVerified: false, failureCode: 'official_docs_unreachable', compatibilityFailure: null }
  }
}
