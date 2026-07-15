import { NextRequest, NextResponse, after } from 'next/server'
import { proxyRequest } from '@/lib/proxy'
import { verifyAndSettlePayment, build402Response } from '@/lib/gateway'
import { writeMemo } from '@/lib/memo'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

async function handle(request: NextRequest, apiId: string, method: 'GET' | 'POST') {
  if (!apiId) {
    return NextResponse.json({ error: 'api_id is required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: listing, error } = await supabase
    .from('api_listings')
    .select('id, name, price_per_call, seller_wallet, is_active')
    .eq('id', apiId)
    .single()

  if (error || !listing) {
    return NextResponse.json({ error: 'API not found' }, { status: 404 })
  }
  if (!listing.is_active) {
    return NextResponse.json({ error: 'API is not active' }, { status: 403 })
  }

  const sellerAddress = listing.seller_wallet as `0x${string}`
  const priceUsd = Number(listing.price_per_call)

  const resourceUrl = `/api/proxy/${apiId}`

  const paymentSignature = request.headers.get('payment-signature')
  if (!paymentSignature) {
    return build402Response(priceUsd, resourceUrl)
  }

  const paymentResult = await verifyAndSettlePayment(request, priceUsd, sellerAddress, apiId)
  if (!paymentResult.success) {
    return NextResponse.json({ error: paymentResult.error }, { status: 402 })
  }
  if (!paymentResult.payer) {
    return NextResponse.json({ error: 'Payment settled but payer address is missing' }, { status: 402 })
  }

  // Path-route semantics: raw request body is forwarded upstream as-is (POST only).
  // buyer identity = settled payer EOA (SCA identity not recoverable at this layer).
  let upstreamBody: unknown = undefined
  if (method === 'POST') {
    try {
      upstreamBody = await request.json()
    } catch {
      upstreamBody = undefined
    }
  }

  const result = await proxyRequest({
    apiId,
    buyerWallet: paymentResult.payer,
    paymentType: 'pay-per-call',
    method,
    path: '',
    incomingHeaders: {},
    body: upstreamBody,
  })

  // Deferred via `after` so the memo tx is guaranteed to complete on Vercel
  // serverless — a bare fire-and-forget promise freezes when the response ships.
  after(
    writeMemo(
      listing.name as string,
      sellerAddress,
      paymentResult.callId ?? apiId,
    ).catch(err => console.error('[memo] failed:', (err as Error).message ?? err))
  )

  return NextResponse.json(
    { response: result.body, latency_ms: result.latencyMs },
    { status: result.status }
  )
}

type Ctx = { params: Promise<{ api_id: string }> }

export async function POST(request: NextRequest, ctx: Ctx) {
  const { api_id } = await ctx.params
  return handle(request, api_id, 'POST')
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const { api_id } = await ctx.params
  return handle(request, api_id, 'GET')
}
