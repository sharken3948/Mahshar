import { NextRequest, NextResponse } from 'next/server'
import {
  pad, parseUnits, maxUint256, formatUnits,
  createPublicClient, createWalletClient, http,
  verifyMessage, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { arcPrivateMainnetHeaders } from '@circle-fin/x402-batching/client'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { marketplaceErrors } from '@/lib/marketplace/server'
import { ARC, GATEWAY_MINTER_ABI } from '@/lib/arc'
import { PLATFORM_PRIVATE_KEY } from '@/lib/gateway'
import { arcMainnet } from '@/lib/chains'
import { buildWithdrawMessage, WITHDRAW_TIMESTAMP_WINDOW_SECONDS } from '@/lib/withdraw-auth-message'

export const runtime = 'nodejs'

// Left-pad an address to 32 bytes, matching Circle SDK's addressToBytes32.
function addressToBytes32(addr: string): Hex {
  return pad(addr.toLowerCase() as Hex, { size: 32 })
}

// EIP-712 types for GatewayWallet BurnIntent. Byte-for-byte identical to the
// SDK's (dist/client/index.mjs @ withdraw). The explicit EIP712Domain entry
// pins the domain typehash to (name, version) only.
const BURN_INTENT_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
  ],
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const

function bigintReplacer(_: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v
}

// estimateContractGas always reverts with dummy args, so this fallback is the
// real estimate. Measured real gasUsed on Arc Mainnet gatewayMint: 133,434
// (Sep 2026). Buffer of 20% (see GAS_BUFFER_PERCENT) protects against
// gas-price movement between /transfer and the actual mint submission.
const GAS_FALLBACK: bigint = BigInt(140_000)
const GAS_BUFFER_PERCENT: bigint = BigInt(120)
// Arc native currency is USDC represented at 18 decimals; the ERC-20 view uses
// 6 decimals. gas * gasPrice yields an 18-decimal value → divide by 10^12 to
// get 6-decimal atomic USDC. Confirmed on 2026-09-19 via a live balance probe
// (native `1500000000000000000` ≡ USDC `1500000` for the platform wallet).
const NATIVE_TO_USDC_DIVISOR: bigint = BigInt(10) ** BigInt(12)

// Server-side floor so gas doesn't dominate the payout on tiny amounts.
// Keep in sync with dashboard/page.tsx MIN_WITHDRAW_USDC.
const MIN_WITHDRAW_USDC = 1

const WITHDRAW_COOLDOWN_SECONDS = 60

export const POST = marketplaceErrors(async (request: NextRequest) => {
  const body = (await request.json().catch(() => ({}))) as {
    seller_wallet?: string
    amount_usdc?: number | string
    timestamp?: string
    nonce?: string
    signature?: string
  }

  const sellerWallet = body.seller_wallet
  if (!sellerWallet || !isValidWalletAddress(sellerWallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet' }, { status: 400 })
  }
  const requestedAmount = Number(body.amount_usdc)
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return NextResponse.json({ error: 'Invalid amount_usdc' }, { status: 400 })
  }

  if (requestedAmount < MIN_WITHDRAW_USDC) {
    return NextResponse.json(
      { error: `Minimum withdrawal is $${MIN_WITHDRAW_USDC.toFixed(2)} USDC. Requested: $${requestedAmount.toFixed(4)}.` },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  // ── Signature auth ───────────────────────────────────────────────────────
  const { timestamp, nonce, signature } = body
  if (!timestamp || !nonce || !signature) {
    return NextResponse.json({ error: 'Missing signature, timestamp, or nonce.' }, { status: 401 })
  }
  const authAgeSec = (Date.now() - new Date(timestamp).getTime()) / 1000
  if (!Number.isFinite(authAgeSec) || authAgeSec > WITHDRAW_TIMESTAMP_WINDOW_SECONDS || authAgeSec < -30) {
    return NextResponse.json({ error: 'Request timestamp is expired or invalid.' }, { status: 401 })
  }
  const authMessage = buildWithdrawMessage({
    sellerWallet,
    amountUsdc: requestedAmount.toFixed(6),
    timestamp,
    nonce,
  })
  let sigValid: boolean
  try {
    sigValid = await verifyMessage({
      address: sellerWallet as `0x${string}`,
      message: authMessage,
      signature: signature as `0x${string}`,
    })
  } catch {
    sigValid = false
  }
  if (!sigValid) {
    return NextResponse.json({ error: 'Signature is invalid or does not match seller_wallet.' }, { status: 401 })
  }
  const { error: nonceErr } = await supabase
    .from('withdraw_used_nonces')
    .insert({ nonce, seller_wallet: sellerWallet.toLowerCase() })
  if (nonceErr) {
    if (nonceErr.code === '23505') {
      return NextResponse.json({ error: 'Nonce has already been used.' }, { status: 401 })
    }
    return NextResponse.json({ error: nonceErr.message }, { status: 500 })
  }

  const networkId = 'eip155:5042'

  // This SECURITY DEFINER RPC is the sole balance/cooldown/insert decision.
  // Its advisory transaction lock serializes all requests for this seller.
  const { data: reserved, error: reservationError } = await supabase.rpc('mahshar_reserve_seller_withdrawal', {
    p_seller_wallet: sellerWallet.toLowerCase(),
    p_amount_usdc: Number(requestedAmount.toFixed(6)),
    p_network_id: networkId,
  })
  if (reservationError || !reserved) {
    const message = reservationError?.message ?? 'Withdrawal reservation failed'
    if (/cooldown/i.test(message)) return NextResponse.json(
      { error: 'Please wait a minute before requesting another withdrawal.' },
      { status: 429, headers: { 'Retry-After': String(WITHDRAW_COOLDOWN_SECONDS) } },
    )
    if (/insufficient/i.test(message)) return NextResponse.json({ error: 'Insufficient withdrawable balance.' }, { status: 400 })
    if (reservationError?.code === '23505') return NextResponse.json(
      { error: 'A withdrawal is already in progress for this seller. Wait for it to complete or expire.' }, { status: 409 })
    return NextResponse.json({ error: 'Withdrawal reservation unavailable' }, { status: 503 })
  }
  const reservedRow = (Array.isArray(reserved) ? reserved[0] : reserved) as { id?: string }
  if (!reservedRow?.id) return NextResponse.json({ error: 'Withdrawal reservation unavailable' }, { status: 503 })
  const withdrawalId = reservedRow.id

  const expireReservation = async () => {
    await supabase.from('seller_withdrawals').update({ status: 'expired' })
      .eq('id', withdrawalId).eq('status', 'pending_mint')
  }

  const chain = arcMainnet
  const rpcUrl = process.env.ARC_MAINNET_RPC_URL
  const rpcTransport = http(rpcUrl, { timeout: 10_000, retryCount: 0 })
  const publicClient = createPublicClient({ chain, transport: rpcTransport })

  const account = privateKeyToAccount(PLATFORM_PRIVATE_KEY)
  const platform = account.address

  // ── Estimate gas ─────────────────────────────────────────────────────────
  // gatewayMint reverts on Circle's signature check with dummy args, so
  // estimateContractGas typically throws — fallback is deliberate here.
  // Dummy sizes approximate real returns from /v1/transfer: 256B attestation, 65B signature.
  const dummyAttestation = ('0x' + '00'.repeat(256)) as Hex
  const dummySignature = ('0x' + '00'.repeat(65)) as Hex
  let gasUsedEstimate: bigint
  try {
    gasUsedEstimate = await publicClient.estimateContractGas({
      address: ARC.gatewayMinter,
      abi: GATEWAY_MINTER_ABI,
      functionName: 'gatewayMint',
      args: [dummyAttestation, dummySignature],
      account: platform,
    })
  } catch {
    gasUsedEstimate = GAS_FALLBACK
  }
  let gasPrice: bigint
  try { gasPrice = await publicClient.getGasPrice() }
  catch {
    await expireReservation()
    return NextResponse.json({ error: 'Arc RPC is unavailable for fee estimation.' }, { status: 503 })
  }
  const rawGasCost = (gasUsedEstimate * gasPrice * GAS_BUFFER_PERCENT) / BigInt(100)
  const gasCostAtomic = rawGasCost / NATIVE_TO_USDC_DIVISOR

  const requestedAtomic = parseUnits(requestedAmount.toFixed(6), 6)
  if (gasCostAtomic >= requestedAtomic) {
    await expireReservation()
    return NextResponse.json(
      { error: `Requested amount ${formatUnits(requestedAtomic, 6)} USDC is below estimated gas cost ${formatUnits(gasCostAtomic, 6)} USDC. Nothing to send.` },
      { status: 400 },
    )
  }
  const netAtomic = requestedAtomic - gasCostAtomic

  // ── Gateway balance pre-check ─────────────────────────────────────────────
  // Confirm the platform depositor has enough confirmed balance before
  // calling /v1/transfer. Unknown balance is not treated as zero and does not
  // proceed into a money-moving operation.
  try {
    const balanceRes = await fetch(`${ARC.gatewayApi}/balances`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...arcPrivateMainnetHeaders(true),
      },
      body: JSON.stringify({
        token: 'USDC',
        sources: [{ depositor: platform, domain: ARC.gatewayDomain }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!balanceRes.ok) {
      await balanceRes.body?.cancel().catch(() => undefined)
      await expireReservation()
      return NextResponse.json({ error: 'Gateway balance service unavailable.' }, { status: 502 })
    }
    const balanceData = await balanceRes.json().catch(() => null) as {
      token?: string
      balances?: Array<{ domain?: number; depositor?: string; balance?: string; pendingBatch?: string }>
    } | null
    const availableStr = balanceData?.balances?.[0]?.balance
    if (typeof availableStr !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(availableStr)) {
      await expireReservation()
      return NextResponse.json({ error: 'Gateway balance response was invalid.' }, { status: 502 })
    }
    const availableAtomic = parseUnits(availableStr, 6)
    if (availableAtomic < netAtomic) {
      await expireReservation()
      return NextResponse.json(
        { error: 'Settlement is still pending, please try again in a few minutes.' },
        { status: 409 },
      )
    }
  } catch {
    await expireReservation()
    return NextResponse.json({ error: 'Gateway balance service unavailable.' }, { status: 503 })
  }

  // ── Build burn intent ────────────────────────────────────────────────────
  // destinationCaller = platform locks gatewayMint execution to the platform
  // wallet only; closes any race where a third party could front-run our mint.
  const spec = {
    version: 1,
    sourceDomain: ARC.gatewayDomain,
    destinationDomain: ARC.gatewayDomain,
    sourceContract: addressToBytes32(ARC.gatewayWallet),
    destinationContract: addressToBytes32(ARC.gatewayMinter),
    sourceToken: addressToBytes32(ARC.usdcAddress),
    destinationToken: addressToBytes32(ARC.usdcAddress),
    sourceDepositor: addressToBytes32(platform),
    destinationRecipient: addressToBytes32(sellerWallet),
    sourceSigner: addressToBytes32(platform),
    destinationCaller: addressToBytes32(platform),
    value: netAtomic,
    salt: `0x${randomBytes(32).toString('hex')}` as Hex,
    hookData: '0x' as Hex,
  }
  const burnIntent = {
    maxBlockHeight: maxUint256,
    maxFee: parseUnits('2.01', 6),
    spec,
  }

  // ── Finalize the already-durable reservation before calling Circle ───────
  const burnIntentSerialized: unknown = JSON.parse(JSON.stringify(burnIntent, bigintReplacer))
  const requestedNum = Number(formatUnits(requestedAtomic, 6))
  const netNum = Number(formatUnits(netAtomic, 6))
  const gasNum = Number(formatUnits(gasCostAtomic, 6))
  const { data: prepared, error: prepareError } = await supabase
    .from('seller_withdrawals')
    .update({
      net_amount_usdc: netNum,
      gas_cost_usdc: gasNum,
      burn_intent: burnIntentSerialized,
    })
    .eq('id', withdrawalId)
    .eq('status', 'pending_mint')
    .select('id')
    .single()
  if (prepareError || !prepared) {
    await expireReservation()
    return NextResponse.json({ error: 'Failed to finalize withdrawal reservation' }, { status: 500 })
  }

  // ── Sign burn intent ─────────────────────────────────────────────────────
  let burnSignature: Hex
  try {
    burnSignature = await account.signTypedData({
      domain: { name: 'GatewayWallet', version: '1' },
      types: BURN_INTENT_TYPES,
      primaryType: 'BurnIntent',
      message: burnIntent,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await expireReservation()
    return NextResponse.json({ error: `Failed to sign burn intent: ${message}` }, { status: 500 })
  }

  // ── POST /v1/transfer for attestation ────────────────────────────────────
  let gatewayResult: {
    attestation?: string
    signature?: string
    success?: boolean
    error?: string
    message?: string
  } = {}
  try {
    const gatewayRes = await fetch(`${ARC.gatewayApi}/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...arcPrivateMainnetHeaders(true),
      },
      body: JSON.stringify([{ burnIntent, signature: burnSignature }], bigintReplacer),
      signal: AbortSignal.timeout(10_000),
    })
    gatewayResult = await gatewayRes.json().catch(() => ({})) as typeof gatewayResult
    if (
      !gatewayRes.ok ||
      gatewayResult.success === false ||
      gatewayResult.error ||
      !gatewayResult.attestation ||
      !gatewayResult.signature
    ) {
      // Clean rejection: Circle definitively refused — safe to expire the row.
      await expireReservation()
      const detail = gatewayResult.message ?? gatewayResult.error ?? JSON.stringify(gatewayResult)
      return NextResponse.json({ error: `Gateway API error: ${detail}` }, { status: 502 })
    }
  } catch (err) {
    // Ambiguous network error: Circle may have processed the request already.
    // Mark failed (balance stays frozen) so ops can reconcile rather than
    // silently double-spending on a retry.
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('seller_withdrawals')
      .update({ status: 'failed' })
      .eq('id', withdrawalId)
      .eq('status', 'pending_mint')
    console.error(`[withdraw-circle-network-error] withdrawal=${withdrawalId} error=${message}`)
    return NextResponse.json({ error: `Gateway network error: ${message}` }, { status: 502 })
  }

  // ── Persist attestation so confirm/route.ts can recover a later crash ────
  const { error: attErr } = await supabase
    .from('seller_withdrawals')
    .update({
      attestation: gatewayResult.attestation,
      attestation_signature: gatewayResult.signature,
    })
    .eq('id', withdrawalId)
    .eq('status', 'pending_mint')
  if (attErr) {
    console.error(
      `[withdraw-orphan] withdrawal=${withdrawalId} seller=${sellerWallet.toLowerCase()} db_error=${attErr.message}`,
    )
    return NextResponse.json(
      { error: `Failed to store attestation: ${attErr.message}` },
      { status: 500 },
    )
  }

  // ── Submit gatewayMint from platform wallet ──────────────────────────────
  const walletClient = createWalletClient({ account, chain, transport: rpcTransport })
  let mintTxHash: Hex
  try {
    mintTxHash = await walletClient.writeContract({
      address: ARC.gatewayMinter,
      abi: GATEWAY_MINTER_ABI,
      functionName: 'gatewayMint',
      args: [gatewayResult.attestation as Hex, gatewayResult.signature as Hex],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[withdraw-mint-submit-failed] withdrawal=${withdrawalId} error=${message}`)
    return NextResponse.json(
      {
        withdrawal_id: withdrawalId,
        requested_amount_usdc: requestedNum,
        net_amount_usdc: netNum,
        gas_cost_usdc: gasNum,
        status: 'pending_mint',
        error: `Mint submission failed: ${message}. Row remains pending_mint; retry via /api/seller/withdraw/confirm.`,
      },
      { status: 500 },
    )
  }

  // ── Wait for receipt, update status ──────────────────────────────────────
  let mintStatus: 'minted' | 'failed'
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: mintTxHash,
      timeout: 60_000,
    })
    mintStatus = receipt.status === 'success' ? 'minted' : 'failed'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[withdraw-receipt-poll-failed] withdrawal=${withdrawalId} tx=${mintTxHash} error=${message}`)
    return NextResponse.json(
      {
        withdrawal_id: withdrawalId,
        requested_amount_usdc: requestedNum,
        net_amount_usdc: netNum,
        gas_cost_usdc: gasNum,
        mint_tx_hash: mintTxHash,
        status: 'pending_mint',
        error: `Mint submitted but receipt poll failed: ${message}. Retry via /api/seller/withdraw/confirm.`,
      },
      { status: 500 },
    )
  }

  const { error: updErr } = await supabase
    .from('seller_withdrawals')
    .update({
      status: mintStatus,
      mint_tx_hash: mintTxHash,
      minted_at: mintStatus === 'minted' ? new Date().toISOString() : null,
    })
    .eq('id', withdrawalId)
    .eq('status', 'pending_mint')
  if (updErr) {
    console.error(`[withdraw-status-update-failed] withdrawal=${withdrawalId} tx=${mintTxHash} status=${mintStatus} error=${updErr.message}`)
    // Fall through — the mint is on-chain, ops can reconcile the row.
  }

  if (mintStatus === 'failed') {
    return NextResponse.json(
      {
        withdrawal_id: withdrawalId,
        requested_amount_usdc: requestedNum,
        net_amount_usdc: netNum,
        gas_cost_usdc: gasNum,
        mint_tx_hash: mintTxHash,
        status: 'failed',
        error: 'Mint transaction reverted on-chain',
      },
      { status: 502 },
    )
  }

  return NextResponse.json({
    withdrawal_id: withdrawalId,
    requested_amount_usdc: requestedNum,
    net_amount_usdc: netNum,
    gas_cost_usdc: gasNum,
    mint_tx_hash: mintTxHash,
    status: 'minted',
  })
})
