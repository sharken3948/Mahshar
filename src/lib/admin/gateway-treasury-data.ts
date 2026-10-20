import 'server-only'

import { ARC } from '@/lib/arc'
import { verifyPlatformWalletConfiguration } from '@/lib/platform-wallet-config'
import { createServiceClient } from '@/lib/supabase/server'
import { withOperationsTtl } from './operations-cache'
import { runAdminDbRead } from './operations-data'
import { formatUsdcMicros, knownSellerLiabilities, recordedGrossCommission, usdcMicros,
  type CommissionPurchase, type CommissionSettlement } from './gateway-treasury-calculation'
import type { GatewayTreasuryDto } from './operations-types'

const TIMEOUT_MS = 8_000
const PAGE_SIZE = 500
const MAX_PAGES = 20
const TTL_MS = 60_000
type Result<T> = { data: T[] | null; error: { message?: string } | null }
type Purchase = CommissionPurchase
type Withdrawal = { amount_usdc: string | number; status: string }
type Settlement = CommissionSettlement

async function readPages<T>(
  query: (from: number, to: number) => PromiseLike<Result<T>>,
  signal: AbortSignal,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await runAdminDbRead(() => query(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1), signal)
    if (result.error || !result.data) throw new Error('Gateway treasury ledger unavailable')
    rows.push(...result.data)
    if (result.data.length < PAGE_SIZE) return rows
  }
  throw new Error('Gateway treasury ledger exceeds read limit')
}

export type GatewayTreasuryDependencies = {
  platformAddress?: string
  platformPrivateKey?: string
  fetchBalance?: typeof fetch
  readLedger?: () => Promise<{ purchases: Purchase[]; withdrawals: Withdrawal[]; settlements: Settlement[] }>
  now?: () => Date
}

async function defaultReadLedger() {
  const db = createServiceClient()
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const [purchases, withdrawals, settlements] = await Promise.all([
    readPages<Purchase>((from, to) => db.from('purchases')
      .select('id, api_id, buyer_wallet, amount_usdc, seller_share_usdc, tx_hash, settlement_attempt_id')
      .order('id').range(from, to).abortSignal(signal), signal),
    readPages<Withdrawal>((from, to) => db.from('seller_withdrawals').select('amount_usdc, status')
      .order('id').range(from, to).abortSignal(signal), signal),
    readPages<Settlement>((from, to) => db.from('x402_settlement_attempts')
      .select('id, api_id, fingerprint, authorization_key, state, purchase_id, settlement_identity, binding')
      .order('id').range(from, to).abortSignal(signal), signal),
  ])
  return { purchases, withdrawals, settlements }
}

async function readGatewayBalance(wallet: string, fetchBalance: typeof fetch) {
  const response = await fetchBalance(`${ARC.gatewayApi}/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ARC-PRIVATE-MAINNET-ENABLED': 'true' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: wallet, domain: ARC.gatewayDomain }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Gateway balance unavailable')
  }
  const body = await response.json() as { balances?: Array<Record<string, unknown>> }
  if (!Array.isArray(body.balances) || body.balances.length !== 1) throw new Error('Invalid Gateway balance response')
  const balance = body.balances[0]
  if ((balance.depositor !== undefined && String(balance.depositor).toLowerCase() !== wallet.toLowerCase()) ||
    (balance.domain !== undefined && Number(balance.domain) !== ARC.gatewayDomain)) {
    throw new Error('Gateway balance source mismatch')
  }
  const available = usdcMicros(balance.balance)
  const withdrawing = usdcMicros(balance.withdrawing ?? '0')
  const pendingBatch = balance.pendingBatch === undefined || balance.pendingBatch === null
    ? null : formatUsdcMicros(usdcMicros(balance.pendingBatch))
  return { available, withdrawing, pendingBatch }
}

export async function readGatewayTreasury(dependencies: GatewayTreasuryDependencies = {}): Promise<GatewayTreasuryDto> {
  const wallet = verifyPlatformWalletConfiguration({
    address: dependencies.platformAddress, privateKey: dependencies.platformPrivateKey,
  }).address
  const [balance, ledger] = await Promise.all([
    readGatewayBalance(wallet, dependencies.fetchBalance ?? fetch),
    (dependencies.readLedger ?? defaultReadLedger)(),
  ])
  const known = knownSellerLiabilities(ledger.purchases, ledger.withdrawals)
  const commission = recordedGrossCommission(ledger.purchases, ledger.settlements)
  return {
    depositor: wallet,
    total_balance_usdc: formatUsdcMicros(balance.available + balance.withdrawing),
    available_balance_usdc: formatUsdcMicros(balance.available),
    withdrawing_usdc: formatUsdcMicros(balance.withdrawing),
    pending_batch_usdc: balance.pendingBatch,
    known_seller_liabilities_usdc: formatUsdcMicros(known.outstandingMicros),
    completed_arc_commission_usdc: formatUsdcMicros(commission.completedArc),
    completed_arc_purchase_count: commission.completedArcCount,
    historical_calculated_commission_usdc: formatUsdcMicros(commission.historical),
    historical_calculated_purchase_count: commission.historicalCount,
    total_recorded_gross_commission_usdc: formatUsdcMicros(commission.gross),
    safely_withdrawable_usdc: null,
    commission_accounting_issues: commission.accountingIssues,
    unresolved_settlement_attempts: ledger.settlements.filter(row => row.state !== 'ACCOUNTING_COMPLETE').length,
    historical_unallocated_purchases: known.historicalUnallocatedPurchases,
    unresolved_withdrawals: known.unresolvedWithdrawals,
    coverage: balance.available >= known.outstandingMicros ? 'known_covered' : 'known_shortfall',
    ownership: 'verification_pending',
    as_of: (dependencies.now ?? (() => new Date()))().toISOString(),
  }
}

export function getGatewayTreasury(dependencies: GatewayTreasuryDependencies = {}): Promise<GatewayTreasuryDto> {
  const wallet = verifyPlatformWalletConfiguration({
    address: dependencies.platformAddress, privateKey: dependencies.platformPrivateKey,
  }).address
  return withOperationsTtl(`gateway-treasury-v2:${wallet.toLowerCase()}`, TTL_MS, () => readGatewayTreasury(dependencies))
}
