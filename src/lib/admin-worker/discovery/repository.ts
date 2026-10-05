import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { canonicalExternalUrl, durableExternalName, durableExternalSummary } from './sanitize'
import type { BudgetClaimResult, CandidateOutcome, DurableCandidate, ProvenanceFact, RawCandidate, WorkerQualification, WorkerTraction } from './types'

type DbError = { message?: string; code?: string } | null
type DbResult = { data: unknown; error: DbError }

function fail(scope: string, error: DbError): never {
  console.error(`[admin-worker] ${scope} unavailable`, error?.code ?? error?.message ?? 'database error')
  throw new Error(`${scope}_unavailable`)
}

function row(value: unknown): Record<string, unknown> | null {
  const item = Array.isArray(value) ? value[0] : value
  return item && typeof item === 'object' ? item as Record<string, unknown> : null
}

function candidateRow(value: unknown): DurableCandidate {
  const item = row(value)
  if (!item || typeof item.id !== 'string' || typeof item.discovery_batch_id !== 'string'
    || !Number.isInteger(item.ordinal) || typeof item.source_type !== 'string'
    || typeof item.source_url !== 'string' || typeof item.discovered_name !== 'string') {
    throw new Error('worker_candidate_invalid')
  }
  return {
    id: item.id,
    discoveryBatchId: item.discovery_batch_id,
    ordinal: item.ordinal as number,
    sourceType: item.source_type as DurableCandidate['sourceType'],
    sourceUrl: item.source_url,
    discoveredName: item.discovered_name,
    discoveredDomain: typeof item.discovered_domain === 'string' ? item.discovered_domain : undefined,
    discoveredProduct: typeof item.discovered_product === 'string' ? item.discovered_product : undefined,
    discoveredContractUrl: typeof item.discovered_contract_url === 'string' ? item.discovered_contract_url : undefined,
    discoveredDocsUrl: typeof item.discovered_docs_url === 'string' ? item.discovered_docs_url : undefined,
    discoveredPricingUrl: typeof item.discovered_pricing_url === 'string' ? item.discovered_pricing_url : undefined,
    discoveredContactUrl: typeof item.discovered_contact_url === 'string' ? item.discovered_contact_url : undefined,
    sourceSummary: typeof item.source_summary === 'string' ? item.source_summary : undefined,
    directoryAddedAt: typeof item.source_added_at === 'string' ? item.source_added_at : undefined,
    directoryUpdatedAt: typeof item.source_updated_at === 'string' ? item.source_updated_at : undefined,
    normalizedDomain: typeof item.normalized_domain === 'string' ? item.normalized_domain : null,
    normalizedProductKey: typeof item.normalized_product_key === 'string' ? item.normalized_product_key : null,
    status: item.status as DurableCandidate['status'],
    reasonCode: typeof item.reason_code === 'string' ? item.reason_code : null,
    providerId: typeof item.provider_id === 'string' ? item.provider_id : null,
    productId: typeof item.product_id === 'string' ? item.product_id : null,
    leadId: typeof item.lead_id === 'string' ? item.lead_id : null,
    retryAfter: null,
    processingLeaseId: typeof item.processing_lease_id === 'string' ? item.processing_lease_id : null,
    processingLeaseExpiresAt: typeof item.processing_lease_expires_at === 'string' ? item.processing_lease_expires_at : null,
  }
}

export async function getDiscoveryRunContext(runId: string): Promise<{
  batchId: string; rootRunNumber: number; deadlineAt: string; qualifiedCount: number; qualifiedTarget: number
}> {
  const db = createServiceClient()
  const current = await db.from('worker_runs').select('discovery_batch_id,deadline_at,qualified_count,qualified_target').eq('id', runId).single() as DbResult
  if (current.error) fail('worker_discovery_context', current.error)
  const currentRow = row(current.data)
  if (!currentRow || typeof currentRow.discovery_batch_id !== 'string' || typeof currentRow.deadline_at !== 'string'
    || !Number.isInteger(currentRow.qualified_count) || !Number.isInteger(currentRow.qualified_target)) throw new Error('worker_discovery_context_invalid')
  const root = await db.from('worker_runs').select('run_number').eq('id', currentRow.discovery_batch_id).single() as DbResult
  if (root.error) fail('worker_discovery_root', root.error)
  const rootRow = row(root.data)
  if (!rootRow || !Number.isInteger(rootRow.run_number)) throw new Error('worker_discovery_context_invalid')
  return { batchId: currentRow.discovery_batch_id, rootRunNumber: rootRow.run_number as number, deadlineAt: currentRow.deadline_at,
    qualifiedCount: currentRow.qualified_count as number, qualifiedTarget: currentRow.qualified_target as number }
}

export async function claimDiscoveryBudget(runId: string, budget: 'source' | 'research' | 'groq' | 'traction', claimKey: string): Promise<BudgetClaimResult> {
  const result = await createServiceClient().rpc('mahshar_worker_claim_budget_v2', {
    p_run_id: runId, p_budget: budget, p_claim_key: claimKey,
  }) as DbResult
  if (result.error) fail('worker_discovery_budget', result.error)
  if (!['claimed', 'replayed', 'exhausted', 'deadline_reached'].includes(String(result.data))) throw new Error('worker_discovery_budget_result_invalid')
  return result.data as BudgetClaimResult
}

export async function getMaterializedSourceWork(batchId: string, claimKey: string): Promise<unknown | null> {
  const result = await createServiceClient().from('worker_source_work').select('compact_result')
    .eq('discovery_batch_id', batchId).eq('claim_key', claimKey).maybeSingle() as DbResult
  if (result.error) fail('worker_source_work_lookup', result.error)
  return row(result.data)?.compact_result ?? null
}

export async function materializeSourceWork(
  runId: string,
  claimKey: string,
  workKind: 'provider_plan' | 'provider_window' | 'candidate',
  compactResult: unknown,
): Promise<unknown | null> {
  const result = await createServiceClient().rpc('mahshar_worker_materialize_source_work', {
    p_run_id: runId, p_claim_key: claimKey, p_work_kind: workKind, p_compact_result: compactResult,
  }) as DbResult
  if (result.error) fail('worker_source_work_materialize', result.error)
  return result.data ?? null
}

export async function getDiscoveryCandidates(batchId: string, start: number, end: number): Promise<DurableCandidate[]> {
  const result = await createServiceClient().from('worker_candidates').select('*')
    .eq('discovery_batch_id', batchId).gte('ordinal', start).lt('ordinal', end)
    .order('ordinal', { ascending: true }) as DbResult
  if (result.error) fail('worker_candidates', result.error)
  return Array.isArray(result.data) ? result.data.map(candidateRow) : []
}

export function discoveryCandidateRecord(batchId: string, ordinal: number, candidate: RawCandidate | null, reasonCode?: string): {
    discovery_batch_id: string; ordinal: number; source_type: 'api_directory'; source_url: string;
    discovered_name: string; discovered_domain: string | null; discovered_product: string | null;
    discovered_contract_url: string | null;
    discovered_docs_url: string | null; discovered_pricing_url: string | null;
    discovered_contact_url: string | null; source_summary: string | null;
    source_added_at: string | null; source_updated_at: string | null;
    status: 'pending' | 'filtered' | 'deferred'; reason_code: string | null;
    terminal_at?: string | null; retention_eligible_at?: string | null;
  } {
  if (candidate) {
    const providerName = durableExternalName(candidate.discoveredName, 200)
    const productName = durableExternalName(candidate.discoveredProduct, 200)
    if (!providerName || !productName) return discoveryCandidateRecord(batchId, ordinal, null, 'external_name_invalid')
    return {
    discovery_batch_id: batchId, ordinal, source_type: candidate.sourceType,
    source_url: canonicalExternalUrl(candidate.sourceUrl) ?? 'https://api.apis.guru/v2/providers.json', discovered_name: providerName,
    discovered_domain: candidate.discoveredDomain?.slice(0, 253) ?? null,
    discovered_product: productName,
    discovered_contract_url: canonicalExternalUrl(candidate.discoveredContractUrl) ?? null,
    discovered_docs_url: canonicalExternalUrl(candidate.discoveredDocsUrl) ?? null,
    discovered_pricing_url: canonicalExternalUrl(candidate.discoveredPricingUrl) ?? null,
    discovered_contact_url: canonicalExternalUrl(candidate.discoveredContactUrl) ?? null,
    source_summary: durableExternalSummary(candidate.sourceSummary, 700) ?? null,
    source_added_at: candidate.directoryAddedAt ?? null, source_updated_at: candidate.directoryUpdatedAt ?? null,
    status: 'pending' as const, reason_code: null,
    }
  }
  const now = new Date()
  const deferred = reasonCode === 'run_budget_exhausted'
  return {
    discovery_batch_id: batchId, ordinal, source_type: 'api_directory' as const,
    source_url: 'https://api.apis.guru/v2/providers.json', discovered_name: `unavailable-${ordinal + 1}`,
    discovered_domain: null, discovered_product: null, discovered_contract_url: null, discovered_docs_url: null,
    discovered_pricing_url: null, discovered_contact_url: null, source_summary: null,
    source_added_at: null, source_updated_at: null,
    status: deferred ? 'deferred' as const : 'filtered' as const,
    reason_code: reasonCode ?? 'source_record_invalid',
    terminal_at: deferred ? null : now.toISOString(),
    retention_eligible_at: new Date(now.getTime() + (deferred ? 90 : 30) * 24 * 60 * 60 * 1000).toISOString(),
  }
}

export async function saveDiscoveryCandidate(batchId: string, ordinal: number, candidate: RawCandidate | null, reasonCode?: string): Promise<void> {
  const value = discoveryCandidateRecord(batchId, ordinal, candidate, reasonCode)
  const result = await createServiceClient().from('worker_candidates')
    .upsert(value, { onConflict: 'discovery_batch_id,ordinal', ignoreDuplicates: true }) as DbResult
  if (result.error) fail('worker_candidate_save', result.error)
}

export async function markDiscoveryCandidate(candidate: DurableCandidate, outcome: CandidateOutcome, domain?: string, productKey?: string): Promise<void> {
  const result = await createServiceClient().rpc('mahshar_worker_complete_candidate', {
    p_candidate_id: candidate.id, p_lease_id: candidate.processingLeaseId,
    p_status: outcome.status, p_reason_code: outcome.reasonCode,
    p_domain: domain, p_product_key: productKey,
    p_provider_id: outcome.providerId, p_product_id: outcome.productId, p_lead_id: outcome.leadId,
  }) as DbResult
  if (result.error) fail('worker_candidate_update', result.error)
}

export type CandidatePreflight = {
  action: 'continue' | 'blocked' | 'duplicate'
  reasonCode?: string
  providerId?: string
  productId?: string
  leadId?: string
}

export async function preflightCandidate(domain: string, productKey: string): Promise<CandidatePreflight> {
  const db = createServiceClient()
  const identity = await db.from('worker_provider_identities').select('provider_id')
    .eq('identity_type', 'domain').eq('normalized_value', domain).maybeSingle() as DbResult
  if (identity.error) fail('worker_identity_lookup', identity.error)
  let providerId = row(identity.data)?.provider_id
  if (typeof providerId !== 'string') {
    const byDomain = await db.from('worker_providers').select('id').eq('canonical_domain', domain).maybeSingle() as DbResult
    if (byDomain.error) fail('worker_provider_domain_lookup', byDomain.error)
    providerId = row(byDomain.data)?.id
  }
  if (typeof providerId !== 'string') return { action: 'continue' }
  const provider = await db.from('worker_providers').select('status').eq('id', providerId).single() as DbResult
  if (provider.error) fail('worker_provider_lookup', provider.error)
  const providerStatus = row(provider.data)?.status
  if (providerStatus === 'do_not_contact' || providerStatus === 'rejected') {
    return { action: 'blocked', reasonCode: providerStatus === 'do_not_contact' ? 'provider_do_not_contact' : 'provider_rejected', providerId }
  }
  const decision = await db.from('worker_decisions').select('decision').eq('provider_id', providerId)
    .is('lead_id', null).in('decision', ['rejected', 'do_not_contact']).order('created_at', { ascending: false }).limit(1).maybeSingle() as DbResult
  if (decision.error) fail('worker_provider_decision_lookup', decision.error)
  const decisionValue = row(decision.data)?.decision
  if (decisionValue === 'do_not_contact' || decisionValue === 'rejected') {
    return { action: 'blocked', reasonCode: decisionValue === 'do_not_contact' ? 'provider_do_not_contact' : 'provider_rejected', providerId }
  }
  const product = await db.from('worker_products').select('id,status').eq('provider_id', providerId)
    .eq('normalized_product_key', productKey).maybeSingle() as DbResult
  if (product.error) fail('worker_product_lookup', product.error)
  const productRow = row(product.data)
  if (!productRow || typeof productRow.id !== 'string') return { action: 'continue', providerId }
  if (productRow.status === 'rejected') return { action: 'blocked', reasonCode: 'product_rejected', providerId, productId: productRow.id }
  const lead = await db.from('worker_leads').select('id,status,qualification_status,qualification_retry_after')
    .eq('product_id', productRow.id).maybeSingle() as DbResult
  if (lead.error) fail('worker_lead_lookup', lead.error)
  const leadRow = row(lead.data)
  if (!leadRow || typeof leadRow.id !== 'string') return { action: 'continue', providerId, productId: productRow.id }
  const leadDecision = await db.from('worker_decisions').select('decision').eq('lead_id', leadRow.id)
    .in('decision', ['rejected', 'do_not_contact']).order('created_at', { ascending: false }).limit(1).maybeSingle() as DbResult
  if (leadDecision.error) fail('worker_lead_decision_lookup', leadDecision.error)
  if (row(leadDecision.data)?.decision) return { action: 'blocked', reasonCode: 'lead_decision_blocked', providerId, productId: productRow.id, leadId: leadRow.id }
  if (leadRow.status === 'do_not_contact') return { action: 'blocked', reasonCode: 'lead_do_not_contact', providerId, productId: productRow.id, leadId: leadRow.id }
  if (['reviewed', 'contact_ready', 'contacted', 'replied', 'interested', 'listed', 'closed'].includes(String(leadRow.status))) {
    return { action: 'duplicate', reasonCode: 'existing_human_state', providerId, productId: productRow.id, leadId: leadRow.id }
  }
  if (leadRow.status === 'rejected' && leadRow.qualification_status !== 'rejected') {
    return { action: 'duplicate', reasonCode: 'existing_human_state', providerId, productId: productRow.id, leadId: leadRow.id }
  }
  const retryAfter = typeof leadRow.qualification_retry_after === 'string' ? Date.parse(leadRow.qualification_retry_after) : 0
  if (leadRow.qualification_status === 'deferred' && retryAfter > Date.now()) {
    return { action: 'duplicate', reasonCode: 'qualification_deferred', providerId, productId: productRow.id, leadId: leadRow.id }
  }
  if (leadRow.qualification_status === 'qualified') return { action: 'duplicate', reasonCode: 'existing_qualified_lead', providerId, productId: productRow.id, leadId: leadRow.id }
  if (leadRow.qualification_status === 'review_candidate') return { action: 'duplicate', reasonCode: 'existing_review_candidate', providerId, productId: productRow.id, leadId: leadRow.id }
  if (leadRow.qualification_status === 'rejected') return { action: 'duplicate', reasonCode: 'existing_rejected_lead', providerId, productId: productRow.id, leadId: leadRow.id }
  return { action: 'continue', providerId, productId: productRow.id, leadId: leadRow.id }
}

export async function resolveDiscoveryLead(input: {
  candidate: DurableCandidate; domain: string; productKey: string
}): Promise<CandidatePreflight> {
  const result = await createServiceClient().rpc('mahshar_worker_resolve_discovery_lead', {
    p_candidate_id: input.candidate.id, p_lease_id: input.candidate.processingLeaseId,
    p_domain: input.domain, p_product_key: input.productKey,
    p_provider_name: durableExternalName(input.candidate.discoveredName, 200),
    p_original_domain: (input.candidate.discoveredDomain ?? input.domain).slice(0, 512),
    p_product_name: durableExternalName(input.candidate.discoveredProduct ?? input.candidate.discoveredName, 200),
  }) as DbResult
  if (result.error) fail('worker_discovery_lead_resolve', result.error)
  const value = row(result.data)
  if (!value || !['continue', 'blocked', 'duplicate'].includes(String(value.action))) throw new Error('worker_discovery_lead_resolve_invalid')
  return {
    action: value.action as CandidatePreflight['action'],
    reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : undefined,
    providerId: typeof value.providerId === 'string' ? value.providerId : undefined,
    productId: typeof value.productId === 'string' ? value.productId : undefined,
    leadId: typeof value.leadId === 'string' ? value.leadId : undefined,
  }
}

export async function claimDeferredCandidates(runId: string, batchId: string, limit = 5): Promise<DurableCandidate[]> {
  const claimed = await createServiceClient().rpc('mahshar_worker_claim_deferred_candidates', {
    p_run_id: runId, p_claim_key: `deferred:${runId}`, p_limit: limit,
  }) as DbResult
  if (claimed.error) fail('worker_deferred_claim', claimed.error)
  const leases = new Map<string, string>()
  if (Array.isArray(claimed.data)) for (const value of claimed.data) {
    const item = row(value)
    if (typeof item?.candidate_id === 'string' && typeof item.lease_id === 'string') leases.set(item.candidate_id, item.lease_id)
  }
  const ids = [...leases.keys()]
  if (!ids.length) return []
  const result = await createServiceClient().from('worker_candidates').select('*')
    .eq('deferred_claim_batch_id', batchId).in('id', ids)
    .order('deferred_claim_order', { ascending: true }).order('id', { ascending: true }) as DbResult
  if (result.error) fail('worker_deferred_candidates', result.error)
  return Array.isArray(result.data) ? result.data.map(value => {
    const candidate = candidateRow(value)
    candidate.processingLeaseId = leases.get(candidate.id) ?? null
    return candidate
  }) : []
}

export async function getReusableProvenance(leadId: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<ProvenanceFact[]> {
  const result = await createServiceClient().from('worker_sources')
    .select('source_type,source_role,url,title,factual_summary,checked_at').eq('lead_id', leadId)
    .order('checked_at', { ascending: false }).limit(5) as DbResult
  if (result.error) fail('worker_sources_lookup', result.error)
  const cutoff = Date.now() - maxAgeMs
  if (!Array.isArray(result.data)) return []
  return result.data.flatMap(value => {
    const item = row(value)
    if (!item || typeof item.url !== 'string' || typeof item.source_type !== 'string'
      || typeof item.source_role !== 'string' || typeof item.checked_at !== 'string'
      || Date.parse(item.checked_at) < cutoff) return []
    const url = canonicalExternalUrl(item.url)
    if (!url) return []
    return [{
      sourceType: item.source_type as ProvenanceFact['sourceType'], sourceRole: item.source_role as ProvenanceFact['sourceRole'],
      url, title: typeof item.title === 'string' ? item.title : undefined,
      factualSummary: durableExternalSummary(typeof item.factual_summary === 'string' ? item.factual_summary : undefined, 1000),
      checkedAt: item.checked_at,
    }]
  })
}

export async function saveProvenance(leadId: string, facts: ProvenanceFact[]): Promise<void> {
  if (!facts.length) return
  const values = provenanceRecords(leadId, facts)
  if (!values.length) return
  const result = await createServiceClient().from('worker_sources').upsert(values, { onConflict: 'lead_id,url' }) as DbResult
  if (result.error) fail('worker_sources_upsert', result.error)
}

export function provenanceRecords(leadId: string, facts: ProvenanceFact[]): Array<{
  lead_id: string; source_type: ProvenanceFact['sourceType']; source_role: ProvenanceFact['sourceRole'];
  url: string; title: string | null; factual_summary: string | null; checked_at: string
}> {
  return facts.slice(0, 5).map(fact => ({
    lead_id: leadId, source_type: fact.sourceType, source_role: fact.sourceRole,
    url: canonicalExternalUrl(fact.url), title: durableExternalSummary(fact.title, 256) ?? null,
    factual_summary: durableExternalSummary(fact.factualSummary, 1000) ?? null, checked_at: fact.checkedAt,
  })).filter((value): value is typeof value & { url: string } => typeof value.url === 'string')
}

export async function saveQualification(input: {
  runId: string; candidate: DurableCandidate; providerId: string; productId: string; leadId: string; result?: WorkerQualification; model?: string;
  traction?: WorkerTraction; qualified: boolean; deferredReason?: string
}): Promise<{ status: CandidateOutcome['status']; reasonCode: string; countedQualified: boolean; targetReached: boolean }> {
  if (!input.deferredReason && (!input.result || !input.model)) throw new Error('worker_qualification_missing')
  const result = await createServiceClient().rpc('mahshar_worker_persist_qualification_v2', {
    p_run_id: input.runId,
    p_candidate_id: input.candidate.id, p_lease_id: input.candidate.processingLeaseId,
    p_provider_id: input.providerId, p_product_id: input.productId, p_lead_id: input.leadId,
    p_qualification: input.result ? { ...input.result, summary: durableExternalSummary(input.result.summary, 500) } : null,
    p_traction: input.traction ?? null, p_contactability: input.traction?.contactability ?? 'unknown',
    p_model: input.model ?? null, p_qualified: input.qualified, p_deferred_reason: input.deferredReason ?? null,
  }) as DbResult
  if (result.error) fail('worker_qualification_save', result.error)
  const value = row(result.data)
  if (!value || !['duplicate', 'blocked', 'filtered', 'deferred', 'persisted'].includes(String(value.status))
    || typeof value.reasonCode !== 'string' || typeof value.countedQualified !== 'boolean' || typeof value.targetReached !== 'boolean') {
    throw new Error('worker_qualification_result_invalid')
  }
  return { status: value.status as CandidateOutcome['status'], reasonCode: value.reasonCode,
    countedQualified: value.countedQualified, targetReached: value.targetReached }
}

export function qualificationRetryAfter(reason: string, now = Date.now()): string {
  const delay = reason === 'groq_qualification_failed' ? 60 * 60 * 1000 : 0
  return new Date(now + delay).toISOString()
}
