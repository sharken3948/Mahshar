import { withWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { aggregateSellerStatistics, type SellerPurchaseRow, type SellerWithdrawalRow } from '@/lib/marketplace/seller-statistics'

export const runtime = 'nodejs'

export const GET = withWalletSession(async (request: NextRequest, sellerWallet: string) => {
  const { searchParams } = new URL(request.url)
  assertWalletClaim(searchParams.get('seller_wallet'), sellerWallet)

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
  const statistics = aggregateSellerStatistics(
    (purchases ?? []) as SellerPurchaseRow[],
    (withdrawals ?? []) as SellerWithdrawalRow[],
    nameById,
  )

  return NextResponse.json({
    ...statistics,
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
})
