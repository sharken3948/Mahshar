import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, verifyMessage, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { arcMainnet } from '@/lib/chains'
import { buildConfirmMessage, WITHDRAW_TIMESTAMP_WINDOW_SECONDS } from '@/lib/withdraw-auth-message'
import { ARC, GATEWAY_MINTER_ABI } from '@/lib/arc'
import { PLATFORM_PRIVATE_KEY } from '@/lib/gateway'
import { withWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { arcPrivateMainnetHeaders } from '@circle-fin/x402-batching/client'
import { classifyGatewayTransferStatus } from '@/lib/withdrawal-outcome'

export const runtime = 'nodejs'

// Recovery never repeats an ambiguous Gateway transfer or Arc mint. It may
// query a persisted Gateway transfer ID, submit a mint only after atomically
// claiming a stored attestation, or poll an already-persisted mint hash.
export const POST = withWalletSession(async (request: NextRequest, sessionWallet: string) => {
  const body = (await request.json().catch(() => ({}))) as {
    withdrawal_id?: string
    seller_wallet?: string
    timestamp?: string
    nonce?: string
    signature?: string
  }

  const { withdrawal_id, seller_wallet } = body
  if (!withdrawal_id) {
    return NextResponse.json({ error: 'withdrawal_id required' }, { status: 400 })
  }
  if (!seller_wallet || !isValidWalletAddress(seller_wallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet' }, { status: 400 })
  }
  assertWalletClaim(seller_wallet, sessionWallet)

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
  const authMessage = buildConfirmMessage({
    sellerWallet: seller_wallet,
    withdrawalId: withdrawal_id,
    timestamp,
    nonce,
  })
  let sigValid: boolean
  try {
    sigValid = await verifyMessage({
      address: seller_wallet as `0x${string}`,
      message: authMessage,
      signature: signature as `0x${string}`,
    })
  } catch {
    sigValid = false
  }
  if (!sigValid) {
    return NextResponse.json({ error: 'Signature is invalid or does not match seller_wallet.' }, { status: 401 })
  }
  let nonceWasReplayed = false
  const { error: nonceErr } = await supabase
    .from('withdraw_used_nonces')
    .insert({ nonce, seller_wallet: seller_wallet.toLowerCase() })
  if (nonceErr) {
    if (nonceErr.code === '23505') nonceWasReplayed = true
    else return NextResponse.json({ error: nonceErr.message }, { status: 500 })
  }

  const { data: row, error: readErr } = await supabase
    .from('seller_withdrawals')
    .select('id, seller_wallet, status, attestation, attestation_signature, gateway_transfer_id, mint_tx_hash, minted_at')
    .eq('id', withdrawal_id)
    .single()
  if (readErr || !row) {
    return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
  }
  const owned = String(row.seller_wallet).toLowerCase() === seller_wallet.toLowerCase()
  if (nonceWasReplayed) {
    // A valid signature is bound to this withdrawal ID and wallet. Retrying
    // that idempotent reconciliation must remain possible after a pending or
    // lost response; the durable status predicates below still prevent a
    // second Gateway transfer or concurrent mint submission.
    if (!owned) return NextResponse.json({ error: 'Nonce has already been used.' }, { status: 401 })
  }
  if (!owned) return NextResponse.json({ error: 'Withdrawal does not belong to this seller' }, { status: 403 })
  // Terminal retries are read-only and idempotent. The proof is still checked
  // and wallet-bound, but an already-consumed nonce cannot strand a completed
  // withdrawal merely because the first response was lost.
  if (row.status === 'minted') {
    return NextResponse.json({ withdrawal_id, mint_tx_hash: row.mint_tx_hash, status: 'minted' })
  }
  if (row.status === 'expired' || row.status === 'failed') {
    return NextResponse.json(
      { withdrawal_id, mint_tx_hash: row.mint_tx_hash, status: row.status,
        error: `Withdrawal already in status ${row.status}; nothing to recover.` },
      { status: 409 },
    )
  }
  if (!['pending_mint', 'submission_unknown', 'mint_unknown'].includes(row.status)) {
    return NextResponse.json({ error: 'Withdrawal state is not recoverable' }, { status: 409 })
  }

  const chain = arcMainnet
  const rpcUrl = process.env.ARC_MAINNET_RPC_URL
  const rpcTransport = http(rpcUrl, { timeout: 10_000, retryCount: 0 })
  const publicClient = createPublicClient({ chain, transport: rpcTransport })
  const account = privateKeyToAccount(PLATFORM_PRIVATE_KEY)
  const walletClient = createWalletClient({ account, chain, transport: rpcTransport })

  let attestation = row.attestation as Hex | null
  let attestationSignature = row.attestation_signature as Hex | null
  let status = String(row.status)

  if (status === 'submission_unknown') {
    if (!row.gateway_transfer_id) {
      return NextResponse.json({
        withdrawal_id, status,
        error: 'Gateway submission is ambiguous and has no queryable transfer ID; manual reconciliation is required.',
      }, { status: 409 })
    }
    let gatewayResponse: Response
    try {
      gatewayResponse = await fetch(`${ARC.gatewayApi}/transfer/${encodeURIComponent(String(row.gateway_transfer_id))}`, {
        headers: arcPrivateMainnetHeaders(true), signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return NextResponse.json({ withdrawal_id, status, error: `Gateway reconciliation unavailable: ${message}` }, { status: 502 })
    }
    if (!gatewayResponse.ok) {
      await gatewayResponse.body?.cancel().catch(() => undefined)
      return NextResponse.json({ withdrawal_id, status, error: 'Gateway reconciliation unavailable' }, { status: 502 })
    }
    const gatewayStatus = classifyGatewayTransferStatus(await gatewayResponse.json().catch(() => null))
    if (gatewayStatus.kind === 'rejected') {
      const { data: released, error } = await supabase.from('seller_withdrawals').update({
        status: 'expired', last_error: `Gateway confirmed non-execution: ${gatewayStatus.detail}`.slice(0, 2048),
      }).eq('id', withdrawal_id).eq('status', 'submission_unknown').select('id').maybeSingle()
      if (error || !released) return NextResponse.json({ error: 'Failed to record confirmed Gateway rejection' }, { status: 503 })
      return NextResponse.json({ withdrawal_id, status: 'expired', error: gatewayStatus.detail }, { status: 502 })
    }
    if (gatewayStatus.kind !== 'accepted') {
      return NextResponse.json({ withdrawal_id, status: 'submission_unknown', error: gatewayStatus.detail },
        { status: gatewayStatus.kind === 'pending' ? 202 : 502 })
    }
    const { data: recovered, error } = await supabase.from('seller_withdrawals').update({
      status: 'pending_mint', attestation: gatewayStatus.attestation,
      attestation_signature: gatewayStatus.signature, last_error: null,
    }).eq('id', withdrawal_id).eq('status', 'submission_unknown').select('id').maybeSingle()
    if (error || !recovered) return NextResponse.json({ error: 'Failed to persist reconciled attestation' }, { status: 503 })
    attestation = gatewayStatus.attestation
    attestationSignature = gatewayStatus.signature
    status = 'pending_mint'
  }

  if (status === 'mint_unknown' && !row.mint_tx_hash) {
    return NextResponse.json({
      withdrawal_id, status,
      error: 'Arc mint submission is ambiguous without a durable transaction hash; manual reconciliation is required.',
    }, { status: 409 })
  }
  if (!attestation || !attestationSignature) {
    return NextResponse.json({ error: 'Withdrawal row is missing attestation payload' }, { status: 500 })
  }

  let mintTxHash = row.mint_tx_hash as Hex | null
  if (!mintTxHash) {
    const { data: claimed, error: claimError } = await supabase.from('seller_withdrawals').update({
      status: 'mint_unknown', last_error: 'Arc mint submission started; transaction hash not yet known',
    }).eq('id', withdrawal_id).eq('status', 'pending_mint').is('mint_tx_hash', null).select('id').maybeSingle()
    if (claimError || !claimed) {
      return NextResponse.json({ error: 'Withdrawal is already being reconciled' }, { status: 409 })
    }
    try {
      mintTxHash = await walletClient.writeContract({
        address: ARC.gatewayMinter,
        abi: GATEWAY_MINTER_ABI,
        functionName: 'gatewayMint',
        args: [attestation, attestationSignature],
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase.from('seller_withdrawals').update({ last_error: `Arc mint submission outcome unknown: ${message}`.slice(0, 2048) })
        .eq('id', withdrawal_id).eq('status', 'mint_unknown')
      return NextResponse.json({ withdrawal_id, status: 'mint_unknown',
        error: 'Arc mint submission outcome is unknown; automatic resubmission is disabled.' }, { status: 502 })
    }
    const { data: stored, error: storeError } = await supabase.from('seller_withdrawals').update({
      status: 'pending_mint', mint_tx_hash: mintTxHash, last_error: null,
    }).eq('id', withdrawal_id).eq('status', 'mint_unknown').select('id').maybeSingle()
    if (storeError || !stored) {
      return NextResponse.json({ withdrawal_id, mint_tx_hash: mintTxHash, status: 'mint_unknown',
        error: 'Mint transaction was submitted but its hash could not be durably stored.' }, { status: 500 })
    }
  }

  let mintStatus: 'minted' | 'failed'
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: mintTxHash,
      timeout: 60_000,
    })
    mintStatus = receipt.status === 'success' ? 'minted' : 'failed'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase.from('seller_withdrawals').update({ last_error: `Receipt poll failed: ${message}`.slice(0, 2048) })
      .eq('id', withdrawal_id).eq('status', 'pending_mint')
    return NextResponse.json(
      { withdrawal_id, mint_tx_hash: mintTxHash, status: 'pending_mint', error: `Receipt poll failed: ${message}` },
      { status: 502 },
    )
  }

  const { data: updated, error: updErr } = await supabase
    .from('seller_withdrawals')
    .update({
      status: mintStatus,
      mint_tx_hash: mintTxHash,
      minted_at: mintStatus === 'minted' ? new Date().toISOString() : null,
      last_error: mintStatus === 'failed' ? 'Mint transaction reverted on-chain' : null,
    })
    .eq('id', withdrawal_id)
    .eq('status', 'pending_mint')
    .select('id')
    .maybeSingle()

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  if (!updated) {
    const { data: latest } = await supabase.from('seller_withdrawals').select('status, mint_tx_hash')
      .eq('id', withdrawal_id).maybeSingle()
    if (latest?.status === 'minted') return NextResponse.json({ withdrawal_id, mint_tx_hash: latest.mint_tx_hash, status: 'minted' })
    return NextResponse.json({ error: 'Withdrawal status changed during reconciliation' }, { status: 409 })
  }

  return NextResponse.json({ withdrawal_id, mint_tx_hash: mintTxHash, status: mintStatus })
})
