import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sellerWallet = searchParams.get('seller_wallet')
  if (!sellerWallet) return NextResponse.json({ error: 'seller_wallet required' }, { status: 400 })
  if (!isValidWalletAddress(sellerWallet)) return NextResponse.json({ error: 'Invalid seller_wallet address' }, { status: 400 })

  const supabase = createServiceClient()

  const { data: apis, error: apisError } = await supabase
    .from('api_listings')
    .select('id, name')
    .ilike('seller_wallet', sellerWallet)

  if (apisError) return NextResponse.json({ error: apisError.message }, { status: 500 })

  const apiIds = (apis ?? []).map(a => a.id)
  if (apiIds.length === 0) {
    return NextResponse.json({
      total_earnings: 0,
      accumulated_share: 0,
      in_flight_withdrawals: 0,
      withdrawable_balance: 0,
      earnings_by_api: [],
      payouts: [],
      withdrawals: [],
    })
  }

  const { data: purchases, error: purchasesError } = await supabase
    .from('purchases')
    .select('id, amount_usdc, seller_share_usdc, api_id, buyer_wallet, created_at')
    .in('api_id', apiIds)
    .order('created_at', { ascending: false })

  if (purchasesError) return NextResponse.json({ error: purchasesError.message }, { status: 500 })

  const { data: withdrawals, error: withdrawalsError } = await supabase
    .from('seller_withdrawals')
    .select('id, amount_usdc, net_amount_usdc, gas_cost_usdc, status, mint_tx_hash, created_at, minted_at')
    .ilike('seller_wallet', sellerWallet)
    .order('created_at', { ascending: false })

  if (withdrawalsError) return NextResponse.json({ error: withdrawalsError.message }, { status: 500 })

  const nameById = new Map(apis.map(a => [a.id, a.name]))
  const byApi = new Map<string, { api_name: string; total: number; calls: number }>()
  let total_earnings = 0
  let accumulated_share = 0

  for (const row of purchases ?? []) {
    const amount = parseFloat(String(row.amount_usdc))
    if (!isFinite(amount)) continue
    const existing = byApi.get(row.api_id) ?? { api_name: nameById.get(row.api_id) ?? 'Unknown', total: 0, calls: 0 }
    existing.total = parseFloat((existing.total + amount).toFixed(6))
    existing.calls += 1
    byApi.set(row.api_id, existing)
    total_earnings = parseFloat((total_earnings + amount).toFixed(6))

    // seller_share_usdc is null for purchases that pre-date the Phase 2 migration —
    // those were paid out on-chain already, so they don't add to withdrawable_balance.
    const share = row.seller_share_usdc == null ? null : parseFloat(String(row.seller_share_usdc))
    if (share != null && isFinite(share)) {
      accumulated_share = parseFloat((accumulated_share + share).toFixed(6))
    }
  }

  let in_flight_withdrawals = 0
  for (const w of withdrawals ?? []) {
    // failed rows still consume balance — Circle already reserved our Gateway
    // funds when it issued the attestation; ops reconciles refunds manually.
    if (w.status === 'pending_mint' || w.status === 'minted' || w.status === 'failed') {
      const amt = parseFloat(String(w.amount_usdc))
      if (isFinite(amt)) in_flight_withdrawals = parseFloat((in_flight_withdrawals + amt).toFixed(6))
    }
  }

  const withdrawable_balance = parseFloat((accumulated_share - in_flight_withdrawals).toFixed(6))

  return NextResponse.json({
    total_earnings,
    accumulated_share,
    in_flight_withdrawals,
    withdrawable_balance,
    earnings_by_api: Array.from(byApi.entries()).map(([api_id, v]) => ({ api_id, ...v })),
    payouts: (purchases ?? []).map(p => ({
      id: p.id,
      api_name: nameById.get(p.api_id) ?? 'Unknown',
      buyer_wallet: p.buyer_wallet,
      amount_usdc: p.amount_usdc,
      seller_share_usdc: p.seller_share_usdc,
      created_at: p.created_at,
    })),
    withdrawals: withdrawals ?? [],
  })
}
