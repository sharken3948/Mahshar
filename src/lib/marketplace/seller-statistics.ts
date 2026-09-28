export interface SellerPurchaseRow {
  id: string
  api_id: string
  amount_usdc: string | number
  seller_share_usdc: string | number | null
}

export interface SellerWithdrawalRow {
  amount_usdc: string | number
  status: string
}

const RESERVED_WITHDRAWAL_STATUSES = new Set([
  'pending_mint', 'submission_unknown', 'mint_unknown', 'minted', 'failed',
])

function usdcMicros(value: string | number): number | null {
  const text = String(value).trim()
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return null
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'))
  return Number.isSafeInteger(micros) ? micros : null
}

function usdcNumber(value: number) {
  return value / 1_000_000
}

/**
 * Derive seller statistics from the immutable purchase ledger.
 *
 * Historical purchases with no seller share contribute to gross revenue and
 * paid-call counts only. They predate accumulated withdrawals and were handled
 * by the former per-purchase payout path, so inferring a new payable share would
 * make previously paid revenue withdrawable a second time.
 */
export function aggregateSellerStatistics(
  purchases: SellerPurchaseRow[],
  withdrawals: SellerWithdrawalRow[],
  apiNames: ReadonlyMap<string, string>,
) {
  const byApi = new Map<string, { api_name: string; totalMicros: number; calls: number }>()
  let grossMicros = 0
  let accumulatedShareMicros = 0

  for (const purchase of purchases) {
    const gross = usdcMicros(purchase.amount_usdc)
    if (gross === null) continue
    const current = byApi.get(purchase.api_id) ?? {
      api_name: apiNames.get(purchase.api_id) ?? 'Unknown',
      totalMicros: 0,
      calls: 0,
    }
    current.totalMicros += gross
    current.calls += 1
    byApi.set(purchase.api_id, current)
    grossMicros += gross

    if (purchase.seller_share_usdc !== null) {
      const share = usdcMicros(purchase.seller_share_usdc)
      if (share !== null) accumulatedShareMicros += share
    }
  }

  let reservedMicros = 0
  for (const withdrawal of withdrawals) {
    if (!RESERVED_WITHDRAWAL_STATUSES.has(withdrawal.status)) continue
    const amount = usdcMicros(withdrawal.amount_usdc)
    if (amount !== null) reservedMicros += amount
  }

  return {
    total_earnings: usdcNumber(grossMicros),
    accumulated_share: usdcNumber(accumulatedShareMicros),
    in_flight_withdrawals: usdcNumber(reservedMicros),
    withdrawable_balance: usdcNumber(accumulatedShareMicros - reservedMicros),
    earnings_by_api: Array.from(byApi.entries()).map(([api_id, value]) => ({
      api_id,
      api_name: value.api_name,
      total: usdcNumber(value.totalMicros),
      calls: value.calls,
    })),
  }
}

export function paidCallCount(earnings: { earnings_by_api: Array<{ calls: number }> } | null) {
  return earnings?.earnings_by_api.reduce((total, api) => total + api.calls, 0) ?? 0
}
