import 'server-only'

import { ARC } from '@/lib/arc'
import { verifyPlatformWalletConfiguration } from '@/lib/platform-wallet-config'
import { createServiceClient } from '@/lib/supabase/server'
import { withOperationsTtl } from './operations-cache'
import { runAdminDbRead } from './operations-data'
import { formatUsdcMicros, knownSellerLiabilities, usdcMicros } from './gateway-treasury-calculation'
import type { GatewayTreasuryDto } from './operations-types'

const TIMEOUT_MS = 8_000
const PAGE_SIZE = 500
const MAX_PAGES = 20
const TTL_MS = 60_000
type Result<T> = { data: T[] | null; error: { message?: string } | null }
type Purchase = { seller_share_usdc: string | number | null }
type Withdrawal = { amount_usdc: string | number; status: string }

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
  readLedger?: () => Promise<{ purchases: Purchase[]; withdrawals: Withdrawal[] }>
  now?: () => Date
}

async function defaultReadLedger() {
  const db = createServiceClient()
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const [purchases, withdrawals] = await Promise.all([
    readPages<Purchase>((from, to) => db.from('purchases').select('seller_share_usdc')
      .order('id').range(from, to).abortSignal(signal), signal),
    readPages<Withdrawal>((from, to) => db.from('seller_withdrawals').select('amount_usdc, status')
      .order('id').range(from, to).abortSignal(signal), signal),
  ])
  return { purchases, withdrawals }
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
  return {
    depositor: wallet,
    total_balance_usdc: formatUsdcMicros(balance.available + balance.withdrawing),
    available_balance_usdc: formatUsdcMicros(balance.available),
    withdrawing_usdc: formatUsdcMicros(balance.withdrawing),
    pending_batch_usdc: balance.pendingBatch,
    known_seller_liabilities_usdc: formatUsdcMicros(known.outstandingMicros),
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
  return withOperationsTtl(`gateway-treasury-v1:${wallet.toLowerCase()}`, TTL_MS, () => readGatewayTreasury(dependencies))
}
