import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { arcMainnet, arcTestnet } from '@/lib/chains'
import { buildConfirmMessage, WITHDRAW_TIMESTAMP_WINDOW_SECONDS } from '@/lib/withdraw-auth-message'
import { ARC, ARC_MAINNET, GATEWAY_MINTER_ABI } from '@/lib/arc'
import { PLATFORM_PRIVATE_KEY } from '@/lib/gateway'

export const runtime = 'nodejs'

// Recovery for stuck pending_mint rows. The main withdraw route inserts the
// row BEFORE submitting the mint tx, so a crash between the two leaves an
// attestation stranded in the DB. This route re-submits the mint using the
// stored attestation + signature. Idempotent: if the original mint actually
// landed on-chain, the contract's replay guard rejects the retry and we
// mark the row failed for ops to look at.
export async function POST(request: NextRequest) {
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

  const supabase = createServiceClient()

  const isMainnet = ARC.chainId === ARC_MAINNET.chainId
  const chain = isMainnet ? arcMainnet : arcTestnet
  const rpcUrl = isMainnet ? process.env.ARC_MAINNET_RPC_URL : undefined
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

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
    sigValid = await publicClient.verifyMessage({
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
  const { error: nonceErr } = await supabase
    .from('withdraw_used_nonces')
    .insert({ nonce, seller_wallet: seller_wallet.toLowerCase() })
  if (nonceErr) {
    if (nonceErr.code === '23505') {
      return NextResponse.json({ error: 'Nonce has already been used.' }, { status: 401 })
    }
    return NextResponse.json({ error: nonceErr.message }, { status: 500 })
  }

  const { data: row, error: readErr } = await supabase
    .from('seller_withdrawals')
    .select('id, seller_wallet, status, attestation, attestation_signature')
    .eq('id', withdrawal_id)
    .single()
  if (readErr || !row) {
    return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
  }
  if (String(row.seller_wallet).toLowerCase() !== seller_wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Withdrawal does not belong to this seller' }, { status: 403 })
  }
  if (row.status !== 'pending_mint') {
    return NextResponse.json(
      { error: `Withdrawal already in status ${row.status}; nothing to recover.` },
      { status: 409 },
    )
  }
  if (!row.attestation || !row.attestation_signature) {
    return NextResponse.json({ error: 'Withdrawal row is missing attestation payload' }, { status: 500 })
  }

  const account = privateKeyToAccount(PLATFORM_PRIVATE_KEY)
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })

  let mintTxHash: Hex
  try {
    mintTxHash = await walletClient.writeContract({
      address: ARC.gatewayMinter,
      abi: GATEWAY_MINTER_ABI,
      functionName: 'gatewayMint',
      args: [row.attestation as Hex, row.attestation_signature as Hex],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Retry mint submit failed: ${message}` }, { status: 502 })
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
    return NextResponse.json(
      { withdrawal_id, mint_tx_hash: mintTxHash, status: 'pending_mint', error: `Receipt poll failed: ${message}` },
      { status: 502 },
    )
  }

  const { error: updErr } = await supabase
    .from('seller_withdrawals')
    .update({
      status: mintStatus,
      mint_tx_hash: mintTxHash,
      minted_at: mintStatus === 'minted' ? new Date().toISOString() : null,
    })
    .eq('id', withdrawal_id)
    .eq('status', 'pending_mint')

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ withdrawal_id, mint_tx_hash: mintTxHash, status: mintStatus })
}
