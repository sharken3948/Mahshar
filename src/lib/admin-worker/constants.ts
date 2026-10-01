export const WORKER_CONTROL_ID = 1 as const
export const WORKER_DEFAULT_BATCH_SIZE = 50
export const WORKER_MAX_BATCH_SIZE = 100
export const WORKER_CHUNK_SIZE = 10
export const WORKER_RECENT_RUNS_DEFAULT = 10
export const WORKER_RECENT_RUNS_MAX = 20

export const workerRunStatuses = [
  'queued', 'running', 'stop_requested', 'stopped', 'completed', 'failed',
] as const

export const activeWorkerRunStatuses = new Set(['queued', 'running', 'stop_requested'] as const)

