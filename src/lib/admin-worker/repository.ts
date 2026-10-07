import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { canonicalExternalUrl } from './discovery/sanitize'
import { isOperationalWorkerLead } from './contact-readiness'
import { isResumableWorkerRun, parseWorkerCheckpoint } from './checkpoint'
import {
  activeWorkerRunStatuses, WORKER_QUALIFIED_LEADS_DEFAULT, WORKER_QUALIFIED_LEADS_MAX,
  WORKER_RECENT_RUNS_DEFAULT, WORKER_RECENT_RUNS_MAX, workerRunStatuses,
} from './constants'
import type {
  WorkerControlRecord,
  WorkerCompletionReason,
  WorkerDesiredState,
  WorkerRunDto,
  WorkerRunsDto,
  WorkerRunStatus,
  WorkerStatusDto,
  WorkerQualifiedLeadDto,
  WorkerQualifiedLeadsDto,
} from './types'
import type { WorkerStartMode } from './control'

type DbError = { message?: string; code?: string } | null
type DbResult = { data: unknown; error: DbError }
const RUN_SELECT = 'id, run_number, status, batch_size, processed_count, discovered_count, duplicate_count, filtered_count, deferred_count, qualified_count, review_candidate_count, persisted_count, traction_scored_count, checkpoint, workflow_run_id, error_code, qualified_target, raw_candidate_limit, source_cursor, source_exhausted, completion_reason, source_query_count, research_fetch_count, groq_call_count, traction_fetch_count, contact_fetch_count, started_at, stopped_at, completed_at, created_at, updated_at'

function dbFailure(scope: string, error: DbError): never {
  console.error(`[admin-worker] ${scope} unavailable`, error?.code ?? error?.message ?? 'unknown database error')
  throw new Error(error?.message || `${scope}_unavailable`)
}

function objectRow(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null
}

const provenanceRoleOrder = new Map([
  ['official_site', 0], ['official_docs', 1], ['official_pricing', 2], ['official_contact', 3], ['directory_assertion', 4],
])

export function sortQualifiedLeadRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const band = (row: Record<string, unknown>) => row.qualification_status === 'review_candidate' ? 1 : 0
  const confidence = new Map([['high', 0], ['medium', 1], ['low', 2], ['unknown', 3]])
  const contact = new Map([['verified_email', 0], ['verified_official_contact', 1], ['official_sales_channel', 2], ['official_contact_page', 3], ['contact_unavailable', 4], ['none_found', 5], ['unknown', 6]])
  const score = (value: unknown) => typeof value === 'number' ? value : -1
  return [...rows].sort((left, right) => band(left) - band(right)
    || score(right.fit_score) - score(left.fit_score)
    || score(right.traction_score) - score(left.traction_score)
    || (confidence.get(String(left.traction_confidence)) ?? 9) - (confidence.get(String(right.traction_confidence)) ?? 9)
    || (contact.get(String(left.contactability_status)) ?? 9) - (contact.get(String(right.contactability_status)) ?? 9)
    || String(right.created_at).localeCompare(String(left.created_at))
    || String(right.id).localeCompare(String(left.id)))
}

export function sortQualifiedLeadSources(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => (provenanceRoleOrder.get(String(left.source_role)) ?? 99)
    - (provenanceRoleOrder.get(String(right.source_role)) ?? 99)
    || String(right.created_at).localeCompare(String(left.created_at))
    || String(right.id).localeCompare(String(left.id))
    || String(left.url).localeCompare(String(right.url)))
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

function safeCompletionReason(value: unknown): WorkerCompletionReason | null {
  if (value === null) return null
  if (!['qualified_target_reached', 'source_exhausted', 'hard_limit_reached', 'deadline_reached'].includes(String(value))) {
    throw new Error('worker_record_invalid')
  }
  return value as WorkerCompletionReason
}

export function workerRunDto(value: unknown): WorkerRunDto {
  const row = objectRow(value)
  if (!row || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id)) throw new Error('worker_record_invalid')
  const batchSize = safeInteger(row.batch_size, 1, 300)
  const rawLimit = row.raw_candidate_limit === null
    ? batchSize : safeInteger(row.raw_candidate_limit, 1, 300)
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
      raw_scanned: safeInteger(row.discovered_count),
      duplicate: safeInteger(row.duplicate_count),
      filtered: safeInteger(row.filtered_count),
      deferred: safeInteger(row.deferred_count),
      qualified: safeInteger(row.qualified_count),
      review_candidates: safeInteger(row.review_candidate_count),
      persisted: safeInteger(row.persisted_count),
      traction_scored: safeInteger(row.traction_scored_count),
    },
    targets: { qualified: safeInteger(row.qualified_target, 1, 50),
      remaining: Math.max(0, safeInteger(row.qualified_target, 1, 50) - safeInteger(row.qualified_count)), raw_limit: rawLimit },
    resources: { source: safeInteger(row.source_query_count, 0, 301), research: safeInteger(row.research_fetch_count, 0, 240),
      groq_evaluated: safeInteger(row.groq_call_count, 0, 100), contact: safeInteger(row.contact_fetch_count ?? 0, 0, 120) },
    source_cursor: row.source_cursor === null ? processedCount : safeInteger(row.source_cursor, 0, rawLimit),
    source_exhausted: row.source_exhausted === true,
    completion_reason: safeCompletionReason(row.completion_reason),
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
    batch_size: safeInteger(row.batch_size, 1, 100), qualified_target: safeInteger(row.qualified_target, 50, 50),
    raw_candidate_limit: safeInteger(row.raw_candidate_limit, 300, 300),
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
  return workerRunDto(await rpc('mahshar_worker_create_target_run', { p_resume: mode === 'resume' }))
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

export type WorkerDiscoveryCounters = {
  discovered: number
  duplicate: number
  filtered: number
  qualified: number
  persisted: number
  reviewCandidate: number
  deferred: number
  tractionScored: number
}

export async function advanceWorkerDiscoveryRun(
  runId: string,
  expectedNextIndex: number,
  nextIndex: number,
  counters: WorkerDiscoveryCounters,
  completion: { sourceExhausted: boolean; deadlineReached: boolean; hardLimitReached: boolean },
): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_advance_target_run', {
    p_run_id: runId,
    p_expected_next_index: expectedNextIndex,
    p_next_index: nextIndex,
    p_discovered: counters.discovered,
    p_duplicate: counters.duplicate,
    p_filtered: counters.filtered,
    p_qualified: 0,
    p_persisted: counters.persisted,
    p_review: counters.reviewCandidate, p_deferred: counters.deferred, p_traction_scored: counters.tractionScored,
    p_source_exhausted: completion.sourceExhausted, p_deadline_reached: completion.deadlineReached,
    p_hard_limit_reached: completion.hardLimitReached,
  }))
}

export async function completeWorkerRun(runId: string): Promise<WorkerRunDto> {
  return workerRunDto(await rpc('mahshar_worker_complete_target_run', { p_run_id: runId }))
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
  const result = await createServiceClient().from('worker_runs').select(RUN_SELECT)
    .order('created_at', { ascending: false }).limit(limit) as DbResult
  if (result.error) dbFailure('worker_runs', result.error)
  if (!Array.isArray(result.data)) throw new Error('worker_runs_invalid')
  return { runs: result.data.map(workerRunDto), limit, as_of: new Date().toISOString() }
}

export async function getWorkerStatus(): Promise<WorkerStatusDto> {
  const db = createServiceClient()
  const [controlResult, latestResult, completedResult] = await Promise.all([
    db.from('worker_control').select('desired_state, batch_size, qualified_target, raw_candidate_limit, current_checkpoint, updated_at').eq('id', 1).single(),
    db.from('worker_runs').select(RUN_SELECT).order('created_at', { ascending: false }).limit(1).maybeSingle(),
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
    qualified_target: control.qualified_target, raw_candidate_limit: control.raw_candidate_limit,
    checkpoint: parseWorkerCheckpoint(control.current_checkpoint),
    can_resume: Boolean(latest && !active && isResumableWorkerRun(
      latest.status, latest.completion_reason, control.current_checkpoint, latest.targets.raw_limit,
    )),
    last_completed_at: completed ? safeTimestamp(completed.completed_at) : null,
    latest_run: latest,
    as_of: new Date().toISOString(),
  }
}

export function parseWorkerLeadsLimit(url: URL): number | null {
  const limit = Number(url.searchParams.get('limit') ?? WORKER_QUALIFIED_LEADS_DEFAULT)
  return Number.isInteger(limit) && limit >= 1 && limit <= WORKER_QUALIFIED_LEADS_MAX ? limit : null
}

export async function getQualifiedWorkerLeads(limit = WORKER_QUALIFIED_LEADS_DEFAULT): Promise<WorkerQualifiedLeadsDto> {
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKER_QUALIFIED_LEADS_MAX) throw new Error('worker_limit_invalid')
  const db = createServiceClient()
  const leadsResult = await db.from('worker_leads').select(
    'id,provider_id,product_id,status,qualification_status,qualification_rank,fit_score,fit_reason,qualification_reason_codes,traction_score,traction_level,traction_confidence,traction_confidence_rank,last_activity_at,traction_signals,traction_concerns,traction_summary,contactability_status,contactability_rank,email_ready,preferred_email,preferred_contact_url,created_at',
  ).or('status.in.(qualified,reviewed,contact_ready,contacted,replied,interested,listed),and(status.eq.discovered,qualification_status.in.(qualified,review_candidate))')
    .order('qualification_rank', { ascending: true }).order('fit_score', { ascending: false, nullsFirst: false })
    .order('traction_score', { ascending: false, nullsFirst: false }).order('traction_confidence_rank', { ascending: true })
    .order('contactability_rank', { ascending: true }).order('created_at', { ascending: false })
    .order('id', { ascending: false }) as DbResult
  if (leadsResult.error) dbFailure('worker_qualified_leads', leadsResult.error)
  if (!Array.isArray(leadsResult.data)) throw new Error('worker_leads_invalid')
  const leads = sortQualifiedLeadRows(leadsResult.data.map(objectRow).filter(Boolean) as Record<string, unknown>[])
  const providerIds = [...new Set(leads.map(item => item.provider_id).filter((id): id is string => typeof id === 'string'))]
  const productIds = [...new Set(leads.map(item => item.product_id).filter((id): id is string => typeof id === 'string'))]
  const leadIds = leads.map(item => item.id).filter((id): id is string => typeof id === 'string')
  const [providersResult, productsResult, sourcesResult, contactsResult] = await Promise.all([
    providerIds.length ? db.from('worker_providers').select('id,canonical_name,canonical_domain').in('id', providerIds) : Promise.resolve({ data: [], error: null }),
    productIds.length ? db.from('worker_products').select('id,display_name').in('id', productIds) : Promise.resolve({ data: [], error: null }),
    leadIds.length ? db.from('worker_sources').select('id,lead_id,source_role,url,checked_at,created_at').in('lead_id', leadIds)
      .order('created_at', { ascending: false }).order('id', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    providerIds.length ? db.from('worker_contacts').select('provider_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,verified_at').in('provider_id', providerIds)
      .order('preferred', { ascending: false }).order('verified_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]) as [DbResult, DbResult, DbResult, DbResult]
  if (providersResult.error) dbFailure('worker_lead_providers', providersResult.error)
  if (productsResult.error) dbFailure('worker_lead_products', productsResult.error)
  if (sourcesResult.error) dbFailure('worker_lead_sources', sourcesResult.error)
  if (contactsResult.error) dbFailure('worker_lead_contacts', contactsResult.error)
  const providers = new Map((providersResult.data as unknown[]).map(value => { const item = objectRow(value)!; return [item.id, item] }))
  const products = new Map((productsResult.data as unknown[]).map(value => { const item = objectRow(value)!; return [item.id, item] }))
  const sources = sortQualifiedLeadSources((sourcesResult.data as unknown[]).map(objectRow).filter(Boolean) as Record<string, unknown>[])
  const contacts = (contactsResult.data as unknown[]).map(objectRow).filter(Boolean) as Record<string, unknown>[]
  const result: WorkerQualifiedLeadDto[] = leads.map(item => {
    const provider = providers.get(item.provider_id)
    const product = products.get(item.product_id)
    const leadSources = sources.filter(source => source.lead_id === item.id)
    if (!provider || !product || typeof item.id !== 'string' || typeof provider.canonical_name !== 'string'
      || typeof provider.canonical_domain !== 'string' || typeof product.display_name !== 'string'
      || typeof item.fit_score !== 'number' || typeof item.fit_reason !== 'string') throw new Error('worker_lead_invalid')
    const sourceUrl = (role: string) => {
      const url = leadSources.find(source => source.source_role === role)?.url
      return typeof url === 'string' ? canonicalExternalUrl(url) ?? null : null
    }
    const directory_sources = leadSources.filter(source => source.source_role === 'directory_assertion')
      .flatMap(source => typeof source.url === 'string' ? [canonicalExternalUrl(source.url)].filter((url): url is string => Boolean(url)) : [])
      .slice(0, 3)
    const leadContacts = contacts.filter(contact => contact.provider_id === item.provider_id)
    const officialContactUrl = leadContacts.find(contact => contact.verification_status === 'verified'
      && ['official_contact', 'sales_channel'].includes(String(contact.contact_type))
      && ['official_site', 'official_docs', 'official_github'].includes(String(contact.source_type))
      && !['security', 'privacy', 'legal'].includes(String(contact.purpose))
      && typeof contact.value === 'string' && canonicalExternalUrl(contact.value))?.value
    const evidenceTimes = [...leadSources.map(source => source.checked_at ?? source.created_at), ...leadContacts.map(contact => contact.verified_at)]
      .flatMap(value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? [value] : [])
      .sort((left, right) => Date.parse(right) - Date.parse(left))
    const githubUrl = leadContacts.find(contact => contact.source_type === 'official_github')?.source_url
    return {
      id: item.id, provider: provider.canonical_name, provider_domain: provider.canonical_domain,
      product: product.display_name, fit_score: item.fit_score, summary: item.fit_reason,
      qualification_band: item.qualification_status === 'review_candidate' ? 'review_candidate' : 'qualified',
      traction_score: typeof item.traction_score === 'number' ? item.traction_score : null,
      traction_level: ['low', 'medium', 'high'].includes(String(item.traction_level))
        ? item.traction_level as WorkerQualifiedLeadDto['traction_level'] : null,
      traction_confidence: ['low', 'medium', 'high', 'unknown'].includes(String(item.traction_confidence))
        ? item.traction_confidence as WorkerQualifiedLeadDto['traction_confidence'] : 'unknown',
      traction_signals: Array.isArray(item.traction_signals) ? item.traction_signals.filter(value => typeof value === 'string').slice(0, 8) as string[] : [],
      traction_concerns: Array.isArray(item.traction_concerns) ? item.traction_concerns.filter(value => typeof value === 'string').slice(0, 8) as string[] : [],
      traction_summary: typeof item.traction_summary === 'string' ? item.traction_summary : null,
      last_activity_at: item.last_activity_at === null ? null : safeTimestamp(item.last_activity_at),
      contactability: ['verified_email', 'verified_official_contact', 'official_contact_page', 'official_sales_channel', 'contact_unavailable', 'none_found', 'unknown'].includes(String(item.contactability_status))
        ? item.contactability_status as WorkerQualifiedLeadDto['contactability'] : 'unknown',
      actionable: leadContacts.some(contact => contact.preferred === true),
      email_ready: item.email_ready === true,
      preferred_email: typeof item.preferred_email === 'string' ? item.preferred_email : null,
      preferred_contact_url: typeof item.preferred_contact_url === 'string' ? canonicalExternalUrl(item.preferred_contact_url) ?? null : null,
      official_contact_url: typeof officialContactUrl === 'string' ? canonicalExternalUrl(officialContactUrl) ?? null : null,
      contact_evidence: leadContacts.slice(0, 5).flatMap(contact => {
        const source = typeof contact.source_url === 'string' ? canonicalExternalUrl(contact.source_url) : null
        if (!source || contact.verification_status !== 'verified'
          || !['email', 'official_contact', 'sales_channel'].includes(String(contact.contact_type)) || typeof contact.value !== 'string'
          || !['official_site', 'official_docs', 'official_github'].includes(String(contact.source_type))) return []
        return [{ type: contact.contact_type as 'email' | 'official_contact' | 'sales_channel', value: contact.value,
          source_url: source, purpose: typeof contact.purpose === 'string' ? contact.purpose : 'contact',
          source_type: contact.source_type as 'official_site' | 'official_docs' | 'official_github', preferred: contact.preferred === true }]
      }),
      reason_codes: Array.isArray(item.qualification_reason_codes)
        ? item.qualification_reason_codes.filter(code => typeof code === 'string').slice(0, 8) as string[] : [],
      official_site: sourceUrl('official_site'), docs_url: sourceUrl('official_docs'),
      github_url: typeof githubUrl === 'string' ? canonicalExternalUrl(githubUrl) ?? null : null,
      pricing_url: sourceUrl('official_pricing'), pricing_available: Boolean(sourceUrl('official_pricing')), contact_available: leadContacts.length > 0
        || Boolean(sourceUrl('official_contact')),
      directory_sources,
      status: item.status === 'discovered' && item.qualification_status === 'review_candidate'
        ? 'review_candidate' : item.status === 'discovered' && item.qualification_status === 'qualified'
          ? 'technical_qualified' : item.status as WorkerQualifiedLeadDto['status'],
      last_evidence_at: evidenceTimes[0] ? safeTimestamp(evidenceTimes[0]) : null,
      discovered_at: safeTimestamp(item.created_at, false) as string,
    }
  })
  const operational = result.filter(isOperationalWorkerLead)
  return {
    leads: operational.slice(0, limit),
    counts: {
      technical_qualified: result.filter(lead => lead.qualification_band === 'qualified').length,
      technical_review_candidates: result.filter(lead => lead.qualification_band === 'review_candidate').length,
      actionable_qualified: operational.filter(lead => lead.qualification_band === 'qualified').length,
      actionable_review_candidates: operational.filter(lead => lead.qualification_band === 'review_candidate').length,
      email_ready: operational.filter(lead => lead.email_ready).length,
      contact_form_only: operational.filter(lead => !lead.email_ready).length,
      contact_unavailable: result.filter(lead => ['contact_unavailable', 'none_found'].includes(lead.contactability)).length,
      contact_unknown: result.filter(lead => !isOperationalWorkerLead(lead)
        && !['contact_unavailable', 'none_found'].includes(lead.contactability)).length,
    },
    limit,
    as_of: new Date().toISOString(),
  }
}

export const workerControlRepository = {
  createRun: createWorkerRun,
  attachWorkflowRunId,
  failRun: failWorkerRun,
  requestStop: requestWorkerStop,
}
