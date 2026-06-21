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
    return NextResponse.json({ total_earnings: 0, earnings_by_api: [] })
  }

  const { data: purchases, error: purchasesError } = await supabase
    .from('purchases')
    .select('id, amount_usdc, api_id, buyer_wallet, created_at')
    .in('api_id', apiIds)
    .order('created_at', { ascending: false })

  if (purchasesError) return NextResponse.json({ error: purchasesError.message }, { status: 500 })

  const nameById = new Map(apis.map(a => [a.id, a.name]))
  const byApi = new Map<string, { api_name: string; total: number; calls: number }>()
  let total_earnings = 0

  for (const row of purchases ?? []) {
    const amount = parseFloat(String(row.amount_usdc))
    if (!isFinite(amount)) continue
    const existing = byApi.get(row.api_id) ?? { api_name: nameById.get(row.api_id) ?? 'Unknown', total: 0, calls: 0 }
    existing.total = parseFloat((existing.total + amount).toFixed(6))
    existing.calls += 1
    byApi.set(row.api_id, existing)
    total_earnings = parseFloat((total_earnings + amount).toFixed(6))
  }

  return NextResponse.json({
    total_earnings,
    earnings_by_api: Array.from(byApi.entries()).map(([api_id, v]) => ({ api_id, ...v })),
    payouts: (purchases ?? []).map(p => ({
      id: p.id,
      api_name: nameById.get(p.api_id) ?? 'Unknown',
      buyer_wallet: p.buyer_wallet,
      amount_usdc: p.amount_usdc,
      created_at: p.created_at,
    })),
  })
}
