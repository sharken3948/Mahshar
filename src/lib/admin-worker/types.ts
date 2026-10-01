import type { workerRunStatuses } from './constants'

export type WorkerDesiredState = 'stopped' | 'running'
export type WorkerRunStatus = (typeof workerRunStatuses)[number]
export type WorkerDisplayStatus = 'stopped' | 'running' | 'stop_requested' | 'failed'

export type WorkerCheckpoint = {
  version: 1
  nextIndex: number
  batchSize: number
}

export type WorkerRunRecord = {
  id: string
  run_number: number
  status: WorkerRunStatus
  batch_size: number
  processed_count: number
  discovered_count: number
  duplicate_count: number
  filtered_count: number
  qualified_count: number
  persisted_count: number
  checkpoint: unknown
  workflow_run_id: string | null
  error_code: string | null
  started_at: string | null
  stopped_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type WorkerControlRecord = {
  desired_state: WorkerDesiredState
  batch_size: number
  current_checkpoint: unknown
  updated_at: string
}

export type WorkerRunDto = {
  id: string
  run_number: number
  status: WorkerRunStatus
  batch_size: number
  processed_count: number
  counts: {
    discovered: number
    duplicate: number
    filtered: number
    qualified: number
    persisted: number
  }
  checkpoint: WorkerCheckpoint
  workflow_run_id: string | null
  error_code: string | null
  started_at: string | null
  stopped_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type WorkerStatusDto = {
  status: WorkerDisplayStatus
  desired_state: WorkerDesiredState
  batch_size: number
  checkpoint: WorkerCheckpoint | null
  can_resume: boolean
  last_completed_at: string | null
  latest_run: WorkerRunDto | null
  as_of: string
}

export type WorkerRunsDto = {
  runs: WorkerRunDto[]
  limit: number
  as_of: string
}

export type WorkerCommandDto = {
  run: WorkerRunDto | null
  workflow_run_id: string | null
}

