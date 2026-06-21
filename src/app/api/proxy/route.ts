import { NextRequest, NextResponse } from 'next/server'
import { proxyRequest } from '@/lib/proxy'
import { verifyAndSettlePayment, build402Response } from '@/lib/gateway'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    api_id: string
    buyer_wallet: string
    method?: string
    path?: string
    incomingHeaders?: Record<string, string>
    body?: unknown
  }

  const { api_id, buyer_wallet, method, path, incomingHeaders, body: reqBody } = body

  if (!api_id || !buyer_wallet) {
    return NextResponse.json({ error: 'api_id and buyer_wallet are required' }, { status: 400 })
  }

  // Fetch API listing
  const supabase = createServiceClient()
  const { data: listing, error } = await supabase
    .from('api_listings')
    .select('id, price_per_call, seller_wallet, is_active, method')
    .eq('id', api_id)
    .single()

  if (error || !listing) {
    return NextResponse.json({ error: 'API not found' }, { status: 404 })
  }

  if (!listing.is_active) {
    return NextResponse.json({ error: 'API is not active' }, { status: 403 })
  }

  const sellerAddress = listing.seller_wallet as `0x${string}`
  const priceUsd = Number(listing.price_per_call)
  const listingMethod = (listing.method as string | null) ?? 'GET'

  // Check for payment
  const paymentSignature = request.headers.get('payment-signature')
  if (!paymentSignature) {
    return build402Response(priceUsd)
  }

  // Verify and settle payment
  const paymentResult = await verifyAndSettlePayment(
    request,
    priceUsd,
    sellerAddress,
    api_id,
  )

  if (!paymentResult.success) {
    return NextResponse.json({ error: paymentResult.error }, { status: 402 })
  }

  // Verify the payment signer matches the declared buyer_wallet to prevent spoofing
  if (paymentResult.payer?.toLowerCase() !== buyer_wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Payment signer does not match buyer_wallet' }, { status: 400 })
  }

  // Payment settled — proxy the request
  const result = await proxyRequest({
    apiId: api_id,
    buyerWallet: buyer_wallet,
    paymentType: 'pay-per-call',
    method: method ?? listingMethod,
    path: path ?? '',
    incomingHeaders: incomingHeaders ?? {},
    body: reqBody,
  })

  return NextResponse.json(
    { response: result.body, latency_ms: result.latencyMs },
    { status: result.status }
  )
}
