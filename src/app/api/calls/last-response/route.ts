import { marketplaceErrors, requireOperationAuthorization } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { issuePurchaseAccess, PURCHASE_ACCESS_HEADER, verifyPurchaseAccess } from '@/lib/marketplace/purchase-access'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export const GET = marketplaceErrors(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url)
  const apiId = searchParams.get('api_id')
  if (!apiId) return NextResponse.json({ error: 'api_id required' }, { status: 400 })

  const supabase = createServiceClient()
  const suppliedAccess = request.headers.get(PURCHASE_ACCESS_HEADER)
  const access = verifyPurchaseAccess(suppliedAccess)
  let buyerWallet: string
  let purchaseId: string | null = null

  if (suppliedAccess) {
    if (!access || access.apiId !== apiId) return NextResponse.json({ error: 'Invalid purchase access' }, { status: 401 })
    assertWalletClaim(searchParams.get('buyer_wallet'), access.buyerWallet)
    buyerWallet = access.buyerWallet
    purchaseId = access.purchaseId
  } else {
    // Legacy purchases can exchange one operation proof for a durable,
    // purchase-scoped read capability. Subsequent reads need no signature.
    buyerWallet = await requireOperationAuthorization(request)
    assertWalletClaim(searchParams.get('buyer_wallet'), buyerWallet)
  }

  // Ownership always comes from the stored purchase row. The query-string
  // wallet is only a consistency check and is never accepted as proof.
  let purchaseQuery = supabase.from('purchases').select('id')
    .eq('api_id', apiId).eq('buyer_wallet', buyerWallet)
  if (purchaseId) purchaseQuery = purchaseQuery.eq('id', purchaseId)
  const { data: purchase, error: purchaseError } = await purchaseQuery.limit(1).maybeSingle()
  if (purchaseError) return NextResponse.json({ error: 'Purchase lookup failed' }, { status: 500 })
  if (!purchase) return NextResponse.json({ error: 'Purchase access denied' }, { status: 403 })
  const { data, error } = await supabase
    .from('api_calls')
    .select('response_body')
    .eq('api_id', apiId)
    .eq('buyer_wallet', buyerWallet.toLowerCase())
    .eq('success', true)
    .not('response_body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    return NextResponse.json({
      response_body: null,
      purchase_access_token: issuePurchaseAccess({ purchaseId: purchase.id, apiId, buyerWallet }),
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({
    response_body: (data as { response_body: unknown }).response_body,
    purchase_access_token: issuePurchaseAccess({ purchaseId: purchase.id, apiId, buyerWallet }),
  }, { headers: { 'Cache-Control': 'no-store' } })
})
