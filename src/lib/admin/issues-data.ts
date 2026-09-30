import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { validateListingRequestContract, type ListingRequestContract } from '@/lib/marketplace/request-contract'
import { withOperationsTtl } from './operations-cache'
import { readExpiredResponseBacklog } from './infrastructure-data'
import {
  joinedListing,
  maskWallet,
  runAdminDbRead,
  safeCode,
  safeId,
  safeState,
  safeTimestamp,
  deliveryStates,
  settlementStates,
} from './operations-data'
import type { OperationsIssueDto, OperationsIssueSourceDto, OperationsIssuesDto } from './operations-types'

export const ISSUES_TTL_MS = 60_000
export const STALE_SETTLEMENT_MS = 2 * 60_000
export const ISSUE_SOURCE_BOUND = 101
export const RESPONSE_BACKLOG_WARNING_THRESHOLD = 100
type QueryResult<T> = { data: T | null; error: { message?: string } | null }

async function isolatedIssueRead<T>(read: () => Promise<QueryResult<T>>): Promise<QueryResult<T>> {
  try { return await read() }
  catch { return { data: null, error: { message: 'source unavailable' } } }
}

function issueSource(id: OperationsIssueSourceDto['id'], label: string, ready: boolean): OperationsIssueSourceDto {
  return { id, label, state: ready ? 'ready' : 'unavailable' }
}

const explanations = {
  settlement_unknown: 'Settlement outcome is unknown. The payment may have reached the network and requires operator investigation outside this read-only Admin.',
  manual_review: 'Durable settlement state requires manual review. This page intentionally provides no recovery action.',
  delivery_unknown: 'Delivery outcome is unknown. Retrying from Admin could duplicate an upstream side effect and is intentionally unavailable.',
  legacy_delivery_unknown: 'Accounting is complete, but this delivery record has the legacy null signature from before durable delivery observation. No live delivery failure is inferred.',
  stale_submitted: 'Settlement remains submitted beyond the durable two-minute uncertainty window.',
  delivery_retryable: 'Delivery is recorded as retryable, but Admin does not initiate a retry.',
  delivery_final: 'Delivery reached a durable final failure state.',
  withdrawal_submission_unknown: 'Withdrawal submission outcome is unknown and requires external operator investigation.',
  withdrawal_mint_unknown: 'Withdrawal mint outcome is unknown and requires external operator investigation.',
  withdrawal_failed: 'Withdrawal is in a durable failed state and remains an accounting concern.',
  response_backlog: 'Expired response storage exceeds the conservative backlog threshold. This does not prove whether scheduled maintenance ran.',
  invalid_listing_contract: 'The active listing request contract failed bounded validation and may be excluded from safe execution.',
} as const

const legacyDeliveryFields = [
  'delivery_request_hash',
  'delivery_token',
  'delivery_started_at',
  'delivery_completed_at',
  'delivery_http_status',
  'delivery_error_code',
] as const

export function isLegacyDeliveryInformational(row: Record<string, unknown>): boolean {
  return row.state === 'ACCOUNTING_COMPLETE' && row.delivery_state === 'UNKNOWN' && safeId(row.purchase_id) !== null &&
    legacyDeliveryFields.every(field => row[field] === null)
}

function attemptIssue(row: Record<string, unknown>, now: number): OperationsIssueDto[] {
  const entityId = safeId(row.id)
  if (!entityId) return []
  const listing = joinedListing(row.api_listings)
  const binding = row.binding && typeof row.binding === 'object' && !Array.isArray(row.binding) ? row.binding as Record<string, unknown> : null
  const settlement = safeState(row.state, settlementStates)
  const delivery = safeState(row.delivery_state, deliveryStates)
  const purchaseId = safeId(row.purchase_id)
  const updatedAt = safeTimestamp(row.updated_at)
  const legacyDelivery = isLegacyDeliveryInformational(row)
  const base = {
    entity_id: entityId,
    listing,
    wallet: binding ? maskWallet(binding.payer) : null,
    settlement_state: settlement,
    delivery_state: delivery,
    purchase_id: purchaseId,
    occurred_at: null,
    updated_at: updatedAt,
  }
  const issues: OperationsIssueDto[] = []
  if (settlement === 'SETTLEMENT_UNKNOWN') issues.push({ id: `settlement_unknown:${entityId}`, type: 'SETTLEMENT_UNKNOWN', severity: 'critical', presentation: 'needs_attention', error_code: safeCode(row.reason), explanation: explanations.settlement_unknown, ...base })
  if (settlement === 'MANUAL_REVIEW') issues.push({ id: `manual_review:${entityId}`, type: 'MANUAL_REVIEW', severity: 'critical', presentation: 'needs_attention', error_code: safeCode(row.reason), explanation: explanations.manual_review, ...base })
  if (settlement === 'SETTLEMENT_SUBMITTED') {
    const submittedAt = safeTimestamp(row.submitted_at)
    if (submittedAt && now - Date.parse(submittedAt) > STALE_SETTLEMENT_MS) issues.push({ id: `stale_submitted:${entityId}`, type: 'STALE_SETTLEMENT_SUBMITTED', severity: 'warning', presentation: 'needs_attention', error_code: null, explanation: explanations.stale_submitted, ...base })
  }
  if (delivery === 'UNKNOWN') issues.push({
    id: `delivery_unknown:${entityId}`, type: 'DELIVERY_UNKNOWN',
    severity: legacyDelivery ? 'informational' : 'critical',
    presentation: legacyDelivery ? 'informational' : 'needs_attention',
    error_code: safeCode(row.delivery_error_code),
    explanation: legacyDelivery ? explanations.legacy_delivery_unknown : explanations.delivery_unknown,
    ...base,
  })
  if (delivery === 'FAILED_RETRYABLE') issues.push({ id: `delivery_retryable:${entityId}`, type: 'FAILED_RETRYABLE', severity: 'warning', presentation: 'needs_attention', error_code: safeCode(row.delivery_error_code), explanation: explanations.delivery_retryable, ...base })
  if (delivery === 'FAILED_FINAL') issues.push({ id: `delivery_final:${entityId}`, type: 'FAILED_FINAL', severity: 'warning', presentation: 'needs_attention', error_code: safeCode(row.delivery_error_code), explanation: explanations.delivery_final, ...base })
  return issues
}

function withdrawalIssue(row: Record<string, unknown>): OperationsIssueDto | null {
  const entityId = safeId(row.id)
  const status = row.status
  if (!entityId || !['submission_unknown', 'mint_unknown', 'failed'].includes(String(status))) return null
  const definition = status === 'submission_unknown'
    ? ['WITHDRAWAL_SUBMISSION_UNKNOWN', explanations.withdrawal_submission_unknown]
    : status === 'mint_unknown'
      ? ['WITHDRAWAL_MINT_UNKNOWN', explanations.withdrawal_mint_unknown]
      : ['WITHDRAWAL_FAILED', explanations.withdrawal_failed]
  return {
    id: `${definition[0].toLowerCase()}:${entityId}`,
    type: definition[0], severity: 'warning', presentation: 'needs_attention', entity_id: entityId, listing: null,
    wallet: maskWallet(row.seller_wallet), settlement_state: null, delivery_state: null,
    purchase_id: null, error_code: null, occurred_at: null,
    updated_at: safeTimestamp(row.updated_at) ?? safeTimestamp(row.created_at), explanation: definition[1],
  }
}

async function currentIssues(): Promise<{ issues: OperationsIssueDto[]; truncated: boolean; complete: boolean; sources: OperationsIssueSourceDto[] }> {
  const db = createServiceClient()
  const attemptFields = 'id, state, delivery_state, purchase_id, reason, submitted_at, updated_at, delivery_request_hash, delivery_token, delivery_started_at, delivery_completed_at, delivery_http_status, delivery_error_code, binding, api_listings(id, name)'
  const [incomplete, delivery, withdrawals, listings, backlog] = await Promise.all([
    isolatedIssueRead(() => runAdminDbRead(() => db.from('x402_settlement_attempts').select(attemptFields)
      .not('state', 'eq', 'ACCOUNTING_COMPLETE').order('updated_at', { ascending: false }).limit(ISSUE_SOURCE_BOUND) as PromiseLike<QueryResult<Record<string, unknown>[]>>)),
    isolatedIssueRead(() => runAdminDbRead(() => db.from('x402_settlement_attempts').select(attemptFields)
      .eq('state', 'ACCOUNTING_COMPLETE').in('delivery_state', ['UNKNOWN', 'FAILED_RETRYABLE', 'FAILED_FINAL'])
      .order('updated_at', { ascending: false }).limit(ISSUE_SOURCE_BOUND) as PromiseLike<QueryResult<Record<string, unknown>[]>>)),
    isolatedIssueRead(() => runAdminDbRead(() => db.from('seller_withdrawals').select('id, seller_wallet, status, created_at')
      .in('status', ['submission_unknown', 'mint_unknown', 'failed']).order('created_at', { ascending: false }).limit(ISSUE_SOURCE_BOUND) as PromiseLike<QueryResult<Record<string, unknown>[]>>)),
    isolatedIssueRead(() => runAdminDbRead(() => db.from('api_listings').select('id, name, seller_wallet, is_active, endpoint_url, method, auth_type, auth_param_name, encrypted_key, example_request, body_required, dynamic_path_supported, path_parameters, query_parameters')
      .eq('is_active', true).limit(ISSUE_SOURCE_BOUND) as PromiseLike<QueryResult<Record<string, unknown>[]>>)),
    readExpiredResponseBacklog(),
  ])
  const sources = [
    issueSource('settlement', 'Settlement attempts', !incomplete.error),
    issueSource('delivery', 'Accounted delivery', !delivery.error),
    issueSource('withdrawals', 'Withdrawals', !withdrawals.error),
    issueSource('response_backlog', 'Response retention', backlog !== null),
    issueSource('listing_contracts', 'Active listing contracts', !listings.error),
  ]
  if (sources.every(source => source.state === 'unavailable')) throw new Error('issues_unavailable')
  const now = Date.now()
  const attempts = [...(incomplete.data ?? []), ...(delivery.data ?? [])].flatMap(row => attemptIssue(row, now))
  const withdrawalIssues = (withdrawals.data ?? []).flatMap(row => withdrawalIssue(row) ?? [])
  const listingIssues = (listings.data ?? []).flatMap(row => {
    const entityId = safeId(row.id)
    const result = validateListingRequestContract(row as ListingRequestContract)
    if (!entityId || result.ok) return []
    return [{
      id: `invalid_listing_contract:${entityId}`, type: 'INVALID_LISTING_REQUEST_CONTRACT', severity: 'warning' as const, presentation: 'needs_attention' as const,
      entity_id: entityId, listing: { id: entityId, name: typeof row.name === 'string' ? row.name.slice(0, 120) : 'Unnamed listing' },
      wallet: maskWallet(row.seller_wallet), settlement_state: null, delivery_state: null, purchase_id: null,
      error_code: `invalid_${result.field}`, occurred_at: null, updated_at: null,
      explanation: explanations.invalid_listing_contract,
    }]
  })
  const backlogIssues: OperationsIssueDto[] = backlog && backlog.count > RESPONSE_BACKLOG_WARNING_THRESHOLD ? [{
    id: 'response_pruning_backlog:response-storage', type: 'RESPONSE_PRUNING_BACKLOG', severity: 'warning', presentation: 'needs_attention',
    entity_id: 'response-storage', listing: null, wallet: null, settlement_state: null, delivery_state: null,
    purchase_id: null, error_code: 'expired_response_backlog', occurred_at: null, updated_at: null,
    explanation: explanations.response_backlog,
  }] : []
  const issues = [...attempts, ...withdrawalIssues, ...listingIssues, ...backlogIssues].sort((a, b) => {
    if (a.presentation !== b.presentation) return a.presentation === 'needs_attention' ? -1 : 1
    const severityRank = { critical: 0, warning: 1, informational: 2 }
    if (a.severity !== b.severity) return severityRank[a.severity] - severityRank[b.severity]
    return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) || a.id.localeCompare(b.id)
  })
  const truncated = [incomplete.data, delivery.data, withdrawals.data, listings.data].some(rows => (rows?.length ?? 0) >= ISSUE_SOURCE_BOUND) || Boolean(backlog?.capped)
  return { issues, truncated, complete: sources.every(source => source.state === 'ready'), sources }
}

function getCachedCurrentIssues() {
  return withOperationsTtl('current-issues-v3', ISSUES_TTL_MS, currentIssues)
}

export async function getOperationsIssues(limit: number): Promise<OperationsIssuesDto> {
  const current = await getCachedCurrentIssues()
  const needsAttention = current.issues.filter(issue => issue.presentation === 'needs_attention')
  const informational = current.issues.filter(issue => issue.presentation === 'informational')
  return {
    issues: current.issues.slice(0, limit), count: current.issues.length, truncated: current.truncated,
    counts: {
      needs_attention_entities: new Set(needsAttention.map(issue => issue.entity_id)).size,
      needs_attention_conditions: needsAttention.length,
      informational_conditions: informational.length,
      all_conditions: current.issues.length,
    },
    complete: current.complete, sources: current.sources,
    taxonomy: 'current_durable_v1', as_of: new Date().toISOString(),
  }
}

export { explanations as ISSUE_EXPLANATIONS }
