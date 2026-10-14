import type { WorkerRunDto, WorkerRunStatus } from '../../src/lib/admin-worker/types'

export const canaryFixture = { events: [] as string[], claimStatus: 'running' as WorkerRunStatus,
  acquisitionFails: false, sleepCalls: 0, stopDuringSleep: false, running: true,
  failurePersistenceFails: false, finishArgs: [] as string[] }

export function resetCanaryFixture() {
  canaryFixture.events = []
  canaryFixture.claimStatus = 'running'
  canaryFixture.acquisitionFails = false
  canaryFixture.sleepCalls = 0
  canaryFixture.stopDuringSleep = false
  canaryFixture.running = true
  canaryFixture.failurePersistenceFails = false
  canaryFixture.finishArgs = []
}

function run(status: WorkerRunStatus): WorkerRunDto {
  return { id: 'run', run_number: 1, status, batch_size: 50, processed_count: 0,
    counts: { raw_scanned: 0, duplicate: 0, filtered: 0, deferred: 0, qualified: 0,
      review_candidates: 0, persisted: 0, traction_scored: 0 },
    targets: { qualified: 50, remaining: 50, raw_limit: 50 },
    resources: { source: 0, research: 0, groq_evaluated: 0, contact: 0 }, source_cursor: 0,
    source_exhausted: false, completion_reason: null, checkpoint: { version: 1, nextIndex: 0, batchSize: 50 },
    workflow_run_id: null, error_code: null, started_at: null, stopped_at: null, completed_at: null,
    created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z' }
}

export async function claimWorkerRunStep() { canaryFixture.events.push('claim'); return run(canaryFixture.claimStatus) }
export async function processAcquisitionStep(_runId: string, _epoch: string, canary = false) {
  canaryFixture.events.push(`acquire:${canary}`)
  if (canaryFixture.acquisitionFails) throw new Error('fixture failure')
  return []
}
export async function finishAcquisitionCanaryStep(runId: string, epoch: string) {
  canaryFixture.finishArgs = [runId, epoch]
  canaryFixture.events.push('stop-intent-and-run'); canaryFixture.claimStatus = 'stopped'
}
export async function completeWorkerRunStep() { canaryFixture.events.push('complete'); return run('stopped') }
export async function processDiscoveryChunkStep() { canaryFixture.events.push('discovery'); return run('completed') }
export async function failWorkerRunStep() {
  canaryFixture.events.push('fail-worker')
  if (canaryFixture.failurePersistenceFails) throw new Error('failure persistence unavailable')
}
export async function failAcquisitionStep() { canaryFixture.events.push('fail-acquisition') }
export async function acquisitionStillRunningStep() { canaryFixture.events.push('continuation-check'); return canaryFixture.running }
export async function createNextAcquisitionRunStep() { canaryFixture.events.push('next-batch'); return 'next' }
export async function sleep() {
  canaryFixture.sleepCalls++
  if (canaryFixture.stopDuringSleep) { canaryFixture.running = false; return }
  throw new Error('canary must not sleep')
}
