import type { WorkerRunDto, WorkerRunStatus } from '../../src/lib/admin-worker/types'

export const canaryFixture = { events: [] as string[], claimStatus: 'running' as WorkerRunStatus,
  acquisitionFails: false, running: true, stopBeforeContinuation: false,
  failurePersistenceFails: false, finishArgs: [] as string[],
  claimStatuses: [] as WorkerRunStatus[], nextRunIds: [] as (string | null)[],
  checkpointIndex: 0,
  checkpoints: [] as number[], discoveryHook: null as null | ((runId: string) => Promise<void>) }

export function resetCanaryFixture() {
  canaryFixture.events = []
  canaryFixture.claimStatus = 'running'
  canaryFixture.acquisitionFails = false
  canaryFixture.stopBeforeContinuation = false
  canaryFixture.running = true
  canaryFixture.failurePersistenceFails = false
  canaryFixture.finishArgs = []
  canaryFixture.claimStatuses = []
  canaryFixture.nextRunIds = []
  canaryFixture.checkpointIndex = 0
  canaryFixture.checkpoints = []
  canaryFixture.discoveryHook = null
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

export async function claimWorkerRunStep(id = 'run') {
  canaryFixture.events.push('claim')
  const result = run(canaryFixture.claimStatuses.shift() ?? canaryFixture.claimStatus)
  result.id = id; result.checkpoint.nextIndex = canaryFixture.checkpointIndex
  return result
}
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
export async function processDiscoveryChunkStep(_id: string, checkpoint: { nextIndex: number }) {
  canaryFixture.events.push('discovery'); canaryFixture.checkpoints.push(checkpoint.nextIndex)
  await canaryFixture.discoveryHook?.(_id)
  return run('completed')
}
export async function failWorkerRunStep() {
  canaryFixture.events.push('fail-worker')
  if (canaryFixture.failurePersistenceFails) throw new Error('failure persistence unavailable')
}
export async function failAcquisitionStep() { canaryFixture.events.push('fail-acquisition') }
export async function acquisitionStillRunningStep() {
  canaryFixture.events.push('continuation-check')
  if (canaryFixture.stopBeforeContinuation) canaryFixture.running = false
  return canaryFixture.running
}
export async function createNextAcquisitionRunStep() {
  canaryFixture.events.push('next-batch')
  return canaryFixture.nextRunIds.shift() ?? null
}
