import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { isResumableCheckpoint, parseWorkerCheckpoint } from './checkpoint'
import { activeWorkerRunStatuses, WORKER_RECENT_RUNS_DEFAULT, WORKER_RECENT_RUNS_MAX, workerRunStatuses } from './constants'
import type {
  WorkerControlRecord,
  WorkerDesiredState,
  WorkerRunDto,
  WorkerRunsDto,
  WorkerRunStatus,
  WorkerStatusDto,
} from './types'
import type { WorkerStartMode } from './control'

type DbError = { message?: string; code?: string } | null
type DbResult = { data: unknown; error: DbError }

function dbFailure(scope: string, error: DbError): never {
  console.error(`[admin-worker] ${scope} unavailable`, error?.code ?? error?.message ?? 'unknown database error')
  throw new Error(error?.message || `${scope}_unavailable`)
}

function objectRow(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('worker_record_invalid')
  return parsed
}

function safeTimestamp(value: unknown, nullable = true): string | null {
  if (value === null && nullable) return null
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('worker_record_invalid')
  return value
}

function safeRunStatus(value: unknown): WorkerRunStatus {
  if (typeof value !== 'string' || !workerRunStatuses.includes(value as WorkerRunStatus)) throw new Error('worker_record_invalid')
  return value as WorkerRunStatus
}

function safeDesiredState(value: unknown): WorkerDesiredState {
  if (value !== 'stopped' && value !== 'running') throw new Error('worker_record_invalid')
  return value
}

function safeOptionalCode(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,80}$/.test(value)) throw new Error('worker_record_invalid')
  return value
}

function safeOptionalWorkflowId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('worker_record_invalid')
  return value
}

export function workerRunDto(value: unknown): WorkerRunDto {
  const row = objectRow(value)
  if (!row || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id)) throw new Error('worker_record_invalid')
  const batchSize = safeInteger(row.batch_size, 1, 100)
  const processedCount = safeInteger(row.processed_count, 0, batchSize)
  const checkpoint = parseWorkerCheckpoint(row.checkpoint)
  if (!checkpoint || checkpoint.batchSize !== batchSize || checkpoint.nextIndex !== processedCount) throw new Error('worker_record_invalid')
  return {
    id: row.id,
    run_number: safeInteger(row.run_number, 1),
    status: safeRunStatus(row.status),
    batch_size: batchSize,
    processed_count: processedCount,
    counts: {
      discovered: safeInteger(row.discovered_count, 0, processedCount),
      duplicate: safeInteger(row.duplicate_count, 0, processedCount),
      filtered: safeInteger(row.filtered_count, 0, processedCount),
      qualified: safeInteger(row.qualified_count, 0, processedCount),
      persisted: safeInteger(row.persisted_count, 0, processedCount),
    },
    checkpoint,
    workflow_run_id: safeOptionalWorkflowId(row.workflow_run_id),
    error_code: safeOptionalCode(row.error_code),
    started_at: safeTimestamp(row.started_at),
    stopped_at: safeTimestamp(row.stopped_at),
    completed_at: safeTimestamp(row.completed_at),
    created_at: safeTimestamp(row.created_at, false) as string,
    updated_at: safeTimestamp(row.updated_at, false) as string,
  }
}

function workerControlRecord(value: unknown): WorkerControlRecord {
  const row = objectRow(value)
  if (!row) throw new Error('worker_control_invalid')
  return {
    desired_state: safeDesiredState(row.desired_state),
    batch_size: safeInteger(row.batch_size, 1, 100),
    current_checkpoint: row.current_checkpoint,
    updated_at: safeTimestamp(row.updated_at, false) as string,
  }
}

async function rpc(name: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
  const result = await createServiceClient().rpc(name, parameters) as DbResult
  if (result.error) dbFailure(name, result.error)
  return result.data
}

export async function createWorkerRun(mode: WorkerStartMode): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_create_run', { p_resume: mode === 'resume' }))
}

export async function requestWorkerStop(): Promise<WorkerRunDto | null> {
  const value = await rpc('mahshar_worker_request_stop')
  const row = objectRow(value)
  return row?.id ? workerRunDto(row) : null
}

export async function attachWorkflowRunId(runId: string, workflowRunId: string): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_attach_workflow_run', {
    p_run_id: runId,
    p_workflow_run_id: workflowRunId,
  }))
}

export async function claimWorkerRun(runId: string): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_claim_run', { p_run_id: runId }))
}

export async function advanceWorkerRun(runId: string, expectedNextIndex: number, nextIndex: number): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_advance_run', {
    p_run_id: runId,
    p_expected_next_index: expectedNextIndex,
    p_next_index: nextIndex,
  }))
}

export async function completeWorkerRun(runId: string): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_complete_run', { p_run_id: runId }))
}

export async function failWorkerRun(runId: string, errorCode: string): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_fail_run', { p_run_id: runId, p_error_code: errorCode }))
}

export function parseWorkerRunsLimit(url: URL): number | null {
  const limit = Number(url.searchParams.get('limit') ?? WORKER_RECENT_RUNS_DEFAULT)
  return Number.isInteger(limit) && limit >= 1 && limit <= WORKER_RECENT_RUNS_MAX ? limit : null
}

export async function getWorkerRuns(limit = WORKER_RECENT_RUNS_DEFAULT): Promise<WorkerRunsDto> {
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKER_RECENT_RUNS_MAX) throw new Error('worker_limit_invalid')
  const result = await createServiceClient().from('worker_runs').select(
    'id, run_number, status, batch_size, processed_count, discovered_count, duplicate_count, filtered_count, qualified_count, persisted_count, checkpoint, workflow_run_id, error_code, started_at, stopped_at, completed_at, created_at, updated_at',
  ).order('created_at', { ascending: false }).limit(limit) as DbResult
  if (result.error) dbFailure('worker_runs', result.error)
  if (!Array.isArray(result.data)) throw new Error('worker_runs_invalid')
  return { runs: result.data.map(workerRunDto), limit, as_of: new Date().toISOString() }
}

export async function getWorkerStatus(): Promise<WorkerStatusDto> {
  const db = createServiceClient()
  const [controlResult, latestResult, completedResult] = await Promise.all([
    db.from('worker_control').select('desired_state, batch_size, current_checkpoint, updated_at').eq('id', 1).single(),
    db.from('worker_runs').select(
      'id, run_number, status, batch_size, processed_count, discovered_count, duplicate_count, filtered_count, qualified_count, persisted_count, checkpoint, workflow_run_id, error_code, started_at, stopped_at, completed_at, created_at, updated_at',
    ).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('worker_runs').select('completed_at').eq('status', 'completed')
      .order('completed_at', { ascending: false }).limit(1).maybeSingle(),
  ]) as [DbResult, DbResult, DbResult]
  if (controlResult.error) dbFailure('worker_control', controlResult.error)
  if (latestResult.error) dbFailure('worker_latest_run', latestResult.error)
  if (completedResult.error) dbFailure('worker_last_completed', completedResult.error)

  const control = workerControlRecord(controlResult.data)
  const latest = latestResult.data ? workerRunDto(latestResult.data) : null
  const active = latest && activeWorkerRunStatuses.has(latest.status as 'queued' | 'running' | 'stop_requested')
  const displayStatus = latest?.status === 'stop_requested' ? 'stop_requested'
    : active ? 'running'
      : latest?.status === 'failed' ? 'failed' : 'stopped'
  const completed = objectRow(completedResult.data)
  return {
    status: displayStatus,
    desired_state: control.desired_state,
    batch_size: control.batch_size,
    checkpoint: parseWorkerCheckpoint(control.current_checkpoint),
    can_resume: !active && isResumableCheckpoint(control.current_checkpoint, control.batch_size),
    last_completed_at: completed ? safeTimestamp(completed.completed_at) : null,
    latest_run: latest,
    as_of: new Date().toISOString(),
  }
}

export const workerControlRepository = {
  createRun: createWorkerRun,
  attachWorkflowRunId,
  failRun: failWorkerRun,
  requestStop: requestWorkerStop,
}
