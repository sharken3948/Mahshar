import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { WorkerMailInfrastructureError } from './provider-history'
import { discoveryCandidateRecord } from './repository'
import { DISCOVERY_SOURCE_IDS, PUBLIC_API_LISTS_URL, type DiscoverySourceId, type DiscoverySourceState, type SourceSnapshot } from './sources/adapter'
import type { RawCandidate } from './types'

export type SourceObservation = { kind: 'candidate'; ordinal: number; candidate: RawCandidate | null; reasonCode?: string }
export function sourceObservation(value: unknown, ordinal: number): SourceObservation {
  const result = value as SourceObservation | null
  const candidate = result?.candidate
  if (!result || result.kind !== 'candidate' || result.ordinal !== ordinal
    || (candidate !== null && (!candidate || typeof candidate !== 'object' || candidate.sourceType !== 'api_directory'
      || typeof candidate.discoveredName !== 'string' || typeof candidate.discoveredDomain !== 'string'
      || typeof candidate.discoveredProduct !== 'string' || typeof candidate.sourceUrl !== 'string'))) {
    throw new WorkerMailInfrastructureError('worker_discovery_observation_invalid')
  }
  return result
}

export type DiscoverySourceStore = {
  read(sourceId: DiscoverySourceId): Promise<DiscoverySourceState>
  update(state: DiscoverySourceState, snapshot: SourceSnapshot): Promise<DiscoverySourceState | null>
  observe(state: DiscoverySourceState, result: SourceObservation): Promise<SourceObservation | null>
  running(): Promise<boolean>
  request(key: string): Promise<boolean>
}

export function sourceState(value: unknown): DiscoverySourceState {
  const item = value as DiscoverySourceState | null
  const state = item?.snapshot
  if (!item || !DISCOVERY_SOURCE_IDS.includes(item.sourceId) || !Number.isSafeInteger(item.version) || item.version < 0
    || !state || !Array.isArray(state.entries) || state.entries.length > 2000
    || !Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > state.entries.length
    || !Number.isInteger(state.failures) || state.failures < 0 || state.failures > 16
    || ![state.fetchedAt, state.refreshAfter, state.retryAfter].every(date => date === null || (typeof date === 'string' && Number.isFinite(Date.parse(date))))
    || !(state.revision === null || /^[a-f0-9]{64}$/.test(state.revision))
    || !state.entries.every(entry => entry && typeof entry.id === 'string' && entry.id.length <= 253
      && typeof entry.domain === 'string' && entry.domain.length <= 253)) {
    throw new WorkerMailInfrastructureError('worker_discovery_source_invalid')
  }
  return item
}

/** All writes are fenced by the existing run. Database faults are never source failures. */
export function discoverySourceStore(runId: string): DiscoverySourceStore {
  const db = createServiceClient()
  return {
    async read(sourceId) {
      const result = await db.from('worker_discovery_sources').select('source_id,version,snapshot').eq('source_id', sourceId).single()
      if (result.error || !result.data) throw new WorkerMailInfrastructureError('worker_discovery_sources_unavailable')
      return sourceState({ sourceId: result.data.source_id, version: result.data.version, snapshot: result.data.snapshot })
    },
    async update(state, snapshot) {
      const result = await db.rpc('mahshar_worker_discovery_source_update', {
        p_run_id: runId, p_source_id: state.sourceId, p_version: state.version, p_snapshot: snapshot,
      })
      if (result.error) throw new WorkerMailInfrastructureError('worker_discovery_source_update_unavailable')
      return result.data === null ? null : sourceState(result.data)
    },
    async observe(state, result) {
      const entry = state.snapshot.entries[state.snapshot.cursor]
      const record = discoveryCandidateRecord(runId, result.ordinal, result.candidate, result.reasonCode)
      const saved = await db.rpc('mahshar_worker_discovery_source_observe', {
        p_run_id: runId, p_source_id: state.sourceId, p_version: state.version,
        p_result: result, p_record: { ...record, discovered_domain: entry.domain,
          ...(!result.candidate ? { discovered_name: entry.domain,
            source_url: state.sourceId === 'public_api_lists' ? PUBLIC_API_LISTS_URL : 'https://api.apis.guru/v2/providers.json' } : {}),
          source_id: state.sourceId, source_record_id: entry.id, source_revision: state.snapshot.revision },
      })
      if (saved.error) throw new WorkerMailInfrastructureError('worker_discovery_observation_unavailable')
      return saved.data === null ? null : sourceObservation(saved.data, result.ordinal)
    },
    async running() {
      const result = await db.from('worker_runs').select('status,deadline_at').eq('id', runId).single()
      if (result.error || !result.data) throw new WorkerMailInfrastructureError('worker_discovery_run_unavailable')
      return result.data.status === 'running' && Date.parse(result.data.deadline_at) > Date.now()
    },
    async request(key) {
      const result = await db.rpc('mahshar_worker_claim_budget_v2', { p_run_id: runId, p_budget: 'source',
        p_claim_key: `attempt:${createHash('sha256').update(key).digest('hex').slice(0, 32)}:${randomUUID()}` })
      if (result.error || !['claimed', 'replayed', 'exhausted', 'deadline_reached'].includes(String(result.data))) {
        throw new WorkerMailInfrastructureError('worker_discovery_budget_unavailable')
      }
      // A lost claim response consumes its allowance conservatively. A retry needs a new claim.
      return result.data === 'claimed'
    },
  }
}
