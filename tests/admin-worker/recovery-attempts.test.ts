import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processDiscoveryRange, type DiscoveryRangeDependencies } from '../../src/lib/admin-worker/discovery/processor'
import { beginDeferredCandidate, claimDeferredCandidates } from '../../src/lib/admin-worker/discovery/repository'
import { WorkerMailInfrastructureError } from '../../src/lib/admin-worker/discovery/provider-history'
import { boundary } from '../admin/fixture'
import type { CandidateOutcome, DurableCandidate } from '../../src/lib/admin-worker/discovery/types'

const outcome: CandidateOutcome = { status: 'deferred', reasonCode: 'official_docs_unreachable',
  discovered: 0, filtered: 0, duplicate: 0, deferred: 1, qualified: 0, persisted: 0, reviewCandidate: 0, tractionScored: 0 }
const retained = Array.from({ length: 5 }, (_, ordinal) => ({ id: `old-${ordinal}`, ordinal,
  discoveryBatchId: 'old', status: 'deferred', processingLeaseId: `lease-${ordinal}` } as DurableCandidate))
function fixture() {
  let running = true
  const authorized: string[] = [], processed: string[] = []
  const deps: Partial<DiscoveryRangeDependencies> = {
    recoverPendingEmails: async () => {},
    getDiscoveryRunContext: async () => ({ batchId: 'run', rootRunNumber: 1,
      deadlineAt: new Date(Date.now() + 600_000).toISOString(), qualifiedCount: 0, qualifiedTarget: 50 }),
    getDiscoveryCandidates: async () => [{ id: 'fresh', ordinal: 0, status: 'pending' } as DurableCandidate],
    claimPendingSourceCandidates: async () => [], claimMailRecoveryCandidates: async () => [],
    claimContactEnrichmentCandidates: async () => [], claimDeferredCandidates: async () => retained,
    beginDeferredCandidate: async (_run, c, deadline) => {
      if (!running || Date.now() >= deadline || authorized.includes(c.id)) return false
      authorized.push(c.id); return true
    },
    processDiscoveryCandidate: async (_run, c) => { processed.push(c.id); return outcome },
    acquisition: { running: async () => running, afterProvider: async () => {} },
  }
  return { deps, authorized, processed, stop: () => { running = false } }
}

test('near-deadline five leases charge only the candidate authorized to begin; untouched four survive', async () => {
  const original = Date.now; let now = original(); Date.now = () => now
  try {
    const f = fixture()
    f.deps.claimDeferredCandidates = async () => { now += 59_000; return retained }
    f.deps.processDiscoveryCandidate = async (_run, c) => {
      f.processed.push(c.id); if (c.id.startsWith('old')) now += 2_000; return outcome
    }
    const result = await processDiscoveryRange('run', 0, 1, f.deps)
    assert.deepEqual(f.authorized, ['old-0']); assert.deepEqual(f.processed, ['fresh', 'old-0'])
    assert.equal(result.nextIndex, 1); assert.equal(result.deadlineReached, false)
    assert.equal(retained.filter(c => !f.authorized.includes(c.id)).length, 4)
  } finally { Date.now = original }
})

test('a lease response arriving after deadline consumes no attempt and does not process candidates', async () => {
  const original = Date.now; let now = original(); Date.now = () => now
  try {
    const f = fixture(); f.deps.claimDeferredCandidates = async () => { now += 61_000; return retained }
    await processDiscoveryRange('run', 0, 1, f.deps)
    assert.deepEqual(f.authorized, []); assert.deepEqual(f.processed, ['fresh'])
  } finally { Date.now = original }
})

test('Stop after leasing and database authorization denial prevent processing without consuming retries', async () => {
  for (const stopped of [true, false]) {
    const f = fixture()
    if (stopped) f.deps.claimDeferredCandidates = async () => { f.stop(); return retained }
    else f.deps.beginDeferredCandidate = async () => false
    await processDiscoveryRange('run', 0, 1, f.deps)
    assert.deepEqual(f.authorized, []); assert.deepEqual(f.processed, ['fresh'])
  }
})

test('interruption after authorization cannot replay the same lease or prevent untouched work recovery', async () => {
  const f = fixture(); let interrupted = true
  f.deps.processDiscoveryCandidate = async (_run, c) => {
    if (c.id === 'old-0' && interrupted) { interrupted = false; throw new WorkerMailInfrastructureError('lost_response') }
    f.processed.push(c.id); return outcome
  }
  await assert.rejects(processDiscoveryRange('run', 0, 1, f.deps), /lost_response/)
  assert.deepEqual(f.authorized, ['old-0'])
  await processDiscoveryRange('run', 0, 1, f.deps)
  assert.equal(f.authorized.filter(id => id === 'old-0').length, 1)
  assert.ok(retained.slice(1).every(c => f.processed.includes(c.id)))
})

test('new lease/begin RPCs fail closed on missing schema; no old consuming RPC fallback', async () => {
  const calls: string[] = []
  boundary.rpcOverride = async name => {
    calls.push(name)
    return { data: null, error: { code: 'PGRST202', message: 'missing schema' } }
  }
  try {
    await assert.rejects(claimDeferredCandidates('run', 'run'), WorkerMailInfrastructureError)
    await assert.rejects(beginDeferredCandidate('run', retained[0], Date.now() + 1000), WorkerMailInfrastructureError)
    assert.deepEqual(calls, ['mahshar_worker_lease_deferred_candidates', 'mahshar_worker_begin_deferred_candidate'])
  } finally { boundary.rpcOverride = null }
})
