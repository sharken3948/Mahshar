import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { aggregateSellerStatistics, paidCallCount, type SellerPurchaseRow, type SellerWithdrawalRow } from '@/lib/marketplace/seller-statistics'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { PUBLIC_LISTING_COLUMNS, publicListing } from '@/lib/marketplace/public-listing'

export const runtime = 'nodejs'

type Context = { params: Promise<{ wallet: string }> }

/**
 * Public, read-only seller summary keyed by a public wallet address.
 *
 * The response is deliberately limited to aggregate purchase/accounting totals
 * and non-secret listing metadata needed to render the seller dashboard.
 * Private edit configuration is fetched separately with an owner proof. It never returns credentials, buyer wallets, payout rows,
 * withdrawal rows or hashes, or response history.
 */
export async function GET(_request: Request, { params }: Context) {
  const { wallet: walletParam } = await params
  let sellerWallet: string
  try {
    sellerWallet = decodeURIComponent(walletParam).toLowerCase()
  } catch {
    return NextResponse.json({ error: 'Invalid seller wallet' }, { status: 400 })
  }
  if (!isValidWalletAddress(sellerWallet)) {
    return NextResponse.json({ error: 'Invalid seller wallet' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: listings, error: listingsError } = await supabase
    .from('api_listings')
    .select(PUBLIC_LISTING_COLUMNS)
    .ilike('seller_wallet', sellerWallet)
    .order('created_at', { ascending: false })

  if (listingsError) return NextResponse.json({ error: listingsError.message }, { status: 500 })

  const safeListings = ((listings ?? []) as unknown as Record<string, unknown>[]).map(publicListing)
  const apiIds = safeListings.map(listing => listing.id)
  if (apiIds.length === 0) {
    return NextResponse.json({
      total_earnings: 0,
      accumulated_share: 0,
      in_flight_withdrawals: 0,
      withdrawable_balance: 0,
      earnings_by_api: [],
      total_calls: 0,
      listings: [],
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const [{ data: purchases, error: purchasesError }, { data: withdrawals, error: withdrawalsError }] = await Promise.all([
    supabase
      .from('purchases')
      .select('id, amount_usdc, seller_share_usdc, api_id')
      .in('api_id', apiIds),
    supabase
      .from('seller_withdrawals')
      .select('amount_usdc, status')
      .ilike('seller_wallet', sellerWallet),
  ])

  if (purchasesError) return NextResponse.json({ error: purchasesError.message }, { status: 500 })
  if (withdrawalsError) return NextResponse.json({ error: withdrawalsError.message }, { status: 500 })

  const statistics = aggregateSellerStatistics(
    (purchases ?? []) as SellerPurchaseRow[],
    (withdrawals ?? []) as SellerWithdrawalRow[],
    new Map(safeListings.map(listing => [String(listing.id), String(listing.name)])),
  )

  return NextResponse.json({
    ...statistics,
    total_calls: paidCallCount(statistics),
    listings: safeListings,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
