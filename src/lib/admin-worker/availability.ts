import type { WorkerRunStatus, WorkerStatusDto } from './types'

export function workerControlAvailability(status: WorkerStatusDto | null) {
  const current: WorkerRunStatus | null = status?.latest_run?.status ?? null
  const active = current === 'queued' || current === 'running' || current === 'stop_requested'
  const acquisitionRunning = status?.acquisition?.running === true
  const canaryUsed = status?.acquisition?.canary_mode === true && status?.acquisition?.canary_used === true
  const canaryRequired = status?.acquisition?.canary_required === true
  return {
    canStart: status !== null && !active && !acquisitionRunning && !canaryUsed && !canaryRequired,
    canStop: status !== null && (acquisitionRunning || current === 'queued' || current === 'running'),
    canResume: status !== null && !active && !acquisitionRunning && !canaryUsed && !canaryRequired && status.can_resume
      && ((current === 'stopped' || current === 'failed') && status.latest_run?.completion_reason === null
        || status.acquisition?.continuous_mode === true && current === 'completed'),
  }
}
