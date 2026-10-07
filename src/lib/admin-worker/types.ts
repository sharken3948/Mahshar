import type { workerRunStatuses } from './constants'

export type WorkerDesiredState = 'stopped' | 'running'
export type WorkerRunStatus = (typeof workerRunStatuses)[number]
export type WorkerDisplayStatus = 'stopped' | 'running' | 'stop_requested' | 'failed'
export type WorkerCompletionReason = 'qualified_target_reached' | 'source_exhausted' | 'hard_limit_reached' | 'deadline_reached'

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
  qualified_target: number
  raw_candidate_limit: number
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
    raw_scanned: number
    duplicate: number
    filtered: number
    deferred: number
    qualified: number
    review_candidates: number
    persisted: number
    traction_scored: number
  }
  targets: { qualified: number; remaining: number; raw_limit: number }
  resources: { source: number; research: number; groq_evaluated: number; contact: number }
  source_cursor: number
  source_exhausted: boolean
  completion_reason: WorkerCompletionReason | null
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
  qualified_target: number
  raw_candidate_limit: number
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

export type WorkerQualifiedLeadDto = {
  id: string
  provider: string
  provider_domain: string
  product: string
  fit_score: number
  summary: string
  reason_codes: string[]
  qualification_band: 'qualified' | 'review_candidate'
  traction_score: number | null
  traction_level: 'low' | 'medium' | 'high' | null
  traction_confidence: 'low' | 'medium' | 'high' | 'unknown'
  traction_signals: string[]
  traction_concerns: string[]
  traction_summary: string | null
  last_activity_at: string | null
  contactability: 'verified_official_contact' | 'official_contact_page' | 'official_sales_channel' | 'none_found' | 'unknown'
    | 'verified_email' | 'contact_unavailable'
  actionable: boolean
  email_ready: boolean
  preferred_email: string | null
  preferred_contact_url: string | null
  official_contact_url: string | null
  contact_evidence: Array<{ type: 'email' | 'official_contact' | 'sales_channel'; value: string; source_url: string; purpose: string;
    source_type: 'official_site' | 'official_docs' | 'official_github'; preferred: boolean }>
  official_site: string | null
  docs_url: string | null
  github_url: string | null
  pricing_url: string | null
  pricing_available: boolean
  contact_available: boolean
  directory_sources: string[]
  status: 'qualified' | 'technical_qualified' | 'review_candidate' | 'reviewed' | 'contact_ready' | 'contacted' | 'replied' | 'interested' | 'listed'
  last_evidence_at: string | null
  discovered_at: string
}

export type WorkerQualifiedLeadsDto = {
  leads: WorkerQualifiedLeadDto[]
  counts: {
    technical_qualified: number
    technical_review_candidates: number
    actionable_qualified: number
    actionable_review_candidates: number
    email_ready: number
    contact_form_only: number
    contact_unavailable: number
    contact_unknown: number
  }
  limit: number
  as_of: string
}
