import { canonicalExternalUrl, durableExternalSummary } from './discovery/sanitize'
import type { ProvenanceFact } from './discovery/types'
import { inspectOpenApiDocument } from './discovery/research'

export type DraftEvidenceContext = {
  key: string
  domain: string
  allowed: boolean
  identityVerified: boolean
  contactVerified: boolean
  facts: ProvenanceFact[]
  docsUrls: string[]
}

export function ownsDocumentationUrl(value: string, domain: string): boolean {
  try {
    const url = new URL(value)
    return Boolean(canonicalExternalUrl(value)) && url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch { return false }
}

export function hasDraftDocumentation(context: DraftEvidenceContext): boolean {
  return context.identityVerified && context.contactVerified && context.facts.some(fact =>
    fact.sourceType === 'website' && fact.sourceRole === 'official_docs'
    && ownsDocumentationUrl(fact.url, context.domain) && Boolean(fact.factualSummary?.trim()))
}

// Preserve source roles in the prompt: a directory contract supports grounding,
// but never substitutes for independently observed provider documentation.
export function invitationEvidence(context: DraftEvidenceContext): string[] {
  if (!hasDraftDocumentation(context)) return []
  return context.facts.filter(fact => (fact.sourceRole === 'official_docs' && fact.sourceType === 'website'
    && ownsDocumentationUrl(fact.url, context.domain))
    || (fact.sourceRole === 'directory_assertion' && fact.sourceType === 'api_directory'
      && fact.factualSummary?.includes('Structured OpenAPI contract verified')))
    .sort((a, b) => Number(b.sourceRole === 'official_docs') - Number(a.sourceRole === 'official_docs'))
    .slice(0, 4).map(fact => JSON.stringify({ role: fact.sourceRole, url: fact.url,
      summary: durableExternalSummary(fact.factualSummary, 700) }))
}

export function documentationFact(url: string, body: string, domain: string, checkedAt: string): ProvenanceFact | null {
  if (!ownsDocumentationUrl(url, domain)) return null
  if (body.trimStart().startsWith('{')) {
    const contract = inspectOpenApiDocument(body, url)
    if (contract.valid && contract.endpointUrl && ownsDocumentationUrl(contract.endpointUrl, domain)) return {
      sourceType: 'website', sourceRole: 'official_docs', url, factualSummary: contract.summary, checkedAt,
    }
    return null
  }
  const text = body.slice(0, 128 * 1024).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const methods = [...new Set(text.match(/\b(?:GET|POST|PUT|DELETE|PATCH)\b/g) ?? [])]
  const officialEndpoint = [...text.matchAll(/https:\/\/[^\s<>"']+\/[^\s<>"']+/gi)]
    .map(match => match[0]).find(value => ownsDocumentationUrl(value, domain))
  const relativeEndpoint = /(?:^|[\s"'(])(\/(?:api|v[0-9]+|rest)\/[a-z0-9_/{?.-]+)/i.exec(text)?.[1]
  const endpoint = officialEndpoint || relativeEndpoint
  if (!/\bAPI\b|OpenAPI|Swagger/i.test(text) || !methods.length || !endpoint) return null
  return { sourceType: 'website', sourceRole: 'official_docs', url,
    factualSummary: durableExternalSummary(`Provider-owned API documentation observed with HTTP methods ${methods.join(', ')}. Request example: ${canonicalExternalUrl(new URL(endpoint, url).href) ?? 'documented relative endpoint'}.`, 700), checkedAt }
}

export function documentationLinks(body: string, base: string, domain: string): string[] {
  const links: string[] = []
  for (const match of body.slice(0, 128 * 1024).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(match[1] ?? match[2] ?? match[3], base); url.hash = ''
      if (ownsDocumentationUrl(url.href, domain) && /docs?|documentation|developers?|api reference/i.test(`${url.hostname} ${url.pathname} ${match[4]}`)) links.push(url.href)
    } catch { /* Ignore malformed external navigation. */ }
  }
  return [...new Set(links)].slice(0, 4)
}
