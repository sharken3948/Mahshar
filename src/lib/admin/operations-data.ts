import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { validateListingRequestContract, type RequestContractValidation } from '@/lib/marketplace/request-contract'
import { credentialProxyAllowed } from '@/lib/marketplace/listing-security'
import { withOperationsTtl } from './operations-cache'
import type {
  ListingContractStatus,
  ListingCountsDto,
  OperationsListingDto,
  OperationsListingsDto,
  OperationsSnapshotDto,
  RecentPaymentDto,
  RecentPaymentsDto,
  StateCount,
} from './operations-types'

export const OPERATIONS_TTL = {
  listingCounts: 5 * 60_000,
  settlementSnapshot: 60_000,
  recentPayments: 60_000,
} as const

export const LISTINGS_DEFAULT_PAGE_SIZE = 25
export const LISTINGS_MAX_PAGE_SIZE = 50
export const OPERATIONS_DEFAULT_LIMIT = 25
export const OPERATIONS_MAX_LIMIT = 50
export const LISTINGS_MAX_OFFSET = 10_000
const SNAPSHOT_ROW_LIMIT = 500
const RECENT_PAYMENT_LIMIT = OPERATIONS_DEFAULT_LIMIT

type QueryResult<T> = { data: T | null; error: { message?: string } | null; count?: number | null }
type ListingStatusFilter = 'all' | 'active' | 'inactive'
type VerificationFilter = 'all' | 'verified' | 'unverified'

let activeReads = 0
const readWaiters: Array<() => void> = []

/** A per-runtime guardrail; the browser request pool supplies the same bound across Overview endpoints. */
export async function runAdminDbRead<T>(read: () => PromiseLike<T>): Promise<T> {
  if (activeReads >= 2) await new Promise<void>(resolve => readWaiters.push(resolve))
  activeReads += 1
  try { return await read() }
  finally {
    activeReads -= 1
    readWaiters.shift()?.()
  }
}

function dbFailure(scope: string, error: { message?: string } | null): never {
  console.error(`[admin-operations] ${scope} unavailable`, error?.message ?? 'unknown database error')
  throw new Error(`${scope}_unavailable`)
}

function nowIso() { return new Date().toISOString() }

export function safeText(value: unknown, maxLength: number, fallback = 'Unavailable') {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, maxLength) : fallback
}

export function safeId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
}

export function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return null
  return value
}

export function safeHttpStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : null
}

export const settlementStates = new Set(['PREPARED', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_CONFIRMED', 'ACCOUNTING_COMPLETE', 'SETTLEMENT_UNKNOWN', 'MANUAL_REVIEW'])
export const deliveryStates = new Set(['NOT_STARTED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'UNKNOWN'])
const paymentReasons = new Set([
  'settlement_transport_uncertain',
  'facilitator_rejected_or_authorization_used',
  'settlement_result_conflict',
  'settlement_acknowledgement_missing',
  'historical_transaction_identity_conflict',
  'listing_owner_conflict',
])

export function safeState(value: unknown, allowed: Set<string>) {
  return typeof value === 'string' && allowed.has(value) ? value : 'UNRECOGNIZED'
}

export function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : null
}

export function safeEvidence(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  if (!clean || clean.length > 512 || !/^[A-Za-z0-9:._/-]+$/.test(clean)) return null
  return clean.length <= 96 ? clean : `${clean.slice(0, 56)}…${clean.slice(-24)}`
}

function countStates(rows: Record<string, unknown>[], key: 'state' | 'delivery_state', allowed: Set<string>): StateCount[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const state = safeState(row[key], allowed)
    totals.set(state, (totals.get(state) ?? 0) + 1)
  }
  return [...totals].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count || a.state.localeCompare(b.state))
}

async function exactListingCount(filter?: (query: any) => any): Promise<number> {
  const db = createServiceClient()
  let query = db.from('api_listings').select('id', { count: 'exact', head: true })
  if (filter) query = filter(query)
  const result = await runAdminDbRead(() => query as PromiseLike<QueryResult<never[]>>) as QueryResult<never[]>
  if (result.error || result.count === null || result.count === undefined) dbFailure('listing_counts', result.error)
  return result.count
}

export function getListingCounts() {
  return withOperationsTtl<ListingCountsDto>('listing-counts-v1', OPERATIONS_TTL.listingCounts, async () => {
    const [total, active] = await Promise.all([
      exactListingCount(),
      exactListingCount(query => query.eq('is_active', true)),
    ])
    const verified = await exactListingCount(query => query.not('verified_at', 'is', null))
    return { total, active, inactive: Math.max(0, total - active), verified, as_of: nowIso() }
  })
}

export function getSettlementSnapshot() {
  return withOperationsTtl<OperationsSnapshotDto>('settlement-snapshot-v1', OPERATIONS_TTL.settlementSnapshot, async () => {
    const db = createServiceClient()
    const result = await runAdminDbRead(() => db.from('x402_settlement_attempts')
      .select('state, delivery_state', { count: 'exact' })
      .limit(SNAPSHOT_ROW_LIMIT) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
    if (result.error || result.count === null || result.count === undefined) dbFailure('settlement_snapshot', result.error)
    if (result.count > SNAPSHOT_ROW_LIMIT) throw new Error('settlement_snapshot_capacity_exceeded')
    const rows = result.data ?? []
    return {
      settlement: countStates(rows, 'state', settlementStates),
      delivery: countStates(rows, 'delivery_state', deliveryStates),
      total: result.count,
      as_of: nowIso(),
    }
  })
}

export function joinedListing(value: unknown): { id: string; name: string } | null {
  const candidate = Array.isArray(value) ? value[0] : value
  if (!candidate || typeof candidate !== 'object') return null
  const row = candidate as Record<string, unknown>
  const id = safeId(row.id)
  return id ? { id, name: safeText(row.name, 120, 'Unnamed listing') } : null
}

function recentPayment(row: Record<string, unknown>): RecentPaymentDto | null {
  const id = safeId(row.id)
  if (!id) return null
  const listingId = safeId(row.api_id)
  const relation = joinedListing(row.api_listings)
  const binding = row.binding && typeof row.binding === 'object' && !Array.isArray(row.binding)
    ? row.binding as Record<string, unknown> : null
  const state = safeState(row.state, settlementStates)
  return {
    id,
    listing: relation ?? (listingId ? { id: listingId, name: 'Listing' } : null),
    payer: maskWallet(binding?.payer),
    seller: maskWallet(binding?.seller),
    settlement_state: state,
    accounting_state: state === 'ACCOUNTING_COMPLETE' ? 'ACCOUNTING_COMPLETE' : safeId(row.purchase_id) ? 'PURCHASE_LINKED' : 'NOT_RECORDED',
    delivery_state: safeState(row.delivery_state, deliveryStates),
    purchase_id: safeId(row.purchase_id),
    evidence_id: safeEvidence(row.transaction_id),
    buyer_charge_usdc: atomicUsdc(binding?.amount_atomic),
    seller_share_usdc: atomicUsdc(binding?.seller_atomic),
    created_at: safeTimestamp(row.created_at),
    updated_at: safeTimestamp(row.updated_at),
    delivery_http_status: safeHttpStatus(row.delivery_http_status),
    delivery_error_code: safeCode(row.delivery_error_code),
    reason_code: typeof row.reason === 'string' && paymentReasons.has(row.reason) ? row.reason : null,
  }
}

function atomicUsdc(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) return null
  try {
    const atomic = BigInt(value)
    const scale = BigInt(1_000_000)
    const whole = atomic / scale
    const fraction = (atomic % scale).toString().padStart(6, '0')
    return `${whole}.${fraction}`
  } catch { return null }
}

export function parseOperationsLimit(url: URL): number | null {
  const limit = Number(url.searchParams.get('limit') ?? OPERATIONS_DEFAULT_LIMIT)
  return Number.isInteger(limit) && limit >= 1 && limit <= OPERATIONS_MAX_LIMIT ? limit : null
}

export function getRecentPayments(limit = RECENT_PAYMENT_LIMIT) {
  return withOperationsTtl<RecentPaymentsDto>(`recent-payments-v2:${limit}`, OPERATIONS_TTL.recentPayments, async () => {
    const db = createServiceClient()
    const result = await runAdminDbRead(() => db.from('x402_settlement_attempts')
      .select('id, api_id, state, purchase_id, transaction_id, reason, created_at, updated_at, delivery_state, delivery_http_status, delivery_error_code, binding, api_listings(id, name)')
      .order('created_at', { ascending: false })
      .limit(limit) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
    if (result.error) dbFailure('recent_payments', result.error)
    return { payments: (result.data ?? []).flatMap(row => recentPayment(row) ?? []), limit, as_of: nowIso() }
  })
}

type ContractFailure = Extract<RequestContractValidation, { ok: false }>
const contractReasons: Record<ContractFailure['field'], { code: string; message: string }> = {
  method: { code: 'invalid_method', message: 'The configured HTTP method is not supported.' },
  dynamic_path_supported: { code: 'invalid_dynamic_path_configuration', message: 'Dynamic path configuration is invalid.' },
  path_parameters: { code: 'invalid_path_parameters', message: 'Path parameter declarations are invalid or incomplete.' },
  query_parameters: { code: 'invalid_query_parameters', message: 'Query parameter declarations are invalid or incomplete.' },
  example_request: { code: 'invalid_example_request', message: 'The representative request is invalid or incomplete.' },
  body_required: { code: 'invalid_body_configuration', message: 'Request body requirements are inconsistent.' },
  auth_param_name: { code: 'invalid_auth_parameter_configuration', message: 'Credential parameter configuration is invalid.' },
  endpoint_url: { code: 'invalid_endpoint_configuration', message: 'The endpoint configuration is invalid.' },
}

type ListingRow = Record<string, unknown> & {
  id: string
  endpoint_url: string
  encrypted_key: string | null
  verified_at: string | null
}

export function listingOperationsDto(row: ListingRow): OperationsListingDto | null {
  const id = safeId(row.id)
  if (!id) return null
  const validation = validateListingRequestContract(row)
  const contract: ListingContractStatus = validation.ok ? { status: 'VALID', reason_code: null, reason: null } : {
    status: 'INVALID', reason_code: contractReasons[validation.field].code, reason: contractReasons[validation.field].message,
  }
  const active = row.is_active === true
  const discovery = !active
    ? { status: 'EXCLUDED' as const, reason_code: 'inactive_listing', reason: 'Listing is inactive.' }
    : contract.status === 'INVALID'
      ? { status: 'EXCLUDED' as const, reason_code: contract.reason_code, reason: contract.reason }
      : { status: 'VISIBLE' as const, reason_code: null, reason: null }
  const execution = contract.status === 'INVALID'
    ? { status: 'BLOCKED' as const, reason_code: 'invalid_contract', reason: 'The request contract is invalid.' }
    : !active
      ? { status: 'BLOCKED' as const, reason_code: 'inactive_listing', reason: 'Listing is inactive.' }
      : !credentialProxyAllowed(row)
        ? { status: 'BLOCKED' as const, reason_code: 'verification_required', reason: 'Credentialed execution requires verification.' }
        : { status: 'ELIGIBLE' as const, reason_code: null, reason: null }
  const score = Number(row.score)
  const price = typeof row.price_per_call === 'number' || typeof row.price_per_call === 'string'
    ? String(row.price_per_call) : null
  return {
    id,
    name: safeText(row.name, 120, 'Unnamed listing'),
    category: safeText(row.category, 80, 'Uncategorized'),
    price_per_call: price && /^\d+(?:\.\d{1,12})?$/.test(price) ? price : null,
    seller_wallet: maskWallet(row.seller_wallet),
    active,
    verified: row.verified_at != null,
    source: safeText(row.source, 40, 'unknown'),
    score: Number.isFinite(score) ? score : null,
    contract,
    discovery,
    execution,
  }
}

export function maskWallet(value: unknown) {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value)) return 'Unavailable'
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

export type ListingsQuery = {
  page: number
  pageSize: number
  status: ListingStatusFilter
  verification: VerificationFilter
  source: string | null
}

export function parseListingsQuery(url: URL): ListingsQuery | null {
  const page = Number(url.searchParams.get('page') ?? 1)
  const pageSize = Number(url.searchParams.get('page_size') ?? LISTINGS_DEFAULT_PAGE_SIZE)
  const status = url.searchParams.get('status') ?? 'all'
  const verification = url.searchParams.get('verification') ?? 'all'
  const rawSource = url.searchParams.get('source')
  const source = rawSource && rawSource !== 'all' ? rawSource : null
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > LISTINGS_MAX_PAGE_SIZE) return null
  if (!['all', 'active', 'inactive'].includes(status) || !['all', 'verified', 'unverified'].includes(verification)) return null
  if (source !== null && !/^[A-Za-z0-9_.-]{1,40}$/.test(source)) return null
  if ((page - 1) * pageSize > LISTINGS_MAX_OFFSET) return null
  return { page, pageSize, status: status as ListingStatusFilter, verification: verification as VerificationFilter, source }
}

export async function getOperationsListings(input: ListingsQuery): Promise<OperationsListingsDto> {
  const db = createServiceClient()
  const from = (input.page - 1) * input.pageSize
  let query = db.from('api_listings').select(
    'id, name, category, price_per_call, seller_wallet, is_active, verified_at, source, score, endpoint_url, method, auth_type, auth_param_name, encrypted_key, example_request, body_required, dynamic_path_supported, path_parameters, query_parameters',
    { count: 'exact' },
  )
  if (input.status !== 'all') query = query.eq('is_active', input.status === 'active')
  if (input.verification === 'verified') query = query.not('verified_at', 'is', null)
  if (input.verification === 'unverified') query = query.is('verified_at', null)
  if (input.source) query = query.eq('source', input.source)
  const result = await runAdminDbRead(() => query.order('created_at', { ascending: false })
    .range(from, from + input.pageSize - 1) as PromiseLike<QueryResult<ListingRow[]>>) as QueryResult<ListingRow[]>
  if (result.error || result.count === null || result.count === undefined) dbFailure('listings', result.error)
  const listings = (result.data ?? []).flatMap(row => listingOperationsDto(row) ?? [])
  return {
    listings,
    pagination: { page: input.page, page_size: input.pageSize, total: result.count, total_pages: Math.ceil(result.count / input.pageSize) },
    filters: { status: input.status, verification: input.verification, source: input.source },
    as_of: nowIso(),
  }
}
