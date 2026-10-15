import 'server-only'
import { AcquisitionBudgetPause } from './acquisition'
import { documentationFact, documentationLinks, hasDraftDocumentation, ownsDocumentationUrl, type DraftEvidenceContext } from './acquisition-evidence'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './discovery/fetch'
import { claimDiscoveryBudget, saveProvenance } from './discovery/repository'

/** At most three existing safe fetches, charged to the existing research budget. */
export async function ensureAcquisitionDocumentation(runId: string, providerId: string, leadId: string,
  context: DraftEvidenceContext, dependencies: {
    fetcher?: DiscoveryFetcher
    claim?: typeof claimDiscoveryBudget
    save?: typeof saveProvenance
    running: () => Promise<boolean>
  }): Promise<void> {
  if (hasDraftDocumentation(context) || !context.identityVerified || !context.contactVerified) return
  const queue = [...new Set([...context.docsUrls, ...context.facts.filter(fact =>
    ['official_docs', 'official_site'].includes(fact.sourceRole)).map(fact => fact.url)])]
    .filter(url => ownsDocumentationUrl(url, context.domain))
  const visited = new Set<string>()
  let documentation: ReturnType<typeof documentationFact> = null
  for (let index = 0; index < 3 && queue.length; index++) {
    const url = queue.shift()!
    if (visited.has(url)) { index--; continue }
    visited.add(url)
    if (!await dependencies.running()) throw new AcquisitionBudgetPause()
    const claim = await (dependencies.claim ?? claimDiscoveryBudget)(runId, 'research', `acq-docs:${runId}:${providerId}:${index}`)
    if (claim !== 'claimed') throw new AcquisitionBudgetPause()
    try {
      const response = await (dependencies.fetcher ?? boundedDiscoveryFetch)(url,
        { maxBytes: 128 * 1024, accept: 'text/html,application/json,text/plain' })
      if (response.status < 200 || response.status >= 300 || !ownsDocumentationUrl(response.url, context.domain)) continue
      documentation = documentationFact(response.url, response.body, context.domain, new Date().toISOString())
      if (documentation) break
      queue.unshift(...documentationLinks(response.body, response.url, context.domain).filter(link => !visited.has(link)))
    } catch (error) {
      if (error instanceof AcquisitionBudgetPause) throw error
      // A bounded failed lookup is recorded by the coordinator as missing docs.
    }
  }
  if (documentation) {
    if (!await dependencies.running()) throw new AcquisitionBudgetPause()
    await (dependencies.save ?? saveProvenance)(leadId, [documentation])
  }
}
