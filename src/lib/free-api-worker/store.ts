import type { DiscoveryProgress } from './sources'
import { canonical, type Candidate, type Lead, type Result } from './model'

export type State = {
  discovery?: DiscoveryProgress | null
  status: 'running' | 'stopped' | 'completed'; generation: string; discovery_done: boolean
  cooldowns: Record<string, string>; error: string | null; updated_at: string; inventory?: { sourceCount: number; canonicalCount: number; readyCount: number; sha256: string }
}
export type Claimed = Candidate & { token: string }
export type CandidatePreviewResult = Omit<Result, 'evidence' | 'tests'>
export type CandidatePreview = Omit<Candidate, 'result' | 'recheckResult'> & { result: CandidatePreviewResult | null }
export type CandidatePage = {
  summary: { admitted: number; functional: number; usable: number; permissions: Record<Result['permission'], number>; termsChecked: number; successPercent: number }
  progress: { total: number; completed: number; unfinished: number; active: number; batchSize: number }
  total: number; page: number; pageSize: number; candidates: CandidatePreview[]; nextRetry: string | null
}
export interface Store {
  state(): Promise<State>
  control(action: 'start' | 'stop' | 'resume'): Promise<State>
  admit(leads: Lead[]): Promise<void>
  discovered(generation: string, errors: string[]): Promise<void>
  claim(generation: string, limit?: number): Promise<Claimed[]>
  checkpoint?(row: Claimed, result: Result): Promise<void>
  release(row: Claimed): Promise<void>
  save(row: Claimed, result: Result): Promise<void>
  finish(generation: string, cooldowns: Record<string, string>, error?: string): Promise<State>
  discoveryState?(): Promise<{ progress: DiscoveryProgress | null; pending: Lead[] }>
  saveDiscovery?(generation: string, progress: DiscoveryProgress, pending: Lead[], leads: Lead[], source: string | null, expected: DiscoveryProgress | null): Promise<boolean>
  candidates(): Promise<Candidate[]>
  adminState?(includeDiscovery?: boolean): Promise<State>
  candidatePage?(input: { view: string; search: string; page: number; pageSize?: number }): Promise<CandidatePage>
  candidateDetails?(ids: string[]): Promise<Candidate[]>
}

type DB = ReturnType<typeof import('@/lib/supabase/server').createServiceClient>
type CandidateIndexRow = {
  id: string; lead: Lead; attempts: number; retry_at: string | null; removed_at: string | null; completed_at: string | null
  lease_until: string | null; listing_id: string | null; published_at: string | null; historical: string | null
  manual_failed_at: string | null; failure_reason: string | null; recheck_until: string | null
  technical: Result['technical'] | null; free_access: Result['freeAccess'] | null; permission: Result['permission'] | null
  terms_checked: string | boolean | null; endpoint: string | null; docs: string | null; last_success: string | null
  reason: string | null; result_retry_at: string | null
}
type CandidateEligibilityRow = { id: string; provider_id: string; name: string; duplicate_of: string | null
  historical: string | null; endpoint: string }

const CANDIDATE_PREVIEW_SELECT = 'id,lead,attempts,retry_at,removed_at,completed_at,lease_until,listing_id,published_at,manual_failed_at,failure_reason,recheck_until,historical:saved_inventory->original->lead->>id,technical:result->>technical,free_access:result->>freeAccess,permission:result->>permission,terms_checked:result->>termsChecked,endpoint:result->>endpoint,docs:result->>docs,last_success:result->>lastSuccess,reason:result->>reason,result_retry_at:result->>retryAt'
const CANDIDATE_ELIGIBILITY_SELECT = 'id,provider_id,name,duplicate_of:lead->>duplicateOf,historical:saved_inventory->original->lead->>id,endpoint:result->>endpoint'

function indexCandidate(row: CandidateIndexRow): Candidate {
  const result = row.technical && row.free_access && row.permission ? {
    technical: row.technical, freeAccess: row.free_access, permission: row.permission,
    termsChecked: row.terms_checked === true || row.terms_checked === 'true', endpoint: row.endpoint,
    docs: row.docs ?? row.lead.docs, lastSuccess: row.last_success, reason: row.reason ?? '',
    retryAt: row.result_retry_at, evidence: [], tests: [],
  } satisfies Result : null
  return { lead: row.lead, result, attempts: row.attempts, retryAt: row.retry_at,
    removedAt: row.removed_at, completedAt: row.completed_at, leaseUntil: row.lease_until,
    listingId: row.listing_id, publishedAt: row.published_at, historical: !!row.historical,
    manualFailedAt: row.manual_failed_at, failureReason: row.failure_reason, recheckUntil: row.recheck_until }
}

function preview(candidate: Candidate): CandidatePreview {
  const { recheckResult: _recheckResult, ...withoutRecheck } = candidate
  if (!candidate.result) return withoutRecheck as CandidatePreview
  const { evidence: _evidence, tests: _tests, ...result } = candidate.result
  return { ...withoutRecheck, result }
}

function quotedFilter(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
/** Only the two new Worker tables are addressable here. No listing writes. */
export class DatabaseStore implements Store {
  constructor(private db: DB) {}
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(name, args)
    if (error) throw new Error(['already_running', 'work_in_flight'].includes(error.message) ? error.message : 'worker_storage_unavailable')
    return data as T
  }
  async state(): Promise<State> {
    const { data, error } = await this.db.from('free_worker_state').select('*').eq('id', 1).single()
    if (error || !data) throw new Error('worker_storage_unavailable')
    const { discovery_pending: _pending, ...state } = data
    return state as State
  }
  async adminState(includeDiscovery = false): Promise<State> {
    const columns = `status,generation,discovery_done,cooldowns,error,updated_at,inventory${includeDiscovery ? ',discovery' : ''}`
    const { data, error } = await this.db.from('free_worker_state').select(columns).eq('id', 1).single()
    if (error || !data) throw new Error('worker_storage_unavailable')
    return data as unknown as State
  }
  control(action: 'start' | 'stop' | 'resume') { return this.rpc<State>('free_worker_control', { p_action: action }) }
  async admit(leads: Lead[]) {
    // Chunking is a database payload bound, never a discovery/request quota.
    for (let offset = 0; offset < leads.length; offset += 100) {
      await this.rpc('free_worker_admit', { p_leads: leads.slice(offset, offset + 100) })
    }
  }
  async discovered(generation: string, errors: string[]) {
    const { error } = await this.db.from('free_worker_state').update({ discovery_done: true,
      error: errors.length ? 'Some discovery sources unavailable; successful sources retained.' : null,
    }).eq('id', 1).eq('generation', generation).eq('status', 'running')
    if (error) throw new Error('worker_storage_unavailable')
  }
  async claim(generation: string, limit = 3): Promise<Claimed[]> {
    const rows = await this.rpc<Array<{ lead: Lead; result: Result | null; attempts: number; retry_at: string | null; token: string }>>('free_worker_claim', { p_generation: generation, p_limit: limit })
    return rows.map(row => ({ ...row, retryAt: row.retry_at }))
  }
  async checkpoint(row: Claimed, result: Result) {
    const saved = await this.rpc<boolean>('free_worker_checkpoint', { p_id: row.lead.id, p_token: row.token, p_result: result })
    if (!saved) throw new Error('worker_claim_expired')
  }
  async release(row: Claimed) { await this.rpc('free_worker_release', { p_id: row.lead.id, p_token: row.token }) }
  async importInventory(rows: unknown[], inventory: State['inventory']) {
    await this.rpc('free_worker_import', { p_rows: rows, p_inventory: inventory })
  }
  async remove(ids: string[], owner: string) {
    return this.rpc<number>('free_worker_remove', { p_ids: ids, p_owner: owner })
  }
  async save(row: Claimed, result: Result) {
    const saved = await this.rpc<boolean>('free_worker_save', { p_id: row.lead.id, p_token: row.token,
      p_result: { ...result, lastSuccess: result.lastSuccess ?? row.result?.lastSuccess ?? null } })
    if (!saved) throw new Error('worker_claim_expired')
  }
  finish(generation: string, cooldowns: Record<string, string>, error?: string) {
    return this.rpc<State>('free_worker_finish', { p_generation: generation, p_cooldowns: cooldowns, p_error: error ?? null })
  }
  async discoveryState() {
    const { data, error } = await this.db.from('free_worker_state').select('discovery,discovery_pending').eq('id', 1).single()
    if (error || !data) throw new Error('worker_storage_unavailable')
    return { progress: data.discovery as DiscoveryProgress | null, pending: data.discovery_pending as Lead[] }
  }
  saveDiscovery(generation: string, progress: DiscoveryProgress, pending: Lead[], leads: Lead[], source: string | null, expected: DiscoveryProgress | null) {
    return this.rpc<boolean>('free_worker_discovery_save', { p_generation: generation, p_progress: progress, p_pending: pending, p_leads: leads, p_source: source, p_expected: expected })
  }
  async candidates(): Promise<Candidate[]> {
    const rows: Candidate[] = []
    for (let offset = 0;; offset += 1000) {
      const { data, error } = await this.db.from('free_worker_apis').select('lead,result,attempts,retry_at,removed_at,completed_at,lease_until,listing_id,published_at,manual_failed_at,failure_reason,recheck_until,recheck_result,historical:saved_inventory->original->lead->>id').order('id').range(offset, offset + 999)
      if (error) throw new Error('worker_storage_unavailable')
      rows.push(...(data ?? []).map(row => ({ ...row, manualFailedAt: row.manual_failed_at, failureReason: row.failure_reason, recheckUntil: row.recheck_until, recheckResult: row.recheck_result, historical: !!row.historical, listingId: row.listing_id, publishedAt: row.published_at, retryAt: row.retry_at, removedAt: row.removed_at, completedAt: row.completed_at, leaseUntil: row.lease_until } as Candidate)))
      if (!data || data.length < 1000) return rows
    }
  }
  private async count(build: (query: any) => any = query => query): Promise<number> {
    const { count, error } = await build(this.db.from('free_worker_apis').select('id', { count: 'exact', head: true }))
    if (error || count == null) throw new Error('worker_storage_unavailable')
    return count
  }
  private async compactRows<T>(build: () => any): Promise<T[]> {
    const rows: T[] = []
    for (let offset = 0;; offset += 1000) {
      const { data, error } = await build().range(offset, offset + 999)
      if (error) throw new Error('worker_storage_unavailable')
      rows.push(...(data ?? []))
      if (!data || data.length < 1000) return rows
    }
  }
  private async candidateIndexes() {
    const readyQuery = () => this.db.from('free_worker_apis').select(CANDIDATE_ELIGIBILITY_SELECT)
      .is('removed_at', null).is('published_at', null).is('manual_failed_at', null).is('lead->>duplicateOf', null)
      .eq('result->>technical', 'PASSED').eq('result->>freeAccess', 'VERIFIED')
      .not('result->>endpoint', 'is', null).not('result->>lastSuccess', 'is', null)
      .eq('result->>termsChecked', 'true').in('result->>permission', ['ALLOWED', 'UNKNOWN', 'REVIEW_REQUIRED'])
      .contains('result->tests', [{ status: 200 }]).order('id')
    const excludedQuery = () => this.db.from('free_worker_apis')
      .select('id,endpoint:result->>endpoint')
      .or('result->>permission.eq.PROHIBITED,removed_at.not.is.null,published_at.not.is.null,manual_failed_at.not.is.null').order('id')
    const functionalQuery = () => this.db.from('free_worker_apis').select('id,endpoint:result->>endpoint')
      .eq('result->>technical', 'PASSED').order('id')
    const [ready, excluded, functional] = await Promise.all([
      this.compactRows<CandidateEligibilityRow>(readyQuery),
      this.compactRows<{ id: string; endpoint: string | null }>(excludedQuery),
      this.compactRows<{ id: string; endpoint: string | null }>(functionalQuery),
    ])
    const excludedKeys = new Set(excluded.map(row => row.endpoint ? canonical(row.endpoint) ?? row.id : row.id))
    const unique = new Map<string, CandidateEligibilityRow>()
    // PASSED is persisted only after Network.page supplies a response SHA-256. The containment
    // predicate verifies the successful test server-side, avoiding retransmission of test arrays.
    for (const row of ready.sort((a, b) => Number(!!b.historical) - Number(!!a.historical) || a.id.localeCompare(b.id))) {
      const key = row.endpoint ? canonical(row.endpoint) ?? row.id : row.id
      if (!row.duplicate_of && !excludedKeys.has(key) && !unique.has(key)) unique.set(key, row)
    }
    const readyCandidates = [...unique.values()].map(row => ({ id: row.id, name: row.name, providerId: row.provider_id }))
    const functionalKeys = new Set(functional.map(row => row.endpoint ? canonical(row.endpoint) ?? row.id : row.id))
    return { readyCandidates, functional: functionalKeys.size }
  }
  async candidatePage(input: { view: string; search: string; page: number; pageSize?: number }): Promise<CandidatePage> {
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 25, 100)), from = (input.page - 1) * pageSize, now = new Date().toISOString()
    const [admitted, completed, unfinished, active, allowed, reviewRequired, prohibited, termsChecked, indexes, retryResult] = await Promise.all([
      this.count(), this.count(query => query.not('completed_at', 'is', null)),
      this.count(query => query.is('completed_at', null).is('removed_at', null).is('manual_failed_at', null)),
      this.count(query => query.gt('lease_until', now)),
      this.count(query => query.eq('result->>permission', 'ALLOWED')),
      this.count(query => query.eq('result->>permission', 'REVIEW_REQUIRED')),
      this.count(query => query.eq('result->>permission', 'PROHIBITED')),
      this.count(query => query.eq('result->>termsChecked', 'true')),
      this.candidateIndexes(),
      this.db.from('free_worker_apis').select('retry_at').is('completed_at', null).is('removed_at', null)
        .is('manual_failed_at', null).not('retry_at', 'is', null).order('retry_at').limit(1),
    ])
    if (retryResult.error) throw new Error('worker_storage_unavailable')
    const usableCount = indexes.readyCandidates.length
    const summary = { admitted, functional: indexes.functional, usable: usableCount,
      permissions: { ALLOWED: allowed, UNKNOWN: Math.max(0, admitted - allowed - reviewRequired - prohibited), REVIEW_REQUIRED: reviewRequired, PROHIBITED: prohibited },
      termsChecked, successPercent: admitted ? 100 * usableCount / admitted : 0 }
    const progress = { total: admitted, completed, unfinished, active, batchSize: 50 }
    const needle = input.search.toLowerCase()
    if (input.view === 'usable') {
      const rows = indexes.readyCandidates.filter(row => `${row.name} ${row.providerId}`.toLowerCase().includes(needle))
      const pageIds = rows.slice(from, from + pageSize).map(row => row.id)
      let candidates: CandidatePreview[] = []
      if (pageIds.length) {
        const { data, error } = await this.db.from('free_worker_apis').select(CANDIDATE_PREVIEW_SELECT)
          .in('id', pageIds).order('id').range(0, pageSize - 1)
        if (error) throw new Error('worker_storage_unavailable')
        const byId = new Map((data ?? []).map(row => [String(row.id), preview(indexCandidate(row as unknown as CandidateIndexRow))]))
        candidates = pageIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
      }
      return { summary, progress, total: rows.length, page: input.page, pageSize, candidates,
        nextRetry: retryResult.data?.[0]?.retry_at ?? null }
    }
    let query = this.db.from('free_worker_apis').select(CANDIDATE_PREVIEW_SELECT, { count: 'exact' }).is('removed_at', null)
    if (input.view === 'failed') query = query.not('manual_failed_at', 'is', null)
    if (input.search) {
      const pattern = quotedFilter(`%${input.search}%`)
      query = query.or(`name.ilike.${pattern},provider_id.ilike.${pattern}`)
    }
    const { data, error, count } = await query.order('id').range(from, from + pageSize - 1)
    if (error || count == null) throw new Error('worker_storage_unavailable')
    return { summary, progress, total: count, page: input.page, pageSize,
      candidates: (data ?? []).map(row => preview(indexCandidate(row as unknown as CandidateIndexRow))),
      nextRetry: retryResult.data?.[0]?.retry_at ?? null }
  }
  async candidateDetails(ids: string[]): Promise<Candidate[]> {
    const boundedIds = ids.slice(0, 25)
    if (!boundedIds.length) return []
    const { data, error } = await this.db.from('free_worker_apis')
      .select('id,lead,result,attempts,retry_at,removed_at,completed_at,lease_until,listing_id,published_at,manual_failed_at,failure_reason,recheck_until,recheck_result,historical:saved_inventory->original->lead->>id')
      .in('id', boundedIds).order('id').limit(25)
    if (error) throw new Error('worker_storage_unavailable')
    return (data ?? []).map(row => ({ lead: row.lead, result: row.result, attempts: row.attempts,
      retryAt: row.retry_at, removedAt: row.removed_at, completedAt: row.completed_at, leaseUntil: row.lease_until,
      listingId: row.listing_id, publishedAt: row.published_at, manualFailedAt: row.manual_failed_at,
      failureReason: row.failure_reason, recheckUntil: row.recheck_until, recheckResult: row.recheck_result,
      historical: !!row.historical } as Candidate))
  }
}
