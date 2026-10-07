import 'server-only'
import { normalizeWorkerIdentity } from '../normalization'
import {
  WORKER_CONTACT_PAGE_LIMIT,
  WORKER_CONTACT_SEARCH_RESULT_LIMIT,
  WORKER_CONTACT_SEARCH_VERIFICATION_LIMIT,
} from '../constants'
import { publicContactSearchAdapter, contactSearchQueries, type ContactSearchAdapter } from './contact-search'
import type { ContactClaimDescriptor } from './contact-claim-key'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { canonicalExternalUrl } from './sanitize'
import type { BudgetClaimResult, ContactEvidence, ContactResearchResult, ProvenanceFact, RawCandidate } from './types'

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
const NAVIGATION_ROUTE = /(contact|support|sales|business|partner|company|about|pricing|developer)/i
const CONTACT_ROUTE = /(contact|support|sales|business|partner)/i
const GITHUB_CONTACT_FILE = /(readme|support|security|contributing)/i
const GITHUB = /^github\.com$/i
const NON_OUTREACH = new Set(['security', 'privacy', 'legal'])

function hostname(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

function ownsDomain(url: string, domain: string): boolean {
  const host = hostname(url)
  return Boolean(host && (host === domain || host.endsWith(`.${domain}`) || normalizeWorkerIdentity('domain', host) === domain))
}

function identityMatches(body: string, candidate: RawCandidate, domain: string): boolean {
  const text = body.slice(0, 128 * 1024).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  const labels = [domain, candidate.discoveredName, candidate.discoveredProduct]
    .flatMap(value => value?.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}.-]{3,}/gu) ?? [])
    .filter(value => !['api', 'apis', 'rest', 'http', 'https', 'www'].includes(value))
  return labels.some(label => text.includes(label))
}

function purpose(value: string): ContactEvidence['purpose'] {
  const text = value.toLowerCase()
  if (/security/.test(text)) return 'security'
  if (/privacy/.test(text)) return 'privacy'
  if (/abuse|dmca|legal|compliance|copyright|report[-_ ]?(?:abuse|issue|violation)/.test(text)) return 'legal'
  if (/partner/.test(text)) return 'partnerships'
  if (/developer|devrel|api/.test(text)) return /api/.test(text) ? 'api' : 'developer'
  if (/business|bizdev/.test(text)) return 'business'
  if (/sales/.test(text)) return 'sales'
  if (/support|help/.test(text)) return 'support'
  return value.includes('@') ? 'general' : 'contact'
}

function preference(item: ContactEvidence): number {
  const rank: Record<ContactEvidence['purpose'], number> = {
    api: 0, developer: 0, business: 0, partnerships: 0, sales: 1, general: 2,
    support: 3, contact: 4, security: 9, privacy: 9, legal: 9,
  }
  return rank[item.purpose] + (item.type === 'email' ? 0 : 10)
}

function htmlLinks(body: string, base: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = []
  for (const match of body.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const url = raw.toLowerCase().startsWith('mailto:') ? raw : new URL(raw, base).toString()
      links.push({ url, label: (match[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() })
    } catch { /* Ignore malformed untrusted links. */ }
  }
  return links.slice(0, 100)
}

function verifiedEmail(raw: string, domain: string, officialGithub = false): string | null {
  const value = raw.replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase() ?? ''
  if (!EMAIL.test(value)) return null
  const host = value.split('@')[1] ?? ''
  return officialGithub || host === domain || host.endsWith(`.${domain}`) ? value : null
}

function selectedEvidence(found: ContactEvidence[]): { evidence: ContactEvidence[]; preferred: ContactEvidence | null; email: ContactEvidence | null } {
  const unique = [...new Map(found.map(item => [`${item.type}:${item.value}`, item])).values()]
  const outreach = unique.filter(item => !NON_OUTREACH.has(item.purpose))
    .sort((a, b) => preference(a) - preference(b) || a.value.localeCompare(b.value))
  if (outreach[0]) outreach[0].preferred = true
  return { evidence: unique.slice(0, 12), preferred: outreach[0] ?? null, email: outreach.find(item => item.type === 'email') ?? null }
}

function successfulResult(found: ContactEvidence[]): ContactResearchResult | null {
  const { evidence, preferred, email } = selectedEvidence(found)
  if (!preferred) return null
  return {
    status: email ? 'verified_email' : preferred.type === 'sales_channel' ? 'official_sales_channel' : 'official_contact_page',
    emailReady: Boolean(email), preferredEmail: email?.value ?? null,
    preferredContactUrl: preferred.type === 'email' ? preferred.sourceUrl : preferred.value,
    evidence, completed: true, failureCode: null,
  }
}

function retryable(failureCode: string, evidence: ContactEvidence[] = []): ContactResearchResult {
  return { status: 'unknown', emailReady: false, preferredEmail: null, preferredContactUrl: null,
    evidence: selectedEvidence(evidence).evidence, completed: false, failureCode }
}

export async function discoverProviderContacts(input: {
  candidate: RawCandidate
  normalizedDomain: string
  facts: ProvenanceFact[]
  claimContactBudget: (claim: ContactClaimDescriptor) => Promise<BudgetClaimResult>
  fetcher?: DiscoveryFetcher
  searchAdapter?: ContactSearchAdapter
  now?: () => string
}): Promise<ContactResearchResult> {
  const fetcher = input.fetcher ?? boundedDiscoveryFetch
  const searchAdapter = input.searchAdapter ?? publicContactSearchAdapter
  const now = input.now?.() ?? new Date().toISOString()
  const trustedHosts = new Set<string>([input.normalizedDomain])
  const establishedHosts = new Set<string>()
  for (const fact of input.facts) {
    if (fact.sourceType !== 'website' || !['official_site', 'official_docs', 'official_contact'].includes(fact.sourceRole)) continue
    const host = hostname(fact.url)
    if (host) { trustedHosts.add(host); establishedHosts.add(host) }
  }
  const trusted = (url: string) => {
    const host = hostname(url)
    return Boolean(host && ([...trustedHosts].some(domain => host === domain || host.endsWith(`.${domain}`))
      || ownsDomain(url, input.normalizedDomain)))
  }
  const sourceType = (url: string): ContactEvidence['sourceType'] => input.facts.some(fact =>
    fact.sourceRole === 'official_docs' && hostname(fact.url) === hostname(url)) ? 'official_docs' : 'official_site'
  const roots = new Set<string>([`https://${input.normalizedDomain}/`])
  for (const fact of input.facts) if (fact.sourceType === 'website' && trusted(fact.url)) roots.add(fact.url)
  const asserted = canonicalExternalUrl(input.candidate.discoveredContactUrl)
  if (asserted && trusted(asserted)) roots.add(asserted)

  const queue = [...roots].slice(0, WORKER_CONTACT_PAGE_LIMIT)
  const githubOwners = new Set<string>()
  const visited = new Set<string>()
  const found: ContactEvidence[] = []
  let successfulOfficialFetch = false
  let temporaryFailure = false
  let identityAmbiguity = false

  const collect = (body: string, finalUrl: string, kind: ContactEvidence['sourceType'], officialGithub: boolean,
    allowQueue: boolean): string[] => {
    const githubCandidates: string[] = []
    if (!officialGithub && (finalUrl === asserted || /(contact|support|sales|business|partner)/i.test(new URL(finalUrl).pathname))) {
      const contactPurpose = purpose(finalUrl)
      found.push({ type: contactPurpose === 'sales' ? 'sales_channel' : 'official_contact', value: finalUrl,
        purpose: contactPurpose, sourceUrl: finalUrl, sourceType: kind, verificationStatus: 'verified', preferred: false,
        emailReady: false, discoveredAt: now, verifiedAt: now })
    }
    for (const link of htmlLinks(body, finalUrl)) {
      if (link.url.toLowerCase().startsWith('mailto:')) {
        const email = verifiedEmail(link.url, input.normalizedDomain, officialGithub)
        if (email) found.push({ type: 'email', value: email, purpose: purpose(`${email} ${link.label}`), sourceUrl: finalUrl,
          sourceType: kind, verificationStatus: 'verified', preferred: false, emailReady: true, discoveredAt: now, verifiedAt: now })
        continue
      }
      const canonical = canonicalExternalUrl(link.url)
      if (!canonical) continue
      const host = hostname(canonical) ?? ''
      if (!officialGithub && GITHUB.test(host) && /github/i.test(link.label + canonical)) {
        const owner = new URL(canonical).pathname.split('/').filter(Boolean)[0]?.toLowerCase()
        if (owner) { githubOwners.add(owner); githubCandidates.push(canonical) }
      } else if (officialGithub && GITHUB.test(host) && GITHUB_CONTACT_FILE.test(`${link.label} ${canonical}`)) {
        githubCandidates.push(canonical)
      }
      if (!officialGithub && !GITHUB.test(host) && CONTACT_ROUTE.test(`${link.label} ${canonical}`)) {
        const contactPurpose = purpose(`${link.label} ${canonical}`)
        found.push({ type: contactPurpose === 'sales' ? 'sales_channel' : 'official_contact', value: canonical,
          purpose: contactPurpose, sourceUrl: finalUrl, sourceType: kind, verificationStatus: 'verified', preferred: false,
          emailReady: false, discoveredAt: now, verifiedAt: now })
      }
      if (!officialGithub && !GITHUB.test(host) && allowQueue && trusted(canonical)
        && NAVIGATION_ROUTE.test(`${link.label} ${canonical}`) && queue.length + visited.size < WORKER_CONTACT_PAGE_LIMIT) queue.push(canonical)
    }
    for (const raw of body.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
      const email = verifiedEmail(raw, input.normalizedDomain, officialGithub)
      if (email) found.push({ type: 'email', value: email, purpose: purpose(email), sourceUrl: finalUrl,
        sourceType: kind, verificationStatus: 'verified', preferred: false, emailReady: true, discoveredAt: now, verifiedAt: now })
    }
    return githubCandidates
  }

  while (queue.length && visited.size < WORKER_CONTACT_PAGE_LIMIT) {
    const url = queue.shift()!
    if (visited.has(url)) continue
    const claim = await input.claimContactBudget({ operation: 'page', value: url })
    if (claim === 'replayed') return retryable('contact_claim_replayed')
    if (claim === 'deadline_reached') return retryable('run_budget_exhausted')
    if (claim === 'exhausted') return retryable('contact_budget_exhausted')
    visited.add(url)
    try {
      const response = await fetcher(url, { maxBytes: 192 * 1024, accept: 'text/html,text/plain' })
      const finalUrl = canonicalExternalUrl(response.url)
      const finalHost = finalUrl ? hostname(finalUrl) : null
      const official = Boolean(finalUrl && trusted(finalUrl))
      const githubUrl = finalUrl && GITHUB.test(finalHost ?? '') ? new URL(finalUrl) : null
      const githubOwner = githubUrl?.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? null
      const linkedGithub = Boolean(githubOwner && githubOwners.has(githubOwner))
      if (!finalUrl || response.status < 200 || response.status >= 300 || (!official && !linkedGithub)) { temporaryFailure = true; continue }
      if (official && finalHost && !establishedHosts.has(finalHost)) {
        if (!identityMatches(response.body, input.candidate, input.normalizedDomain)) { identityAmbiguity = true; continue }
        establishedHosts.add(finalHost)
      }
      successfulOfficialFetch ||= official
      const candidates = collect(response.body, finalUrl, linkedGithub ? 'official_github' : sourceType(finalUrl), linkedGithub, true)
      for (const candidate of candidates) if (queue.length + visited.size < WORKER_CONTACT_PAGE_LIMIT) queue.push(candidate)
    } catch { temporaryFailure = true }
  }

  const direct = successfulResult(found)
  if (direct) return direct

  const verificationQueue: string[] = []
  const seenSearchResults = new Set<string>()
  let searchCompleted = true
  let verifiedResults = 0
  const verifySearchResults = async (): Promise<ContactResearchResult | null> => {
    while (verificationQueue.length && verifiedResults < WORKER_CONTACT_SEARCH_VERIFICATION_LIMIT) {
      const url = verificationQueue.shift()!
      const claim = await input.claimContactBudget({ operation: 'verify', value: url })
      if (claim === 'replayed') return retryable('contact_claim_replayed', found)
      if (claim === 'deadline_reached') return retryable('run_budget_exhausted', found)
      if (claim === 'exhausted') return retryable('contact_budget_exhausted', found)
      verifiedResults += 1
      try {
        const response = await fetcher(url, { maxBytes: 192 * 1024, accept: 'text/html,text/plain' })
        const finalUrl = canonicalExternalUrl(response.url)
        if (!finalUrl || response.status < 200 || response.status >= 300) { temporaryFailure = true; continue }
        const finalHost = hostname(finalUrl) ?? ''
        if (trusted(finalUrl)) {
          if (!establishedHosts.has(finalHost) && !identityMatches(response.body, input.candidate, input.normalizedDomain)) {
            identityAmbiguity = true
            continue
          }
          establishedHosts.add(finalHost)
          successfulOfficialFetch = true
          for (const candidate of collect(response.body, finalUrl, sourceType(finalUrl), false, false)) {
            if (verificationQueue.length + verifiedResults < WORKER_CONTACT_SEARCH_VERIFICATION_LIMIT) verificationQueue.push(candidate)
          }
          continue
        }
        if (!GITHUB.test(finalHost)) continue
        const githubOwner = new URL(finalUrl).pathname.split('/').filter(Boolean)[0]?.toLowerCase()
        const links = htmlLinks(response.body, finalUrl)
        const continuous = links.some(link => {
          if (link.url.toLowerCase().startsWith('mailto:')) return false
          const canonical = canonicalExternalUrl(link.url)
          return Boolean(canonical && trusted(canonical))
        }) || Boolean(githubOwner && githubOwners.has(githubOwner))
        if (!continuous || !githubOwner) continue
        githubOwners.add(githubOwner)
        for (const candidate of collect(response.body, finalUrl, 'official_github', true, false)) {
          const owner = new URL(candidate).pathname.split('/').filter(Boolean)[0]?.toLowerCase()
          if (owner === githubOwner && verificationQueue.length + verifiedResults < WORKER_CONTACT_SEARCH_VERIFICATION_LIMIT) {
            verificationQueue.push(candidate)
          }
        }
      } catch { temporaryFailure = true }
    }
    return successfulResult(found)
  }
  const queries = contactSearchQueries(input.candidate.discoveredName, input.normalizedDomain)
  for (let index = 0; index < queries.length; index += 1) {
    const claim = await input.claimContactBudget({ operation: 'search', value: queries[index]! })
    if (claim === 'replayed') return retryable('contact_claim_replayed', found)
    if (claim === 'deadline_reached') return retryable('run_budget_exhausted', found)
    if (claim === 'exhausted') return retryable('contact_budget_exhausted', found)
    try {
      for (const result of await searchAdapter.search(queries[index]!, WORKER_CONTACT_SEARCH_RESULT_LIMIT)) {
        const url = canonicalExternalUrl(result.url)
        if (!url || seenSearchResults.has(url)) continue
        seenSearchResults.add(url)
        const host = hostname(url) ?? ''
        if (trusted(url) || GITHUB.test(host)) verificationQueue.push(url)
      }
    } catch { temporaryFailure = true; searchCompleted = false; break }
    const verified = await verifySearchResults()
    if (verified) return verified
  }

  const searched = await verifySearchResults()
  if (searched) return searched
  const evidence = selectedEvidence(found).evidence
  if (!searchCompleted || temporaryFailure || identityAmbiguity || !successfulOfficialFetch) {
    return retryable(identityAmbiguity ? 'contact_identity_ambiguous' : 'contact_research_temporary_failure', evidence)
  }
  return { status: 'contact_unavailable', emailReady: false, preferredEmail: null, preferredContactUrl: null,
    evidence, completed: true, failureCode: null }
}
