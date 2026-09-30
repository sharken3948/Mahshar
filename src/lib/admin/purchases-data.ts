import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { withOperationsTtl } from './operations-cache'
import {
  deliveryStates,
  joinedListing,
  maskWallet,
  runAdminDbRead,
  safeCode,
  safeHttpStatus,
  safeId,
  safeState,
  safeTimestamp,
  settlementStates,
} from './operations-data'
import type { PurchaseCallDto, PurchaseDetailDto, PurchaseDto, PurchasesDto } from './operations-types'

const PURCHASES_TTL_MS = 60_000
const PURCHASE_DETAIL_CALL_LIMIT = 5
type QueryResult<T> = { data: T | null; error: { message?: string } | null }

function safeDecimal(value: unknown): string | null {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text) ? text : null
}

function purchaseListing(value: unknown): { listing: { id: string; name: string } | null; seller: string } {
  const candidate = Array.isArray(value) ? value[0] : value
  if (!candidate || typeof candidate !== 'object') return { listing: null, seller: 'Unavailable' }
  const row = candidate as Record<string, unknown>
  return { listing: joinedListing(row), seller: maskWallet(row.seller_wallet) }
}

function purchaseAttempt(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null
}

export function purchaseDto(row: Record<string, unknown>, attemptValue?: unknown): PurchaseDto | null {
  const id = safeId(row.id)
  if (!id) return null
  const listingId = safeId(row.api_id)
  const relation = purchaseListing(row.api_listings)
  const attemptId = safeId(row.settlement_attempt_id)
  const attempt = purchaseAttempt(attemptValue ?? row.x402_settlement_attempts)
  const sellerShare = safeDecimal(row.seller_share_usdc)
  return {
    id,
    listing: relation.listing ?? (listingId ? { id: listingId, name: 'Listing' } : null),
    buyer: maskWallet(row.buyer_wallet),
    seller: relation.seller,
    buyer_amount_usdc: safeDecimal(row.amount_usdc),
    seller_share_usdc: sellerShare,
    settlement_attempt_id: attemptId,
    settlement_state: attempt ? safeState(attempt.state, settlementStates) : null,
    delivery_state: attempt ? safeState(attempt.delivery_state, deliveryStates) : null,
    delivery_http_status: attempt ? safeHttpStatus(attempt.delivery_http_status) : null,
    delivery_error_code: attempt ? safeCode(attempt.delivery_error_code) : null,
    historical_unlinked: attemptId === null || sellerShare === null,
    created_at: safeTimestamp(row.created_at),
  }
}

export function getPurchases(limit: number): Promise<PurchasesDto> {
  return withOperationsTtl(`purchases-v1:${limit}`, PURCHASES_TTL_MS, async () => {
    const db = createServiceClient()
    const purchasesResult = await runAdminDbRead(() => db.from('purchases')
      .select('id, buyer_wallet, api_id, amount_usdc, seller_share_usdc, settlement_attempt_id, created_at, api_listings(id, name, seller_wallet)')
      .order('created_at', { ascending: false })
      .limit(limit) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
    if (purchasesResult.error) throw new Error('purchases_unavailable')
    const rows = purchasesResult.data ?? []
    const attemptIds = rows.flatMap(row => safeId(row.settlement_attempt_id) ?? [])
    let attempts = new Map<string, Record<string, unknown>>()
    if (attemptIds.length) {
      const attemptsResult = await runAdminDbRead(() => db.from('x402_settlement_attempts')
        .select('id, state, delivery_state, delivery_http_status, delivery_error_code')
        .in('id', attemptIds)
        .limit(limit) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
      if (attemptsResult.error) throw new Error('purchases_unavailable')
      attempts = new Map((attemptsResult.data ?? []).flatMap(row => {
        const id = safeId(row.id)
        return id ? [[id, row] as const] : []
      }))
    }
    return {
      purchases: rows.flatMap(row => purchaseDto(row, attempts.get(String(row.settlement_attempt_id))) ?? []),
      limit,
      as_of: new Date().toISOString(),
    }
  })
}

function purchaseCallDto(row: Record<string, unknown>): PurchaseCallDto | null {
  const id = safeId(row.id)
  if (!id || typeof row.success !== 'boolean') return null
  const latency = Number(row.latency_ms)
  return {
    id,
    success: row.success,
    latency_ms: Number.isInteger(latency) && latency >= 0 && latency <= 120_000 ? latency : null,
    payment_type: typeof row.payment_type === 'string' && ['pay-per-call', 'credits', 'both'].includes(row.payment_type) ? row.payment_type : null,
    created_at: safeTimestamp(row.created_at),
  }
}

export async function getPurchaseDetail(id: string): Promise<PurchaseDetailDto | null> {
  const db = createServiceClient()
  const purchaseResult = await runAdminDbRead(() => db.from('purchases')
    .select('id, buyer_wallet, api_id, amount_usdc, seller_share_usdc, settlement_attempt_id, created_at, api_listings(id, name, seller_wallet), x402_settlement_attempts!purchases_settlement_attempt_id_fkey(id, state, delivery_state, delivery_http_status, delivery_error_code)')
    .eq('id', id).maybeSingle() as PromiseLike<QueryResult<Record<string, unknown>>>) as QueryResult<Record<string, unknown>>
  if (purchaseResult.error) throw new Error('purchase_detail_unavailable')
  if (!purchaseResult.data) return null
  const purchase = purchaseDto(purchaseResult.data)
  if (!purchase) return null
  const callsResult = await runAdminDbRead(() => db.from('api_calls')
    .select('id, success, latency_ms, payment_type, created_at')
    .eq('purchase_id', id)
    .order('created_at', { ascending: false })
    .limit(PURCHASE_DETAIL_CALL_LIMIT) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
  if (callsResult.error) throw new Error('purchase_detail_unavailable')
  return {
    purchase,
    api_calls: (callsResult.data ?? []).flatMap(row => purchaseCallDto(row) ?? []),
    as_of: new Date().toISOString(),
  }
}

export function validPurchaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export const PURCHASE_DETAIL_FIELDS = Object.freeze([
  'id', 'success', 'latency_ms', 'payment_type', 'created_at',
])
