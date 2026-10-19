/** Ledger observations only; historical purchases and uncertain payouts remain unresolved. */
export function usdcMicros(value: unknown): bigint {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) throw new Error('Invalid treasury ledger amount')
  return BigInt(match[1]) * BigInt(1_000_000) + BigInt((match[2] ?? '').padEnd(6, '0'))
}

export function formatUsdcMicros(value: bigint): string {
  if (value < BigInt(0)) throw new Error('Negative treasury ledger amount')
  return `${value / BigInt(1_000_000)}.${String(value % BigInt(1_000_000)).padStart(6, '0')}`
}

export function knownSellerLiabilities(
  purchases: Array<{ seller_share_usdc: string | number | null }>,
  withdrawals: Array<{ amount_usdc: string | number; status: string }>,
) {
  let recordedShares = BigInt(0)
  let historicalUnallocatedPurchases = 0
  for (const purchase of purchases) {
    if (purchase.seller_share_usdc === null) historicalUnallocatedPurchases += 1
    else recordedShares += usdcMicros(purchase.seller_share_usdc)
  }

  let completedWithdrawals = BigInt(0)
  let unresolvedWithdrawals = 0
  for (const withdrawal of withdrawals) {
    if (withdrawal.status === 'minted') completedWithdrawals += usdcMicros(withdrawal.amount_usdc)
    else if (['pending_mint', 'submission_unknown', 'mint_unknown', 'failed'].includes(withdrawal.status)) {
      usdcMicros(withdrawal.amount_usdc)
      unresolvedWithdrawals += 1
    } else if (withdrawal.status !== 'expired') throw new Error('Unknown seller withdrawal state')
  }
  if (completedWithdrawals > recordedShares) throw new Error('Seller ledger exceeds recorded shares')
  return { outstandingMicros: recordedShares - completedWithdrawals, historicalUnallocatedPurchases, unresolvedWithdrawals }
}
