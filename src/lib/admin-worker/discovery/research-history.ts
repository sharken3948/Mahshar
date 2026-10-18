import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeWorkerIdentity } from '../normalization'
import { getProviderHistory, WorkerMailInfrastructureError } from './provider-history'
import { canonicalExternalUrl } from './sanitize'
import type { RawCandidate } from './types'

export function researchIdentity(candidate: Pick<RawCandidate, 'discoveredContractUrl' | 'discoveredDocsUrl'>,
  domain: string, productKey: string): string {
  return createHash('sha256').update(JSON.stringify([
    domain, productKey, canonicalExternalUrl(candidate.discoveredContractUrl) ?? null,
    canonicalExternalUrl(candidate.discoveredDocsUrl) ?? null,
  ])).digest('hex')
}

/** Persist this order once per logical batch; Resume keeps its existing ordinals. */
export async function prioritizeDiscoveryProviders(providers: string[]): Promise<string[]> {
  const observed = new Set<string>()
  const domains = [...new Set(providers.map(domain => normalizeWorkerIdentity('domain', domain)))]
  for (let start = 0; start < domains.length; start += 300) {
    const slice = domains.slice(start, start + 300)
    for (const history of await getProviderHistory(slice)) observed.add(history.domain)
    for (let offset = 0; ; offset += 1000) {
      const result = await createServiceClient().from('worker_candidates')
        .select('normalized_domain').in('normalized_domain', slice)
        .order('id', { ascending: true }).range(offset, offset + 999)
      if (result.error || !Array.isArray(result.data)) throw new WorkerMailInfrastructureError('worker_research_history_unavailable')
      for (const row of result.data) if (typeof row.normalized_domain === 'string') observed.add(row.normalized_domain)
      if (result.data.length < 1000) break
    }
  }
  const seen = (provider: string) => observed.has(normalizeWorkerIdentity('domain', provider))
  return [...providers.filter(provider => !seen(provider)), ...providers.filter(seen)]
}

const TEMPORARY_FAILURES = new Set(['official_docs_unreachable', 'provider_ownership_unverified',
  'research_budget_exhausted', 'research_claim_replayed', 'run_budget_exhausted',
  'groq_budget_exhausted', 'groq_claim_replayed', 'groq_qualification_failed'])

/** Reuse retained attempt timestamps: cooldown observations never restart the clock. */
export async function researchRetryAfter(candidate: RawCandidate, domain: string, productKey: string): Promise<number | null> {
  const result = await createServiceClient().from('worker_candidates')
    .select('discovered_contract_url,discovered_docs_url,status,reason_code,updated_at,processing_attempt,source_updated_at')
    .eq('normalized_domain', domain).eq('normalized_product_key', productKey)
    .not('reason_code', 'eq', 'provider_retry_not_due')
    .order('updated_at', { ascending: false }).limit(100)
  if (result.error || !Array.isArray(result.data)) throw new WorkerMailInfrastructureError('worker_research_history_unavailable')
  const identity = researchIdentity(candidate, domain, productKey)
  const attempts = result.data.filter(row => ['filtered', 'deferred'].includes(row.status)
    && row.reason_code && !['provider_retry_not_due', 'provider_identity_processed'].includes(row.reason_code)
    && researchIdentity({ discoveredContractUrl: row.discovered_contract_url ?? undefined,
      discoveredDocsUrl: row.discovered_docs_url ?? undefined }, domain, productKey) === identity)
  if (!attempts.length) return null
  const last = attempts[0]
  if (candidate.directoryUpdatedAt && Date.parse(candidate.directoryUpdatedAt) > Date.parse(last.source_updated_at ?? last.updated_at)) return null
  const count = attempts.reduce((sum, row) => sum + Math.max(1, row.processing_attempt ?? 0), 0)
  // Match deferred recovery's existing 1/2/4-hour backoff; terminal observations
  // retain their existing 30-day horizon. Changed contracts can be researched immediately.
  const delay = TEMPORARY_FAILURES.has(last.reason_code)
    ? 60 * 60 * 1000 * 2 ** Math.min(2, count - 1) : 30 * 24 * 60 * 60 * 1000
  const checked = Date.parse(last.updated_at)
  if (!Number.isFinite(checked)) throw new WorkerMailInfrastructureError('worker_research_history_invalid')
  return checked + delay
}
