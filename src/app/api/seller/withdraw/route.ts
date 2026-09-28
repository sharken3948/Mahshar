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
import { withWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { ARC, GATEWAY_MINTER_ABI } from '@/lib/arc'
import { PLATFORM_PRIVATE_KEY } from '@/lib/gateway'
import { arcMainnet } from '@/lib/chains'
import { buildWithdrawMessage, WITHDRAW_TIMESTAMP_WINDOW_SECONDS } from '@/lib/withdraw-auth-message'
import { classifyGatewayTransferResponse } from '@/lib/withdrawal-outcome'

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

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2048)
}

export const POST = withWalletSession(async (request: NextRequest, sessionWallet: string) => {
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
  assertWalletClaim(sellerWallet, sessionWallet)
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

  const transitionReservation = async (from: string[], values: Record<string, unknown>) => {
    const { data, error } = await supabase.from('seller_withdrawals').update(values)
      .eq('id', withdrawalId).in('status', from).select('id').maybeSingle()
    return !error && !!data
  }
  const expireReservation = async (from: string[], reason: string) => {
    const released = await transitionReservation(from, { status: 'expired', last_error: reason.slice(0, 2048) })
    if (!released) console.error(`[withdraw-release-failed] withdrawal=${withdrawalId} reason=${reason}`)
    return released
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
    await expireReservation(['pending_mint'], 'Arc RPC unavailable before Gateway submission')
    return NextResponse.json({ error: 'Arc RPC is unavailable for fee estimation.' }, { status: 503 })
  }
  const rawGasCost = (gasUsedEstimate * gasPrice * GAS_BUFFER_PERCENT) / BigInt(100)
  const gasCostAtomic = rawGasCost / NATIVE_TO_USDC_DIVISOR

  const requestedAtomic = parseUnits(requestedAmount.toFixed(6), 6)
  if (gasCostAtomic >= requestedAtomic) {
    await expireReservation(['pending_mint'], 'Requested amount below estimated gas cost before Gateway submission')
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
      await expireReservation(['pending_mint'], `Gateway balance pre-check rejected with HTTP ${balanceRes.status}`)
      return NextResponse.json({ error: 'Gateway balance service unavailable.' }, { status: 502 })
    }
    const balanceData = await balanceRes.json().catch(() => null) as {
      token?: string
      balances?: Array<{ domain?: number; depositor?: string; balance?: string; pendingBatch?: string }>
    } | null
    const availableStr = balanceData?.balances?.[0]?.balance
    if (typeof availableStr !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(availableStr)) {
      await expireReservation(['pending_mint'], 'Gateway balance pre-check returned invalid data')
      return NextResponse.json({ error: 'Gateway balance response was invalid.' }, { status: 502 })
    }
    const availableAtomic = parseUnits(availableStr, 6)
    if (availableAtomic < netAtomic) {
      await expireReservation(['pending_mint'], 'Gateway balance pre-check proved insufficient funds')
      return NextResponse.json(
        { error: 'Settlement is still pending, please try again in a few minutes.' },
        { status: 409 },
      )
    }
  } catch {
    await expireReservation(['pending_mint'], 'Gateway balance pre-check failed before transfer submission')
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
    await expireReservation(['pending_mint'], 'Failed to finalize reservation before Gateway submission')
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
    const message = errorText(err)
    await expireReservation(['pending_mint'], `Burn intent signing failed before Gateway submission: ${message}`)
    return NextResponse.json({ error: `Failed to sign burn intent: ${message}` }, { status: 500 })
  }

  // ── POST /v1/transfer for attestation ────────────────────────────────────
  // Persist the point-of-no-safe-retry before dispatch. A crash, timeout, or
  // lost response from this point forward leaves earnings locked for explicit
  // status reconciliation; the transfer is never blindly POSTed again.
  const submissionMarked = await transitionReservation(['pending_mint'], {
    status: 'submission_unknown',
    gateway_submitted_at: new Date().toISOString(),
    last_error: 'Gateway transfer submission started; outcome not yet known',
  })
  if (!submissionMarked) {
    return NextResponse.json({ error: 'Could not durably mark Gateway submission' }, { status: 503 })
  }

  let gatewayAccepted: { attestation: `0x${string}`; signature: `0x${string}`; transferId: string | null } | null = null
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
    const gatewayBody = await gatewayRes.json().catch(() => null)
    const outcome = classifyGatewayTransferResponse(gatewayRes.status, gatewayBody)
    if (outcome.kind === 'rejected') {
      const released = await expireReservation(['submission_unknown'], `Gateway definitively rejected transfer: ${outcome.detail}`)
      return NextResponse.json({
        error: released ? `Gateway rejected transfer: ${outcome.detail}` : 'Gateway rejection could not be durably recorded',
        status: released ? 'expired' : 'submission_unknown',
      }, { status: released ? 502 : 503 })
    }
    if (outcome.kind === 'unknown') {
      await transitionReservation(['submission_unknown'], {
        gateway_transfer_id: outcome.transferId,
        last_error: outcome.detail,
      })
      console.error(`[withdraw-circle-unknown] withdrawal=${withdrawalId} error=${outcome.detail}`)
      return NextResponse.json({
        withdrawal_id: withdrawalId,
        status: 'submission_unknown',
        error: 'Gateway transfer outcome is unknown; the reservation remains locked for reconciliation.',
      }, { status: 502 })
    }
    gatewayAccepted = outcome
  } catch (err) {
    const message = errorText(err)
    await transitionReservation(['submission_unknown'], { last_error: `Gateway network outcome unknown: ${message}` })
    console.error(`[withdraw-circle-network-error] withdrawal=${withdrawalId} error=${message}`)
    return NextResponse.json({
      withdrawal_id: withdrawalId,
      status: 'submission_unknown',
      error: 'Gateway transfer outcome is unknown; the reservation remains locked for reconciliation.',
    }, { status: 502 })
  }

  // ── Persist attestation so confirm/route.ts can recover a later crash ────
  if (!gatewayAccepted) {
    return NextResponse.json({ error: 'Gateway transfer outcome was not accepted' }, { status: 502 })
  }
  const attestationStored = await transitionReservation(['submission_unknown'], {
    status: 'pending_mint',
    attestation: gatewayAccepted.attestation,
    attestation_signature: gatewayAccepted.signature,
    gateway_transfer_id: gatewayAccepted.transferId,
    last_error: null,
  })
  if (!attestationStored) {
    console.error(
      `[withdraw-orphan] withdrawal=${withdrawalId} seller=${sellerWallet.toLowerCase()} attestation_not_persisted`,
    )
    return NextResponse.json(
      { error: 'Failed to store Gateway attestation; reservation remains locked for reconciliation' },
      { status: 500 },
    )
  }

  // ── Submit gatewayMint from platform wallet ──────────────────────────────
  const walletClient = createWalletClient({ account, chain, transport: rpcTransport })
  const mintSubmissionMarked = await transitionReservation(['pending_mint'], {
    status: 'mint_unknown',
    last_error: 'Arc mint submission started; transaction hash not yet known',
  })
  if (!mintSubmissionMarked) {
    return NextResponse.json({ error: 'Could not durably mark mint submission' }, { status: 503 })
  }
  let mintTxHash: Hex
  try {
    mintTxHash = await walletClient.writeContract({
      address: ARC.gatewayMinter,
      abi: GATEWAY_MINTER_ABI,
      functionName: 'gatewayMint',
      args: [gatewayAccepted.attestation, gatewayAccepted.signature],
    })
  } catch (err) {
    const message = errorText(err)
    await transitionReservation(['mint_unknown'], { last_error: `Arc mint submission outcome unknown: ${message}` })
    console.error(`[withdraw-mint-submit-failed] withdrawal=${withdrawalId} error=${message}`)
    return NextResponse.json(
      {
        withdrawal_id: withdrawalId,
        requested_amount_usdc: requestedNum,
        net_amount_usdc: netNum,
        gas_cost_usdc: gasNum,
        status: 'mint_unknown',
        error: 'Mint submission outcome is unknown; automatic resubmission is disabled.',
      },
      { status: 500 },
    )
  }

  const mintHashStored = await transitionReservation(['mint_unknown'], {
    status: 'pending_mint', mint_tx_hash: mintTxHash, last_error: null,
  })
  if (!mintHashStored) {
    console.error(`[withdraw-mint-hash-store-failed] withdrawal=${withdrawalId} tx=${mintTxHash}`)
    return NextResponse.json({
      withdrawal_id: withdrawalId, mint_tx_hash: mintTxHash, status: 'mint_unknown',
      error: 'Mint transaction was submitted but its hash could not be durably stored.',
    }, { status: 500 })
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
    const message = errorText(err)
    await transitionReservation(['pending_mint'], { last_error: `Receipt poll failed: ${message}` })
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

  const finalized = await transitionReservation(['pending_mint'], {
    status: mintStatus,
    mint_tx_hash: mintTxHash,
    minted_at: mintStatus === 'minted' ? new Date().toISOString() : null,
    last_error: mintStatus === 'failed' ? 'Mint transaction reverted on-chain' : null,
  })
  if (!finalized) {
    console.error(`[withdraw-status-update-failed] withdrawal=${withdrawalId} tx=${mintTxHash} status=${mintStatus}`)
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
