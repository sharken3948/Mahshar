import type { WorkerRunStatus, WorkerStatusDto } from './types'

export function workerControlAvailability(status: WorkerStatusDto | null) {
  const current: WorkerRunStatus | null = status?.latest_run?.status ?? null
  const active = current === 'queued' || current === 'running' || current === 'stop_requested'
  return {
    canStart: status !== null && !active,
    canStop: status !== null && (current === 'queued' || current === 'running'),
    canResume: status !== null && !active && status.can_resume
      && (current === 'stopped' || current === 'failed') && status.latest_run?.completion_reason === null,
  }
}
