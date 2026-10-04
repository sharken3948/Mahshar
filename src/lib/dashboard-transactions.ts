import 'server-only'

import { arcMainnet } from '@/lib/chains'
import { createServiceClient } from '@/lib/supabase/server'

export const TRANSACTION_DEFAULT_LIMIT = 25
export const TRANSACTION_MAX_LIMIT = 50
export const TRANSACTION_MAX_PAGE = 10
const MAX_SELLER_LISTINGS = 500
const LISTING_QUERY_CHUNK = 100

export type TransactionFilter = 'all' | 'purchases' | 'earnings' | 'withdrawals'
export type TransactionType = 'api_purchase' | 'seller_earning' | 'withdrawal'
export type TransactionRole = 'buyer' | 'seller'

export type TransactionRecord = {
  id: string
  type: TransactionType
  role: TransactionRole
  title: string
  apiName?: string
  amountUsdc: string
  amountDirection: 'inflow' | 'outflow' | 'neutral'
  netAmountUsdc?: string
  grossAmountUsdc?: string
  sellerShareUsdc?: string
  platformShareUsdc?: string
  status: string
  paymentStatus?: string
  deliveryStatus?: string
  deliveryHttpStatus?: number
  occurredAt: string
  completedAt?: string
  purchaseId?: string
  settlementReference?: string
  settlementReferenceLabel?: 'Settlement Reference' | 'Withdrawal Reference'
  onchainTransaction?: {
    hash: string
    explorerUrl: string
    network: 'Arc Mainnet'
  }
}

export type TransactionHistory = {
  records: TransactionRecord[]
  page: number
  limit: number
  maxPage: number
  maxAccessibleRecords: number
  hasMore: boolean
  summary: {
    visibleCount: number
    visibleSpentUsdc: string | null
    visibleEarnedUsdc: string | null
    lastActivity: { type: TransactionType; occurredAt: string } | null
  }
  degradedSources: Array<'purchases' | 'earnings' | 'withdrawals' | 'settlement_details'>
  limitations: Array<'seller_listing_cap'>
  asOf: string
}

type DbError = { message?: string } | null
type QueryResult<T> = { data: T | null; error: DbError }
type Row = Record<string, unknown>
type Database = ReturnType<typeof createServiceClient>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/
const WALLET = /^0x[0-9a-f]{40}$/
const SAFE_REFERENCE = /^[\x20-\x7e]{1,512}$/
const USDC_MICROS = BigInt(1_000_000)
const ZERO = BigInt(0)

function safeId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function safeText(value: unknown, fallback: string, max = 160): string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : fallback
}

function safeReference(value: unknown): string | null {
  return typeof value === 'string' && SAFE_REFERENCE.test(value) ? value : null
}

function decimalMicros(value: unknown): bigint | null {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return null
  return BigInt(match[1]) * USDC_MICROS + BigInt((match[2] ?? '').padEnd(6, '0'))
}

function microsDecimal(value: bigint): string {
  const whole = value / USDC_MICROS
  const fraction = (value % USDC_MICROS).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function safeDecimal(value: unknown): string | null {
  const micros = decimalMicros(value)
  return micros === null ? null : microsDecimal(micros)
}

function joinedRow(value: unknown): Row | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' ? candidate as Row : null
}

export function isArcTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && EVM_TRANSACTION_HASH.test(value)
}

export function arcTransaction(hash: unknown): TransactionRecord['onchainTransaction'] | undefined {
  if (!isArcTransactionHash(hash)) return undefined
  return {
    hash,
    explorerUrl: `${arcMainnet.blockExplorers.default.url}/tx/${hash}`,
    network: 'Arc Mainnet',
  }
}

function settlementStatus(attempt: Row | null): string {
  const state = attempt?.state
  if (state === 'ACCOUNTING_COMPLETE') return 'Settled'
  if (state === 'SETTLEMENT_CONFIRMED') return 'Settlement confirmed'
  if (state === 'SETTLEMENT_SUBMITTED') return 'Settlement submitted'
  if (state === 'SETTLEMENT_UNKNOWN') return 'Settlement unknown'
  if (state === 'MANUAL_REVIEW') return 'Needs review'
  if (state === 'PREPARED') return 'Prepared'
  return 'Recorded'
}

function deliveryStatus(attempt: Row | null): string | undefined {
  const state = attempt?.delivery_state
  if (state === 'SUCCEEDED') return 'Succeeded'
  if (state === 'FAILED_FINAL') return 'Failed'
  if (state === 'FAILED_RETRYABLE') return 'Retryable failure'
  if (state === 'IN_PROGRESS') return 'In progress'
  if (state === 'NOT_STARTED') return 'Not started'
  if (state === 'UNKNOWN') return 'Unknown'
  return undefined
}

function withdrawalStatus(value: unknown): string {
  if (value === 'minted') return 'Completed'
  if (value === 'pending_mint') return 'Pending'
  if (value === 'submission_unknown' || value === 'mint_unknown') return 'Still confirming'
  if (value === 'expired') return 'Expired'
  if (value === 'failed') return 'Failed'
  return 'Unknown'
}

function referenceForPurchase(row: Row, attempt: Row | null) {
  const settlementIdentity = safeReference(attempt?.settlement_identity)
  const transactionId = safeReference(attempt?.transaction_id)
  const purchaseReference = safeReference(row.tx_hash)
  const reference = settlementIdentity ?? (transactionId && !isArcTransactionHash(transactionId) ? transactionId : null)
    ?? (purchaseReference && !isArcTransactionHash(purchaseReference) ? purchaseReference : null)
  return reference ?? undefined
}

export function purchaseTransaction(row: Row, attempt: Row | null = null): TransactionRecord | null {
  const purchaseId = safeId(row.id)
  const occurredAt = safeTimestamp(row.created_at)
  const amountUsdc = safeDecimal(row.amount_usdc)
  if (!purchaseId || !occurredAt || amountUsdc === null) return null
  const listing = joinedRow(row.api_listings)
  const transaction = arcTransaction(attempt?.transaction_id) ?? arcTransaction(row.tx_hash)
  const reference = referenceForPurchase(row, attempt)
  const httpStatus = Number(attempt?.delivery_http_status)
  return {
    id: `purchase:${purchaseId}`,
    type: 'api_purchase',
    role: 'buyer',
    title: safeText(listing?.name, 'API purchase'),
    apiName: safeText(listing?.name, 'API purchase'),
    amountUsdc,
    amountDirection: 'outflow',
    status: settlementStatus(attempt),
    paymentStatus: settlementStatus(attempt),
    deliveryStatus: deliveryStatus(attempt),
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { deliveryHttpStatus: httpStatus } : {}),
    occurredAt,
    purchaseId,
    ...(reference ? { settlementReference: reference, settlementReferenceLabel: 'Settlement Reference' as const } : {}),
    ...(transaction ? { onchainTransaction: transaction } : {}),
  }
}

export function earningTransaction(row: Row, attempt: Row | null = null): TransactionRecord | null {
  const purchaseId = safeId(row.id)
  const occurredAt = safeTimestamp(row.created_at)
  const sellerShareUsdc = safeDecimal(row.seller_share_usdc)
  const grossAmountUsdc = safeDecimal(row.amount_usdc)
  if (!purchaseId || !occurredAt || sellerShareUsdc === null || grossAmountUsdc === null) return null
  const gross = decimalMicros(grossAmountUsdc)!
  const seller = decimalMicros(sellerShareUsdc)!
  if (seller > gross) return null
  const listing = joinedRow(row.api_listings)
  const transaction = arcTransaction(attempt?.transaction_id) ?? arcTransaction(row.tx_hash)
  const reference = referenceForPurchase(row, attempt)
  return {
    id: `earning:${purchaseId}`,
    type: 'seller_earning',
    role: 'seller',
    title: safeText(listing?.name, 'Seller earning'),
    apiName: safeText(listing?.name, 'Seller earning'),
    amountUsdc: sellerShareUsdc,
    amountDirection: 'inflow',
    grossAmountUsdc,
    sellerShareUsdc,
    platformShareUsdc: microsDecimal(gross - seller),
    status: 'Accounted',
    paymentStatus: settlementStatus(attempt),
    deliveryStatus: deliveryStatus(attempt),
    occurredAt,
    purchaseId,
    ...(reference ? { settlementReference: reference, settlementReferenceLabel: 'Settlement Reference' as const } : {}),
    ...(transaction ? { onchainTransaction: transaction } : {}),
  }
}

export function withdrawalTransaction(row: Row): TransactionRecord | null {
  const id = safeId(row.id)
  const occurredAt = safeTimestamp(row.created_at)
  const amountUsdc = safeDecimal(row.amount_usdc)
  if (!id || !occurredAt || amountUsdc === null) return null
  const completedAt = safeTimestamp(row.minted_at) ?? undefined
  const transaction = arcTransaction(row.mint_tx_hash)
  const status = withdrawalStatus(row.status)
  const netAmountUsdc = safeDecimal(row.net_amount_usdc)
  const fallbackReference = safeReference(row.gateway_transfer_id)
    ?? (!transaction ? safeReference(row.mint_tx_hash) : null)
  return {
    id: `withdrawal:${id}`,
    type: 'withdrawal',
    role: 'seller',
    title: 'Seller withdrawal',
    amountUsdc,
    amountDirection: status === 'Completed' ? 'outflow' : 'neutral',
    ...(netAmountUsdc ? { netAmountUsdc } : {}),
    status,
    occurredAt,
    ...(completedAt ? { completedAt } : {}),
    ...(fallbackReference ? { settlementReference: fallbackReference, settlementReferenceLabel: 'Withdrawal Reference' as const } : {}),
    ...(transaction ? { onchainTransaction: transaction } : {}),
  }
}

export function sortTransactionRecords(records: TransactionRecord[]) {
  return [...records].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
}

export function transactionSummary(records: TransactionRecord[]): TransactionHistory['summary'] {
  let spent = ZERO
  let earned = ZERO
  for (const record of records) {
    const amount = decimalMicros(record.amountUsdc)
    if (amount === null) continue
    if (record.type === 'api_purchase') spent += amount
    if (record.type === 'seller_earning') earned += amount
  }
  return {
    visibleCount: records.length,
    visibleSpentUsdc: records.some(record => record.type === 'api_purchase') ? microsDecimal(spent) : null,
    visibleEarnedUsdc: records.some(record => record.type === 'seller_earning') ? microsDecimal(earned) : null,
    lastActivity: records[0] ? { type: records[0].type, occurredAt: records[0].occurredAt } : null,
  }
}

export function transactionQuery(input: URLSearchParams) {
  const rawFilter = input.get('filter')
  const filter: TransactionFilter = rawFilter && ['all', 'purchases', 'earnings', 'withdrawals'].includes(rawFilter)
    ? rawFilter as TransactionFilter : 'all'
  const rawLimit = Number(input.get('limit') ?? TRANSACTION_DEFAULT_LIMIT)
  const rawPage = Number(input.get('page') ?? 1)
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), TRANSACTION_MAX_LIMIT) : TRANSACTION_DEFAULT_LIMIT
  const page = Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 1), TRANSACTION_MAX_PAGE) : 1
  return { filter, limit, page }
}

async function safeQuery<T>(run: () => PromiseLike<QueryResult<T>>): Promise<QueryResult<T>> {
  try { return await run() } catch { return { data: null, error: { message: 'unavailable' } } }
}

export async function getWalletTransactions(
  authenticatedWallet: string,
  query: { filter: TransactionFilter; limit: number; page: number },
  db: Database = createServiceClient(),
): Promise<TransactionHistory> {
  const wallet = authenticatedWallet.toLowerCase()
  if (!WALLET.test(wallet)) throw new Error('invalid_authenticated_wallet')
  const { filter, limit, page } = query
  const sourceLimit = Math.min(page * limit + 1, TRANSACTION_MAX_PAGE * TRANSACTION_MAX_LIMIT + 1)
  const needsPurchases = filter === 'all' || filter === 'purchases'
  const needsEarnings = filter === 'all' || filter === 'earnings'
  const needsWithdrawals = filter === 'all' || filter === 'withdrawals'

  const [buyerResult, listingsResult, withdrawalsResult] = await Promise.all([
    needsPurchases ? safeQuery<Row[]>(() => db.from('purchases')
      .select('id, api_id, buyer_wallet, amount_usdc, seller_share_usdc, tx_hash, settlement_attempt_id, created_at, api_listings(name)')
      .eq('buyer_wallet', wallet).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(sourceLimit)) : Promise.resolve({ data: [], error: null }),
    needsEarnings ? safeQuery<Row[]>(() => db.from('api_listings').select('id, name').ilike('seller_wallet', wallet).limit(MAX_SELLER_LISTINGS + 1)) : Promise.resolve({ data: [], error: null }),
    needsWithdrawals ? safeQuery<Row[]>(() => db.from('seller_withdrawals')
      .select('id, seller_wallet, amount_usdc, net_amount_usdc, gas_cost_usdc, status, mint_tx_hash, gateway_transfer_id, created_at, minted_at')
      .ilike('seller_wallet', wallet).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(sourceLimit)) : Promise.resolve({ data: [], error: null }),
  ])

  const degraded = new Set<TransactionHistory['degradedSources'][number]>()
  const limitations = new Set<TransactionHistory['limitations'][number]>()
  if (buyerResult.error) degraded.add('purchases')
  if (listingsResult.error) degraded.add('earnings')
  if (withdrawalsResult.error) degraded.add('withdrawals')

  const listings = (listingsResult.data ?? []).slice(0, MAX_SELLER_LISTINGS)
  if ((listingsResult.data?.length ?? 0) > MAX_SELLER_LISTINGS) limitations.add('seller_listing_cap')
  const listingIds = listings.flatMap(row => safeId(row.id) ?? [])
  const nameByListing = new Map(listings.flatMap(row => {
    const id = safeId(row.id)
    return id ? [[id, safeText(row.name, 'Seller earning')] as const] : []
  }))
  let earningsResult: QueryResult<Row[]> = { data: [], error: null }
  if (needsEarnings && !listingsResult.error && listingIds.length > 0) {
    const chunks = Array.from({ length: Math.ceil(listingIds.length / LISTING_QUERY_CHUNK) }, (_, index) =>
      listingIds.slice(index * LISTING_QUERY_CHUNK, (index + 1) * LISTING_QUERY_CHUNK))
    const results = await Promise.all(chunks.map(ids => safeQuery<Row[]>(() => db.from('purchases')
      .select('id, api_id, amount_usdc, seller_share_usdc, tx_hash, settlement_attempt_id, created_at')
      .in('api_id', ids).not('seller_share_usdc', 'is', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(sourceLimit))))
    if (results.some(result => result.error)) degraded.add('earnings')
    earningsResult = { data: results.flatMap(result => result.data ?? []), error: null }
  }

  const purchaseRows: Row[] = (buyerResult.data ?? []).map(row => ({ ...row, __kind: 'purchase' }))
  const earningRows: Row[] = (earningsResult.data ?? []).map(row => ({
    ...row,
    __kind: 'earning',
    api_listings: { name: nameByListing.get(String(row.api_id).toLowerCase()) ?? 'Seller earning' },
  }))
  const withdrawalRows: Row[] = (withdrawalsResult.data ?? []).map(row => ({ ...row, __kind: 'withdrawal' }))
  const preliminary = sortTransactionRecords([
    ...purchaseRows.flatMap(row => purchaseTransaction(row) ?? []),
    ...earningRows.flatMap(row => earningTransaction(row) ?? []),
    ...withdrawalRows.flatMap(row => withdrawalTransaction(row) ?? []),
  ])
  const offset = (page - 1) * limit
  const selected = preliminary.slice(offset, offset + limit)
  const selectedPurchaseIds = new Set(selected.flatMap(record => record.purchaseId ?? []))
  const selectedRows = [...purchaseRows, ...earningRows].filter(row => selectedPurchaseIds.has(String(row.id).toLowerCase()))
  const attemptIds = [...new Set(selectedRows.flatMap(row => safeId(row.settlement_attempt_id) ?? []))]
  let attempts = new Map<string, Row>()
  if (attemptIds.length > 0) {
    const attemptResult = await safeQuery<Row[]>(() => db.from('x402_settlement_attempts')
      .select('id, state, transaction_id, settlement_identity, delivery_state, delivery_http_status')
      .in('id', attemptIds).limit(TRANSACTION_MAX_LIMIT))
    if (attemptResult.error) degraded.add('settlement_details')
    else attempts = new Map((attemptResult.data ?? []).flatMap(row => {
      const id = safeId(row.id)
      return id ? [[id, row] as const] : []
    }))
  }
  const rowByRecordId = new Map<string, Row>([
    ...purchaseRows.map(row => [`purchase:${String(row.id).toLowerCase()}`, row] as const),
    ...earningRows.map(row => [`earning:${String(row.id).toLowerCase()}`, row] as const),
  ])
  const records = selected.map(record => {
    const row = rowByRecordId.get(record.id)
    if (!row) return record
    const attempt = attempts.get(String(row.settlement_attempt_id).toLowerCase()) ?? null
    return record.type === 'api_purchase' ? purchaseTransaction(row, attempt)! : earningTransaction(row, attempt)!
  })

  return {
    records,
    page,
    limit,
    maxPage: TRANSACTION_MAX_PAGE,
    maxAccessibleRecords: TRANSACTION_MAX_PAGE * limit,
    hasMore: page < TRANSACTION_MAX_PAGE && preliminary.length > offset + limit,
    summary: transactionSummary(records),
    degradedSources: [...degraded],
    limitations: [...limitations],
    asOf: new Date().toISOString(),
  }
}
