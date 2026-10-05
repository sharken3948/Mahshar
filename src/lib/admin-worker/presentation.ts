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
