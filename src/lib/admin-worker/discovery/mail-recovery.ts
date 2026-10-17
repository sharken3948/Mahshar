import 'server-only'
import { documentationFact, ownsDocumentationUrl } from '../acquisition-evidence'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { claimDiscoveryBudget, saveProvenance } from './repository'
import type { DurableCandidate } from './types'

/** Refresh existing qualification's official proof; never rerun Groq or invent a check timestamp. */
export async function refreshMailIdentity(runId: string, candidate: DurableCandidate,
  running?: () => Promise<boolean>, dependencies: { fetcher?: DiscoveryFetcher; claim?: typeof claimDiscoveryBudget; save?: typeof saveProvenance } = {}): Promise<string | null> {
  if (!candidate.normalizedDomain || !candidate.leadId) return 'provider_identity_unverified'
  const domain = candidate.normalizedDomain
  const urls = [...new Set([candidate.discoveredDocsUrl, `https://${domain}/`])]
    .filter((url): url is string => !!url && ownsDocumentationUrl(url, domain))
  for (let index = 0; index < urls.length; index++) {
    if (running && !await running()) throw new Error('acquisition_stopped')
    const claimed = await (dependencies.claim ?? claimDiscoveryBudget)(runId, 'research', `mail-proof:${candidate.id}:${index}`)
    if (claimed !== 'claimed') return claimed === 'deadline_reached' ? 'run_budget_exhausted' : 'research_budget_exhausted'
    let fact: ReturnType<typeof documentationFact> = null
    try {
      const response = await (dependencies.fetcher ?? boundedDiscoveryFetch)(urls[index], { maxBytes: 128 * 1024,
        accept: 'text/html,application/json,text/plain', beforeRequest: async () => {
          if (running && !await running()) throw new Error('acquisition_stopped')
        } })
      if (response.status < 200 || response.status >= 300) continue
      fact = documentationFact(response.url, response.body, domain, new Date().toISOString())
    } catch (error) {
      if (error instanceof Error && error.message === 'acquisition_stopped') throw error
    }
    if (fact) { await (dependencies.save ?? saveProvenance)(candidate.leadId, [fact]); return null }
  }
  return 'official_docs_unreachable'
}
