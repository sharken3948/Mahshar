import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { MAIL_UUID } from '../mail-list-types'
import { normalizeWorkerIdentity } from '../normalization'

/** Infrastructure failures must escape source/candidate catches without consuming work. */
export class WorkerMailInfrastructureError extends Error {
  readonly recoverable = true
  constructor(message = 'worker_mail_infrastructure_unavailable') { super(message); this.name = 'WorkerMailInfrastructureError' }
}

export type ProviderHistory = { domain: string; providerId: string | null; reason: string }

export async function getProviderHistory(domains: string[]): Promise<ProviderHistory[]> {
  const normalized = [...new Set(domains.map(domain => normalizeWorkerIdentity('domain', domain)))]
  if (!normalized.length) return []
  const result = await createServiceClient().rpc('mahshar_worker_mail_discovery_state', { p_domains: normalized })
  if (result.error || !Array.isArray(result.data) || result.data.length !== normalized.length) {
    throw new WorkerMailInfrastructureError('worker_provider_history_unavailable')
  }
  const reasons = new Set(['legacy_outreach_history','manual_mail_pending','manual_mail_history',
    'provider_history_finalized','provider_already_processed','provider_retry_not_due','legacy_intake_retained'])
  const seen = new Set<string>()
  return result.data.flatMap((row: Record<string, unknown>) => {
    if (typeof row.domain !== 'string' || !normalized.includes(row.domain) || seen.has(row.domain)
      || (row.provider_id !== null && (typeof row.provider_id !== 'string' || !MAIL_UUID.test(row.provider_id)))
      || (row.reason !== null && (typeof row.reason !== 'string' || !reasons.has(row.reason)))) {
      throw new WorkerMailInfrastructureError('worker_provider_history_invalid')
    }
    seen.add(row.domain)
    if (row.reason === null) return []
    return [{ domain: row.domain, providerId: row.provider_id as string | null, reason: row.reason as string }]
  })
}
