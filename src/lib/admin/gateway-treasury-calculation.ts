/** Exact recorded amounts; availability is checked independently of commission accrual. */
export const PLATFORM_COMMISSION_DESTINATION = '0x052650D1764406d702252B20B2294346A594A1ef'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
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

export type PlatformWithdrawal = { amount_usdc: string | number; status: string }

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
      binding.pay_to !== PLATFORM_COMMISSION_DESTINATION.toLowerCase() || binding.asset !== ARC_USDC ||
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

/** Reservations remain consumed until a definitive Gateway rejection is recorded. */
export function recordedPlatformCommission(
  purchases: CommissionPurchase[], settlements: CommissionSettlement[], withdrawals: PlatformWithdrawal[],
) {
  const gross = recordedGrossCommission(purchases, settlements)
  let completed = BigInt(0)
  let reserved = BigInt(0)
  let accountingIssues = gross.accountingIssues
  for (const withdrawal of withdrawals) {
    const amount = usdcMicros(withdrawal.amount_usdc)
    if (withdrawal.status === 'minted') completed += amount
    else if (['reserved', 'preparing', 'submission_unknown', 'pending_mint', 'mint_unknown', 'failed'].includes(withdrawal.status)) {
      reserved += amount
    } else if (withdrawal.status !== 'expired') accountingIssues += 1
  }
  const remaining = gross.completedArc - completed - reserved
  if (remaining < BigInt(0)) accountingIssues += 1
  return { ...gross, accrued: gross.completedArc, completed, reserved,
    remaining: remaining < BigInt(0) ? BigInt(0) : remaining, accountingIssues }
}

/** Confirmed payments awaiting accounting remain liabilities; unknown attempts are not confirmed debt. */
export function confirmedSettlementReserve(purchases: CommissionPurchase[], settlements: CommissionSettlement[]): bigint | null {
  let reserve = BigInt(0)
  for (const row of settlements) {
    if (row.state !== 'SETTLEMENT_CONFIRMED') continue
    const binding = row.binding
    const amount = atomic(binding?.amount_atomic)
    const seller = atomic(binding?.seller_atomic)
    const platform = atomic(binding?.platform_atomic)
    if (binding?.network !== 'eip155:5042' || amount === null || seller === null || platform === null ||
      binding.pay_to !== PLATFORM_COMMISSION_DESTINATION.toLowerCase() || binding.asset !== ARC_USDC ||
      seller <= BigInt(0) || amount !== seller + platform) return null
    const linked = purchases.filter(purchase => purchase.settlement_attempt_id === row.id || purchase.id === row.purchase_id)
    if (linked.length > 1 || (linked.length === 1 &&
      (linked[0].seller_share_usdc === null || usdcMicros(linked[0].seller_share_usdc) !== seller))) return null
    if (linked.length === 0) reserve += seller
  }
  return reserve
}

/** Shared display/authorization formula. Legacy per-purchase payouts are not made payable again. */
export function commissionAllowance(
  purchases: CommissionPurchase[], settlements: CommissionSettlement[],
  sellerWithdrawals: Array<{ amount_usdc: string | number; status: string }>,
  platformWithdrawals: PlatformWithdrawal[], available: bigint,
) {
  const commission = recordedPlatformCommission(purchases, settlements, platformWithdrawals)
  const seller = knownSellerLiabilities(purchases, sellerWithdrawals)
  const confirmedReserve = confirmedSettlementReserve(purchases, settlements)
  const activePlatform = platformWithdrawals.some(row =>
    ['reserved', 'preparing', 'submission_unknown', 'pending_mint', 'mint_unknown', 'failed'].includes(row.status))
  let blockReason: string | null = commission.accountingIssues > 0 ? 'Commission accounting needs reconciliation.' :
    confirmedReserve === null ? 'Confirmed seller liabilities need reconciliation.' :
    activePlatform ? 'A platform withdrawal needs reconciliation.' :
    seller.unresolvedWithdrawals > 0 ? 'Seller withdrawals need reconciliation.' : null
  let allowance: bigint | null = null
  if (blockReason === null && confirmedReserve !== null) {
    const liquidity = available - seller.outstandingMicros - confirmedReserve - commission.reserved
    allowance = liquidity <= BigInt(0) ? BigInt(0) :
      liquidity < commission.remaining ? liquidity : commission.remaining
    if (allowance === BigInt(0)) blockReason = commission.remaining === BigInt(0) ?
      'No recorded durable commission remains.' :
      'Available Gateway funds are reserved for confirmed seller liabilities and platform withdrawals.'
  }
  return { commission, seller, confirmedReserve, allowance, blockReason }
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
