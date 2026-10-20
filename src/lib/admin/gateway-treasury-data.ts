import 'server-only'

import { createPublicClient, http } from 'viem'
import { ARC } from '@/lib/arc'
import { arcMainnet } from '@/lib/chains'
import { verifyPlatformWalletConfiguration } from '@/lib/platform-wallet-config'
import { createServiceClient } from '@/lib/supabase/server'
import { withOperationsTtl } from './operations-cache'
import { runAdminDbRead } from './operations-data'
import { commissionAllowance, formatUsdcMicros, usdcMicros,
  type CommissionPurchase, type CommissionSettlement, type PlatformWithdrawal } from './gateway-treasury-calculation'
import type { GatewayTreasuryDto } from './operations-types'
import { hasArcMintGas, quoteCommission, type CommissionQuote } from './commission-withdrawal'

const TIMEOUT_MS = 8_000
const PAGE_SIZE = 500
const MAX_PAGES = 20
const TTL_MS = 60_000
type Result<T> = { data: T[] | null; error: { message?: string } | null }
type Purchase = CommissionPurchase
type Withdrawal = { amount_usdc: string | number; status: string }
type Settlement = CommissionSettlement
type Ledger = { purchases: Purchase[]; withdrawals: Withdrawal[]; settlements: Settlement[];
  commissionWithdrawals?: PlatformWithdrawal[] }

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
  readLedger?: () => Promise<Ledger>
  readFeeQuote?: (amount: bigint, wallet: string) => Promise<CommissionQuote>
  now?: () => Date
}

async function defaultReadFeeQuote(amount: bigint, wallet: string) {
  if (!process.env.ARC_MAINNET_RPC_URL) throw new Error('Arc RPC unavailable')
  const rpc = createPublicClient({ chain: arcMainnet,
    transport: http(process.env.ARC_MAINNET_RPC_URL, { timeout: TIMEOUT_MS, retryCount: 0 }) })
  const [chainId, nativeBalance, block] = await Promise.all([
    rpc.getChainId(), rpc.getBalance({ address: wallet as `0x${string}` }), rpc.getBlockNumber(),
  ])
  if (chainId !== ARC.chainId) throw new Error('Arc RPC chain mismatch')
  const quote = await quoteCommission(amount, wallet, { getGasPrice: () => rpc.getGasPrice() })
  if (BigInt(quote.max_block_height) <= block || !hasArcMintGas(nativeBalance, quote.destination_gas_estimate_usdc)) {
    throw new Error('Commission fee or mint gas unavailable')
  }
  return quote
}

async function defaultReadLedger() {
  const db = createServiceClient()
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const [purchases, withdrawals, settlements, commissionWithdrawals] = await Promise.all([
    readPages<Purchase>((from, to) => db.from('purchases')
      .select('id, api_id, buyer_wallet, amount_usdc, seller_share_usdc, tx_hash, settlement_attempt_id')
      .order('id').range(from, to).abortSignal(signal), signal),
    readPages<Withdrawal>((from, to) => db.from('seller_withdrawals').select('amount_usdc, status')
      .order('id').range(from, to).abortSignal(signal), signal),
    readPages<Settlement>((from, to) => db.from('x402_settlement_attempts')
      .select('id, api_id, fingerprint, authorization_key, state, purchase_id, settlement_identity, binding')
      .order('id').range(from, to).abortSignal(signal), signal),
    readPages<PlatformWithdrawal>((from, to) => db.from('admin_gateway_commission_withdrawals')
      .select('amount_usdc, status')
      .order('created_at').range(from, to).abortSignal(signal), signal),
  ])
  return { purchases, withdrawals, settlements, commissionWithdrawals }
}

export async function readGatewayBalance(wallet: string, fetchBalance: typeof fetch) {
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
  const { commission, seller: known, confirmedReserve, allowance, blockReason } = commissionAllowance(
    ledger.purchases, ledger.settlements, ledger.withdrawals,
    ledger.commissionWithdrawals ?? [], balance.available,
  )
  const now = (dependencies.now ?? (() => new Date()))()
  const unresolvedSettlements = ledger.settlements.filter(row => row.state !== 'ACCOUNTING_COMPLETE').length
  const unresolvedCommissionWithdrawals = (ledger.commissionWithdrawals ?? []).filter(row =>
    ['reserved', 'preparing', 'submission_unknown', 'pending_mint', 'mint_unknown', 'failed'].includes(row.status)).length
  let feeQuote: CommissionQuote | null = null
  let withdrawalBlockReason = blockReason
  if (allowance !== null && allowance >= BigInt(50_000)) {
    try { feeQuote = await (dependencies.readFeeQuote ?? defaultReadFeeQuote)(allowance, wallet) }
    catch { withdrawalBlockReason = 'Current Circle fees or platform-wallet mint gas are unavailable.' }
  } else if (withdrawalBlockReason === null) {
    withdrawalBlockReason = 'Withdrawable commission is below the 0.05 USDC minimum.'
  }
  const withdrawalReady = feeQuote !== null && withdrawalBlockReason === null
  return {
    depositor: wallet,
    total_balance_usdc: formatUsdcMicros(balance.available + balance.withdrawing),
    available_balance_usdc: formatUsdcMicros(balance.available),
    withdrawing_usdc: formatUsdcMicros(balance.withdrawing),
    pending_batch_usdc: balance.pendingBatch,
    known_seller_liabilities_usdc: formatUsdcMicros(known.outstandingMicros + (confirmedReserve ?? BigInt(0))),
    completed_arc_commission_usdc: formatUsdcMicros(commission.completedArc),
    completed_arc_purchase_count: commission.completedArcCount,
    historical_calculated_commission_usdc: formatUsdcMicros(commission.historical),
    historical_calculated_purchase_count: commission.historicalCount,
    total_recorded_gross_commission_usdc: formatUsdcMicros(commission.gross),
    previously_withdrawn_platform_commission_usdc: formatUsdcMicros(commission.completed),
    reserved_platform_commission_usdc: formatUsdcMicros(commission.reserved),
    remaining_recorded_platform_commission_usdc: formatUsdcMicros(commission.remaining),
    gateway_platform_balance_usdc: formatUsdcMicros(commission.remaining),
    safely_withdrawable_usdc: allowance === null || (allowance >= BigInt(50_000) && !withdrawalReady)
      ? null : formatUsdcMicros(allowance),
    withdrawal_ready: withdrawalReady,
    withdrawal_fee_quote: feeQuote,
    withdrawal_block_reason: withdrawalBlockReason,
    unresolved_commission_withdrawals: unresolvedCommissionWithdrawals,
    commission_accounting_issues: commission.accountingIssues,
    unresolved_settlement_attempts: unresolvedSettlements,
    historical_unallocated_purchases: known.historicalUnallocatedPurchases,
    unresolved_withdrawals: known.unresolvedWithdrawals,
    coverage: confirmedReserve !== null && balance.available >= known.outstandingMicros + confirmedReserve
      ? 'known_covered' : 'known_shortfall',
    as_of: now.toISOString(),
  }
}

export function getGatewayTreasury(dependencies: GatewayTreasuryDependencies = {}): Promise<GatewayTreasuryDto> {
  const wallet = verifyPlatformWalletConfiguration({
    address: dependencies.platformAddress, privateKey: dependencies.platformPrivateKey,
  }).address
  return withOperationsTtl(`gateway-treasury-v5:${wallet.toLowerCase()}`, TTL_MS, () => readGatewayTreasury(dependencies))
}
