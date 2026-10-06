export const WORKER_CONTROL_ID = 1 as const
export const WORKER_DEFAULT_BATCH_SIZE = 50
export const WORKER_QUALIFIED_TARGET = 50
export const WORKER_RAW_CANDIDATE_LIMIT = 300
export const WORKER_MAX_BATCH_SIZE = WORKER_RAW_CANDIDATE_LIMIT
export const WORKER_CHUNK_SIZE = 10
export const WORKER_RECENT_RUNS_DEFAULT = 10
export const WORKER_RECENT_RUNS_MAX = 20
export const WORKER_SOURCE_QUERY_LIMIT = 301
export const WORKER_RESEARCH_FETCH_LIMIT = 240
export const WORKER_GROQ_CALL_LIMIT = 100
export const WORKER_TRACTION_FETCH_LIMIT = 60
export const WORKER_CONTACT_FETCH_LIMIT = 120
export const WORKER_CONTACT_PAGE_LIMIT = 6
export const WORKER_CONTACT_SEARCH_QUERY_LIMIT = 6
export const WORKER_CONTACT_SEARCH_RESULT_LIMIT = 3
export const WORKER_CONTACT_SEARCH_VERIFICATION_LIMIT = 4
export const WORKER_EXTERNAL_TIMEOUT_MS = 6_000
export const WORKER_EXTERNAL_RESPONSE_LIMIT = 512 * 1024
export const WORKER_TOTAL_RUN_BUDGET_MS = 15 * 60 * 1000
export const WORKER_REVIEW_THRESHOLD = 60
export const WORKER_FIT_THRESHOLD = 70
export const WORKER_QUALIFIED_LEADS_DEFAULT = 25
export const WORKER_QUALIFIED_LEADS_MAX = 50

export const workerRunStatuses = [
  'queued', 'running', 'stop_requested', 'stopped', 'completed', 'failed',
] as const

export const activeWorkerRunStatuses = new Set(['queued', 'running', 'stop_requested'] as const)
