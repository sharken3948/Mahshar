import 'server-only'

import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcPrivateMainnetHeaders } from '@circle-fin/x402-batching/client'
import { ARC, GATEWAY_MINTER_ABI } from '@/lib/arc'
import { arcMainnet } from '@/lib/chains'
import { verifyPlatformWalletConfiguration } from '@/lib/platform-wallet-config'
import { createServiceClient } from '@/lib/supabase/server'
import { readGatewayTreasury } from './gateway-treasury-data'
import { readGatewayBalance } from './gateway-treasury-data'
import { formatUsdcMicros } from './gateway-treasury-calculation'
import { commissionAmount, executeCommissionWithdrawal, PLATFORM_COMMISSION_DESTINATION,
  hasArcMintGas, quoteCommission, reconcileCommissionWithdrawal, signCommissionIntent,
  type CommissionQuote, type CommissionRow } from './commission-withdrawal'

const transport = http(process.env.ARC_MAINNET_RPC_URL, { timeout: 10_000, retryCount: 0 })
const publicClient = createPublicClient({ chain: arcMainnet, transport })

function platformAccount() {
  const wallet = verifyPlatformWalletConfiguration()
  if (wallet.address.toLowerCase() !== PLATFORM_COMMISSION_DESTINATION.toLowerCase()) {
    throw new Error('Platform commission destination mismatch')
  }
  return privateKeyToAccount(wallet.privateKey)
}

export async function commissionTreasuryContext(amountInput: unknown) {
  const amount = commissionAmount(amountInput)
  const treasury = await readGatewayTreasury() // Fresh Circle and database reads; never use the UI cache.
  if (!treasury.withdrawal_ready || treasury.safely_withdrawable_usdc === null ||
    amount > commissionAmountOrZero(treasury.safely_withdrawable_usdc)) {
    throw new Error('No protected commission allowance exists for this amount')
  }
  const account = platformAccount()
  const quote = await quoteCommission(amount, account.address, {
    getGasPrice: () => publicClient.getGasPrice(),
  })
  const gasBalance = await publicClient.getBalance({ address: account.address })
  if (!hasArcMintGas(gasBalance, quote.destination_gas_estimate_usdc)) {
    throw new Error('Insufficient Arc gas balance for commission mint')
  }
  return { account, quote, gatewayAvailable: treasury.available_balance_usdc }
}

function commissionAmountOrZero(value: string) {
  try { return commissionAmount(value) } catch { return BigInt(0) }
}

export function commissionWithdrawalDependencies() {
  const db = createServiceClient()
  const account = platformAccount()
  const walletClient = createWalletClient({ account, chain: arcMainnet, transport })
  const store = {
    async reserve(args: { idempotencyKey: string; quote: CommissionQuote; gatewayAvailable: string }) {
      const { data, error } = await db.rpc('mahshar_reserve_admin_commission_withdrawal', {
        p_idempotency_key: args.idempotencyKey,
        p_amount_usdc: args.quote.amount_usdc,
        p_mint_value_usdc: args.quote.mint_value_usdc,
        p_source_fee_cap_usdc: args.quote.source_fee_cap_usdc,
        p_destination_gas_estimate_usdc: args.quote.destination_gas_estimate_usdc,
        p_gateway_available_usdc: args.gatewayAvailable,
      }).abortSignal(AbortSignal.timeout(8_000))
      if (error || !data) throw new Error('Commission withdrawal reservation unavailable')
      return (Array.isArray(data) ? data[0] : data) as CommissionRow
    },
    async get(id: string) {
      const { data, error } = await db.from('admin_gateway_commission_withdrawals').select('*')
        .eq('id', id).abortSignal(AbortSignal.timeout(8_000)).maybeSingle()
      if (error) throw new Error('Commission withdrawal status unavailable')
      return data as CommissionRow | null
    },
    async transition(id: string, from: string, update: Record<string, unknown>) {
      const { data, error } = await db.from('admin_gateway_commission_withdrawals').update(update)
        .eq('id', id).eq('status', from).select('id').abortSignal(AbortSignal.timeout(8_000)).maybeSingle()
      return !error && !!data
    },
  }
  const services = {
    async preflight(gatewayAvailable: string, quote: CommissionQuote, withdrawalId: string) {
      const balance = await readGatewayBalance(account.address, fetch)
      if (formatUsdcMicros(balance.available) !== gatewayAvailable) {
        throw new Error('Gateway treasury changed before submission')
      }
      const { error } = await db.rpc('mahshar_validate_admin_commission_withdrawal', {
        p_withdrawal_id: withdrawalId, p_gateway_available_usdc: gatewayAvailable,
      }).abortSignal(AbortSignal.timeout(8_000))
      if (error) throw new Error('Commission allowance changed before submission')
      const gasBalance = await publicClient.getBalance({ address: account.address })
      if (!hasArcMintGas(gasBalance, quote.destination_gas_estimate_usdc)) {
        throw new Error('Insufficient Arc gas balance for commission mint')
      }
    },
    sign: (intent: Parameters<typeof signCommissionIntent>[1]) => signCommissionIntent(account, intent),
    async submit(intent: Parameters<typeof signCommissionIntent>[1], signature: Hex) {
      const response = await fetch(`${ARC.gatewayApi}/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...arcPrivateMainnetHeaders(true) },
        body: JSON.stringify([{ burnIntent: intent, signature }], (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value),
        signal: AbortSignal.timeout(10_000), cache: 'no-store',
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    },
    mint: (attestation: Hex, signature: Hex) => walletClient.writeContract({
      address: ARC.gatewayMinter, abi: GATEWAY_MINTER_ABI,
      functionName: 'gatewayMint', args: [attestation, signature],
    }),
    async receipt(hash: Hex) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
      return receipt.status
    },
    async transferStatus(id: string) {
      const response = await fetch(`${ARC.gatewayApi}/transfer/${encodeURIComponent(id)}`, {
        headers: arcPrivateMainnetHeaders(true), signal: AbortSignal.timeout(10_000), cache: 'no-store',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Gateway transfer status unavailable')
      }
      return response.json()
    },
  }
  return { store, services }
}

export async function submitCommissionWithdrawal(input: {
  idempotencyKey: string; quote: CommissionQuote; gatewayAvailable: string;
}) {
  return executeCommissionWithdrawal(commissionWithdrawalDependencies(), {
    ...input, platform: PLATFORM_COMMISSION_DESTINATION,
  })
}

export async function recoverCommissionWithdrawal(id: string) {
  return reconcileCommissionWithdrawal(commissionWithdrawalDependencies(), id)
}

/** Lost HTTP responses can be looked up without re-quoting, re-signing or re-submitting. */
export async function findCommissionWithdrawalByKey(idempotencyKey: string) {
  const db = createServiceClient()
  const { data, error } = await db.from('admin_gateway_commission_withdrawals').select('*')
    .eq('idempotency_key', idempotencyKey).abortSignal(AbortSignal.timeout(8_000)).maybeSingle()
  if (error) throw new Error('Commission withdrawal lookup unavailable')
  return data as CommissionRow | null
}
