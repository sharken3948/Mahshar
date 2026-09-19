import { NextRequest, NextResponse } from 'next/server'
import {
  pad, parseUnits, maxUint256, formatUnits,
  createPublicClient, createWalletClient, http,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { arcPrivateMainnetHeaders } from '@circle-fin/x402-batching/client'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { ARC, ARC_MAINNET, GATEWAY_MINTER_ABI } from '@/lib/arc'
import { PLATFORM_PRIVATE_KEY } from '@/lib/gateway'
import { arcMainnet, arcTestnet } from '@/lib/chains'

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

// gatewayMint uses ~100-150k gas in the happy path; 300k is a safe ceiling for
// the fallback path. Buffer of 20% over the estimate protects against
// gas-price movement between /transfer and the actual mint submission.
const GAS_FALLBACK: bigint = BigInt(300_000)
const GAS_BUFFER_PERCENT: bigint = BigInt(120)
// Arc native currency is USDC represented at 18 decimals; the ERC-20 view uses
// 6 decimals. gas * gasPrice yields an 18-decimal value → divide by 10^12 to
// get 6-decimal atomic USDC. Confirmed on 2026-09-19 via a live balance probe
// (native `1500000000000000000` ≡ USDC `1500000` for the platform wallet).
const NATIVE_TO_USDC_DIVISOR: bigint = BigInt(10) ** BigInt(12)

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    seller_wallet?: string
    amount_usdc?: number | string
  }

  const sellerWallet = body.seller_wallet
  if (!sellerWallet || !isValidWalletAddress(sellerWallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet' }, { status: 400 })
  }
  const requestedAmount = Number(body.amount_usdc)
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return NextResponse.json({ error: 'Invalid amount_usdc' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── Balance check ────────────────────────────────────────────────────────
  const { data: apis, error: apisErr } = await supabase
    .from('api_listings')
    .select('id')
    .ilike('seller_wallet', sellerWallet)
  if (apisErr) return NextResponse.json({ error: apisErr.message }, { status: 500 })
  const apiIds = (apis ?? []).map(a => a.id)
  if (apiIds.length === 0) {
    return NextResponse.json({ error: 'No listings for this seller' }, { status: 400 })
  }

  const { data: earned, error: earnedErr } = await supabase
    .from('purchases')
    .select('seller_share_usdc')
    .in('api_id', apiIds)
  if (earnedErr) return NextResponse.json({ error: earnedErr.message }, { status: 500 })
  const totalEarned = (earned ?? []).reduce(
    (s, r) => s + (r.seller_share_usdc == null ? 0 : (Number(r.seller_share_usdc) || 0)),
    0,
  )

  // Consumed = any withdrawal that touched Circle's Gateway API (attestation
  // issued → balance reserved), regardless of on-chain outcome. Failed rows
  // consume too until ops manually reconciles.
  const { data: outstanding, error: outstandingErr } = await supabase
    .from('seller_withdrawals')
    .select('amount_usdc')
    .ilike('seller_wallet', sellerWallet)
    .in('status', ['pending_mint', 'minted', 'failed'])
  if (outstandingErr) return NextResponse.json({ error: outstandingErr.message }, { status: 500 })
  const totalOutstanding = (outstanding ?? []).reduce(
    (s, r) => s + (Number(r.amount_usdc) || 0),
    0,
  )

  const balance = totalEarned - totalOutstanding
  if (requestedAmount > balance + 1e-9) {
    return NextResponse.json(
      { error: `Insufficient balance: have ${balance.toFixed(6)}, requested ${requestedAmount.toFixed(6)}` },
      { status: 400 },
    )
  }

  const isMainnet = ARC.chainId === ARC_MAINNET.chainId
  const networkId = isMainnet ? 'eip155:5042' : 'eip155:5042002'
  const chain = isMainnet ? arcMainnet : arcTestnet
  const rpcUrl = isMainnet ? process.env.ARC_MAINNET_RPC_URL : undefined

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
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
  const gasPrice = await publicClient.getGasPrice()
  const rawGasCost = (gasUsedEstimate * gasPrice * GAS_BUFFER_PERCENT) / BigInt(100)
  const gasCostAtomic = rawGasCost / NATIVE_TO_USDC_DIVISOR

  const requestedAtomic = parseUnits(requestedAmount.toFixed(6), 6)
  if (gasCostAtomic >= requestedAtomic) {
    return NextResponse.json(
      { error: `Requested amount ${formatUnits(requestedAtomic, 6)} USDC is below estimated gas cost ${formatUnits(gasCostAtomic, 6)} USDC. Nothing to send.` },
      { status: 400 },
    )
  }
  const netAtomic = requestedAtomic - gasCostAtomic

  // ── Build + sign burn intent ─────────────────────────────────────────────
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

  const signature = await account.signTypedData({
    domain: { name: 'GatewayWallet', version: '1' },
    types: BURN_INTENT_TYPES,
    primaryType: 'BurnIntent',
    message: burnIntent,
  })

  // ── POST /v1/transfer for attestation ────────────────────────────────────
  const gatewayRes = await fetch(`${ARC.gatewayApi}/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...arcPrivateMainnetHeaders(isMainnet),
    },
    body: JSON.stringify([{ burnIntent, signature }], bigintReplacer),
  })
  const gatewayResult = await gatewayRes.json().catch(() => ({})) as {
    attestation?: string
    signature?: string
    success?: boolean
    error?: string
    message?: string
  }
  if (
    !gatewayRes.ok ||
    gatewayResult.success === false ||
    gatewayResult.error ||
    !gatewayResult.attestation ||
    !gatewayResult.signature
  ) {
    const detail = gatewayResult.message ?? gatewayResult.error ?? JSON.stringify(gatewayResult)
    return NextResponse.json({ error: `Gateway API error: ${detail}` }, { status: 502 })
  }

  // ── Insert pending_mint row (before submit) ──────────────────────────────
  const burnIntentSerialized: unknown = JSON.parse(JSON.stringify(burnIntent, bigintReplacer))
  const requestedNum = Number(formatUnits(requestedAtomic, 6))
  const netNum = Number(formatUnits(netAtomic, 6))
  const gasNum = Number(formatUnits(gasCostAtomic, 6))
  const { data: inserted, error: insertErr } = await supabase
    .from('seller_withdrawals')
    .insert({
      seller_wallet: sellerWallet.toLowerCase(),
      network_id: networkId,
      amount_usdc: requestedNum,
      net_amount_usdc: netNum,
      gas_cost_usdc: gasNum,
      burn_intent: burnIntentSerialized,
      attestation: gatewayResult.attestation,
      attestation_signature: gatewayResult.signature,
    })
    .select('id')
    .single()
  if (insertErr || !inserted) {
    console.error(
      `[withdraw-orphan] seller=${sellerWallet} amount=${requestedNum} attestation=${gatewayResult.attestation} signature=${gatewayResult.signature} db_error=${insertErr?.message ?? 'unknown'}`,
    )
    return NextResponse.json(
      { error: `Failed to record withdrawal: ${insertErr?.message ?? 'unknown'}` },
      { status: 500 },
    )
  }
  const withdrawalId = inserted.id as string

  // ── Submit gatewayMint from platform wallet ──────────────────────────────
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })
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
}
