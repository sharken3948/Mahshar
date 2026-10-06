import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { workerControlAvailability } from './availability'
import { startWorkerBatch, stopWorkerBatch, WorkerControlError, type WorkerControlRepository } from './control'
import type { WorkerCheckpoint, WorkerRunDto, WorkerRunStatus, WorkerStatusDto } from './types'

function run(status: WorkerRunStatus, checkpoint: WorkerCheckpoint, number: number): WorkerRunDto {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    run_number: number,
    status,
    batch_size: checkpoint.batchSize,
    processed_count: checkpoint.nextIndex,
    counts: { raw_scanned: checkpoint.nextIndex, duplicate: 0, filtered: 0, deferred: 0, qualified: 0,
      review_candidates: 0, persisted: 0, traction_scored: 0 },
    targets: { qualified: 50, remaining: 50, raw_limit: checkpoint.batchSize },
    resources: { source: 0, research: 0, groq_evaluated: 0, contact: 0 },
    source_cursor: checkpoint.nextIndex,
    source_exhausted: false,
    completion_reason: null,
    checkpoint,
    workflow_run_id: null,
    error_code: status === 'failed' ? 'synthetic_failure' : null,
    started_at: status === 'queued' ? null : '2026-10-01T00:00:00.000Z',
    stopped_at: status === 'stopped' ? '2026-10-01T00:01:00.000Z' : null,
    completed_at: status === 'completed' ? '2026-10-01T00:01:00.000Z' : null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  }
}

class FakeRepository implements WorkerControlRepository {
  active: WorkerRunDto | null = null
  checkpoint: WorkerCheckpoint | null = null
  history: WorkerRunDto[] = []
  failLaunch = false
  createError: string | null = null

  async createRun(mode: 'start' | 'resume') {
    if (this.createError) throw new Error(this.createError)
    if (this.active && ['queued', 'running', 'stop_requested'].includes(this.active.status)) throw new Error('worker_already_active')
    if (mode === 'resume' && (!this.checkpoint || this.checkpoint.nextIndex <= 0 || this.checkpoint.nextIndex >= this.checkpoint.batchSize)) {
      throw new Error('worker_not_resumable')
    }
    const checkpoint = mode === 'resume' ? this.checkpoint! : { version: 1 as const, nextIndex: 0, batchSize: 50 }
    this.active = run('queued', checkpoint, this.history.length + 1)
    this.history.push(this.active)
    return this.active
  }
  async attachWorkflowRunId(_runId: string, workflowRunId: string) {
    this.active = { ...this.active!, workflow_run_id: workflowRunId }
    this.history[this.history.length - 1] = this.active
    return this.active
  }
  async failRun(_runId: string, errorCode: string) {
    this.active = { ...this.active!, status: 'failed', error_code: errorCode }
    this.history[this.history.length - 1] = this.active
    return this.active
  }
  async requestStop() {
    if (!this.active || !['queued', 'running'].includes(this.active.status)) return null
    this.active = { ...this.active, status: 'stop_requested' }
    this.history[this.history.length - 1] = this.active
    return this.active
  }
}

let repository: FakeRepository
beforeEach(() => { repository = new FakeRepository() })

test('start creates one queued run and records the Workflow run id', async () => {
  const result = await startWorkerBatch('start', repository, async () => 'wrun_fixture')
  assert.equal(result.run?.status, 'queued')
  assert.equal(result.run?.processed_count, 0)
  assert.equal(result.workflow_run_id, 'wrun_fixture')
  assert.equal(repository.history.length, 1)
})

test('duplicate start is rejected before a second Workflow launch', async () => {
  let launches = 0
  await startWorkerBatch('start', repository, async () => `wrun_${++launches}`)
  await assert.rejects(() => startWorkerBatch('start', repository, async () => `wrun_${++launches}`),
    (error: unknown) => error instanceof WorkerControlError && error.code === 'worker_already_active')
  assert.equal(launches, 1)
  assert.equal(repository.history.length, 1)
})

test('stop requests cooperative stop on the active run', async () => {
  await startWorkerBatch('start', repository, async () => 'wrun_fixture')
  const result = await stopWorkerBatch(repository)
  assert.equal(result.run?.status, 'stop_requested')
})

test('resume creates a new run at the last safe nextIndex', async () => {
  repository.checkpoint = { version: 1, nextIndex: 20, batchSize: 50 }
  const result = await startWorkerBatch('resume', repository, async () => 'wrun_resumed')
  assert.equal(result.run?.processed_count, 20)
  assert.deepEqual(result.run?.checkpoint, repository.checkpoint)
  assert.equal(result.run?.run_number, 1)
})

test('resume without an interior checkpoint is rejected', async () => {
  await assert.rejects(() => startWorkerBatch('resume', repository, async () => 'never'),
    (error: unknown) => error instanceof WorkerControlError && error.code === 'worker_not_resumable')
})

test('forged checkpoint provenance is exposed only as not resumable', async () => {
  repository.createError = 'worker_checkpoint_provenance_invalid'
  await assert.rejects(() => startWorkerBatch('resume', repository, async () => 'never'),
    (error: unknown) => error instanceof WorkerControlError
      && error.code === 'worker_not_resumable' && error.status === 409)
})

test('completed runs are not active and do not block a new bounded run', async () => {
  repository.active = run('completed', { version: 1, nextIndex: 50, batchSize: 50 }, 1)
  repository.history.push(repository.active)
  const result = await startWorkerBatch('start', repository, async () => 'wrun_next')
  assert.equal(result.run?.run_number, 2)
  assert.equal(repository.history.length, 2)
})

test('launch failure is isolated and persisted as a bounded error code', async () => {
  await assert.rejects(() => startWorkerBatch('start', repository, async () => { throw new Error('synthetic launch failure') }),
    (error: unknown) => error instanceof WorkerControlError && error.code === 'workflow_start_failed')
  assert.equal(repository.active?.status, 'failed')
  assert.equal(repository.active?.error_code, 'workflow_start_failed')
})

test('UI availability follows the lifecycle and resumable checkpoint', () => {
  const status = (latest: WorkerRunDto | null, canResume: boolean): WorkerStatusDto => ({
    status: latest?.status === 'failed' ? 'failed' : latest?.status === 'stop_requested' ? 'stop_requested' : latest && ['queued', 'running'].includes(latest.status) ? 'running' : 'stopped',
    desired_state: latest && ['queued', 'running'].includes(latest.status) ? 'running' : 'stopped',
    batch_size: 50,
    qualified_target: 50,
    raw_candidate_limit: 300,
    checkpoint: latest?.checkpoint ?? null,
    can_resume: canResume,
    last_completed_at: null,
    latest_run: latest,
    as_of: '2026-10-01T00:00:00.000Z',
  })
  assert.deepEqual(workerControlAvailability(status(null, false)), { canStart: true, canStop: false, canResume: false })
  assert.deepEqual(workerControlAvailability(status(run('running', { version: 1, nextIndex: 10, batchSize: 50 }, 1), false)), { canStart: false, canStop: true, canResume: false })
  assert.deepEqual(workerControlAvailability(status(run('stopped', { version: 1, nextIndex: 20, batchSize: 50 }, 1), true)), { canStart: true, canStop: false, canResume: true })
  assert.deepEqual(workerControlAvailability(status(run('completed', { version: 1, nextIndex: 20, batchSize: 50 }, 1), true)), { canStart: true, canStop: false, canResume: false })
  const terminalStopped = run('stopped', { version: 1, nextIndex: 20, batchSize: 50 }, 1)
  terminalStopped.completion_reason = 'deadline_reached'
  assert.deepEqual(workerControlAvailability(status(terminalStopped, true)), { canStart: true, canStop: false, canResume: false })
})
