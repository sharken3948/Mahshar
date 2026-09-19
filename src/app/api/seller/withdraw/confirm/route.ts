import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { arcMainnet, arcTestnet } from '@/lib/chains'
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
  }

  const { withdrawal_id, seller_wallet } = body
  if (!withdrawal_id) {
    return NextResponse.json({ error: 'withdrawal_id required' }, { status: 400 })
  }
  if (!seller_wallet || !isValidWalletAddress(seller_wallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet' }, { status: 400 })
  }

  const supabase = createServiceClient()
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

  const isMainnet = ARC.chainId === ARC_MAINNET.chainId
  const chain = isMainnet ? arcMainnet : arcTestnet
  const rpcUrl = isMainnet ? process.env.ARC_MAINNET_RPC_URL : undefined
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
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
