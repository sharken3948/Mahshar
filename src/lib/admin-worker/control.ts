import type { WorkerCommandDto, WorkerRunDto } from './types'

export type WorkerStartMode = 'start' | 'resume'

export type WorkerControlRepository = {
  createRun(mode: WorkerStartMode): Promise<WorkerRunDto>
  attachWorkflowRunId(runId: string, workflowRunId: string): Promise<WorkerRunDto>
  failRun(runId: string, errorCode: string): Promise<WorkerRunDto>
  requestStop(): Promise<WorkerRunDto | null>
}

export type WorkerWorkflowLauncher = (runId: string) => Promise<string>

export class WorkerControlError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code)
    this.name = 'WorkerControlError'
  }
}

function boundedControlError(error: unknown): WorkerControlError {
  if (error instanceof WorkerControlError) return error
  const message = error instanceof Error ? error.message : ''
  if (message.includes('worker_already_active')) return new WorkerControlError('worker_already_active', 409)
  if (message.includes('worker_not_resumable') || message.includes('worker_checkpoint_invalid')
    || message.includes('worker_checkpoint_provenance_invalid')) {
    return new WorkerControlError('worker_not_resumable', 409)
  }
  return new WorkerControlError('worker_control_unavailable', 503)
}

export async function startWorkerBatch(
  mode: WorkerStartMode,
  repository: WorkerControlRepository,
  launchWorkflow: WorkerWorkflowLauncher,
): Promise<WorkerCommandDto> {
  let run: WorkerRunDto
  try {
    run = await repository.createRun(mode)
  } catch (error) {
    throw boundedControlError(error)
  }

  let workflowRunId: string
  try {
    workflowRunId = await launchWorkflow(run.id)
  } catch (error) {
    try { await repository.failRun(run.id, 'workflow_start_failed') }
    catch (markError) { console.error('[admin-worker] failed to persist launch failure', markError) }
    console.error('[admin-worker] workflow launch failed', error)
    throw new WorkerControlError('workflow_start_failed', 503)
  }

  try {
    run = await repository.attachWorkflowRunId(run.id, workflowRunId)
  } catch (error) {
    // The Workflow has already started with the durable Mahshar run ID. A link
    // write failure is observable but must not create or launch a second run.
    console.error('[admin-worker] workflow run id link unavailable', error)
  }
  return { run, workflow_run_id: workflowRunId }
}

export async function stopWorkerBatch(repository: WorkerControlRepository): Promise<WorkerCommandDto> {
  try {
    return { run: await repository.requestStop(), workflow_run_id: null }
  } catch (error) {
    throw boundedControlError(error)
  }
}
