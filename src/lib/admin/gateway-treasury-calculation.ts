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

export type CommissionPurchase = {
  id: string; api_id: string; buyer_wallet: string; amount_usdc: string | number;
  seller_share_usdc: string | number | null; tx_hash: string | null; settlement_attempt_id: string | null
}

export type CommissionSettlement = {
  id: string; api_id: string; fingerprint: string; authorization_key: string;
  state: string; purchase_id: string | null; settlement_identity: string | null;
  binding: Record<string, unknown> | null
}

function atomic(value: unknown): bigint | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? BigInt(value) : null
}

/** Keep durable Arc accrual separate from older purchases without settlement bindings. */
export function recordedGrossCommission(purchases: CommissionPurchase[], settlements: CommissionSettlement[]) {
  const byPurchase = new Map(purchases.map(purchase => [purchase.id, purchase]))
  const candidates: Array<{ amount: bigint; keys: string[] }> = []
  let accountingIssues = 0

  for (const attempt of settlements) {
    if (attempt.state !== 'ACCOUNTING_COMPLETE' || attempt.binding?.network !== 'eip155:5042') continue
    const binding = attempt.binding
    const purchase = attempt.purchase_id ? byPurchase.get(attempt.purchase_id) : undefined
    const amount = atomic(binding.amount_atomic)
    const seller = atomic(binding.seller_atomic)
    const platform = atomic(binding.platform_atomic)
    const identities = [attempt.id, attempt.purchase_id, attempt.settlement_identity,
      attempt.fingerprint, attempt.authorization_key]
    if (!purchase || amount === null || seller === null || platform === null ||
      seller <= BigInt(0) || amount !== seller + platform ||
      identities.some(value => typeof value !== 'string' || value.length === 0) ||
      binding.fingerprint !== attempt.fingerprint || binding.authorization_key !== attempt.authorization_key ||
      binding.api_id !== attempt.api_id || purchase.api_id !== attempt.api_id ||
      typeof binding.payer !== 'string' || purchase.buyer_wallet.toLowerCase() !== binding.payer ||
      purchase.settlement_attempt_id !== attempt.id || purchase.tx_hash !== attempt.settlement_identity ||
      purchase.seller_share_usdc === null || usdcMicros(purchase.amount_usdc) !== amount ||
      usdcMicros(purchase.seller_share_usdc) !== seller) {
      accountingIssues += 1
      continue
    }
    candidates.push({ amount: platform, keys: (identities as string[])
      .map((value, index) => `${index}:${value}`) })
  }

  const frequency = new Map<string, number>()
  for (const candidate of candidates) for (const key of candidate.keys) {
    frequency.set(key, (frequency.get(key) ?? 0) + 1)
  }
  let completedArc = BigInt(0)
  let completedArcCount = 0
  for (const candidate of candidates) {
    if (candidate.keys.some(key => frequency.get(key) !== 1)) accountingIssues += 1
    else { completedArc += candidate.amount; completedArcCount += 1 }
  }

  const claimedPurchases = new Set(settlements.map(row => row.purchase_id).filter((id): id is string => !!id))
  const claimedIdentities = new Set(settlements.map(row => row.settlement_identity).filter((id): id is string => !!id))
  let historical = BigInt(0)
  let historicalCount = 0
  for (const purchase of purchases) {
    if (purchase.seller_share_usdc === null || purchase.settlement_attempt_id !== null) continue
    if (claimedPurchases.has(purchase.id) || (purchase.tx_hash && claimedIdentities.has(purchase.tx_hash))) {
      accountingIssues += 1
      continue
    }
    const buyerCharge = usdcMicros(purchase.amount_usdc)
    const sellerShare = usdcMicros(purchase.seller_share_usdc)
    if (sellerShare > buyerCharge) throw new Error('Seller share exceeds buyer charge')
    historical += buyerCharge - sellerShare
    historicalCount += 1
  }
  return { completedArc, completedArcCount, historical, historicalCount,
    gross: completedArc + historical, accountingIssues }
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
