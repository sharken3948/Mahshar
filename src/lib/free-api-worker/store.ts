import type { DiscoveryProgress } from './sources'
import type { Candidate, Lead, Result } from './model'

export type State = {
  discovery?: DiscoveryProgress | null
  status: 'running' | 'stopped' | 'completed'; generation: string; discovery_done: boolean
  cooldowns: Record<string, string>; error: string | null; updated_at: string; inventory?: { sourceCount: number; canonicalCount: number; readyCount: number; sha256: string }
}
export type Claimed = Candidate & { token: string }
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
}

type DB = ReturnType<typeof import('@/lib/supabase/server').createServiceClient>
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
      const { data, error } = await this.db.from('free_worker_apis').select('lead,result,attempts,retry_at,removed_at,completed_at,lease_until,listing_id,published_at,historical:saved_inventory->original->lead->>id').order('id').range(offset, offset + 999)
      if (error) throw new Error('worker_storage_unavailable')
      rows.push(...(data ?? []).map(row => ({ ...row, historical: !!row.historical, listingId: row.listing_id, publishedAt: row.published_at, retryAt: row.retry_at, removedAt: row.removed_at, completedAt: row.completed_at, leaseUntil: row.lease_until } as Candidate)))
      if (!data || data.length < 1000) return rows
    }
  }
}
