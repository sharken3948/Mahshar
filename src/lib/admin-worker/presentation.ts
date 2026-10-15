import type { WorkerRunDto } from './types'

export function workerCompletionLabel(run: Pick<WorkerRunDto, 'status' | 'completion_reason'>): string {
  if (run.completion_reason) return run.completion_reason.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())
  if (run.status === 'completed') return 'Completed'
  if (run.status === 'stopped') return 'Stopped'
  if (run.status === 'failed') return 'Failed'
  return 'In progress'
}

export function verificationLabel(verified: boolean): 'Verified' | 'Not verified' {
  return verified ? 'Verified' : 'Not verified'
}

export function workerCommandErrorMessage(code: unknown): string {
  if (code === 'worker_already_active') return 'A Worker batch is already active.'
  if (code === 'worker_not_resumable') return 'No safe resumable checkpoint is available.'
  if (code === 'worker_daily_limit') {
    return 'The daily Worker run limit has been reached. Try Start or Resume after 00:00 UTC. No new Worker run was started.'
  }
  return 'The Worker command could not be completed.'
}
