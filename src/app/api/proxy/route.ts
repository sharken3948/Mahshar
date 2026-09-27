import { credentialProxyAllowed } from '@/lib/marketplace/listing-security'
import { NextRequest, NextResponse, after } from 'next/server'
import { proxyRequest } from '@/lib/proxy'
import { verifyAndSettlePayment, build402Response, paymentInfrastructureStatus, paymentResponseHeader } from '@/lib/gateway'
import { paymentErrorMessage } from '@/lib/payments/errors'
import { writeMemo } from '@/lib/memo'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveListingProxyMethod } from '@/lib/proxy-policy'
import { issuePurchaseAccess } from '@/lib/marketplace/purchase-access'
import { settlementStore } from '@/lib/payments/server'
import { beginDelivery, DeliveryRequestMismatchError, deliveryError, deliveryRequestHash, finishDelivery } from '@/lib/payments/delivery'
import { enforceRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const ingressLimit = await enforceRateLimit({ request, scope: 'proxy-ingress', limit: 180, windowSeconds: 60, failClosed: true })
  if (ingressLimit) return ingressLimit
  const body = await request.json().catch(() => null) as {
    api_id: string
    buyer_wallet: string
    method?: unknown
    path?: string
    incomingHeaders?: Record<string, string>
    body?: unknown
  } | null

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_request', message: 'A JSON proxy envelope is required.' }, { status: 400 })
  }

  const { api_id, buyer_wallet, method, path, incomingHeaders, body: reqBody } = body

  if (!api_id || !buyer_wallet) {
    return NextResponse.json({ error: 'api_id and buyer_wallet are required' }, { status: 400 })
  }

  // Fetch API listing
  const supabase = createServiceClient()
  const { data: listing, error } = await supabase
    .from('api_listings')
    .select('id, name, price_per_call, seller_wallet, encrypted_key, verified_at, is_active, method')
    .eq('id', api_id)
    .single()

  if (error || !listing) {
    return NextResponse.json({ error: 'API not found' }, { status: 404 })
  }

  if (!listing.is_active) {
    return NextResponse.json({ error: 'API is not active' }, { status: 403 })
  }

  if (!credentialProxyAllowed(listing)) return NextResponse.json({ error: 'Endpoint requires verification' }, { status: 409 })

  const sellerAddress = listing.seller_wallet as `0x${string}`
  const priceUsd = Number(listing.price_per_call)
  const resolvedMethod = resolveListingProxyMethod(method, listing.method)
  if ('error' in resolvedMethod) {
    return NextResponse.json({ error: resolvedMethod.error }, { status: 400 })
  }

  // Check for payment
  const paymentSignature = request.headers.get('payment-signature')
  if (!paymentSignature) {
    const probeLimit = await enforceRateLimit({ request, scope: 'proxy-probe', limit: 120, windowSeconds: 60, dimensions: [api_id], failClosed: true })
    if (probeLimit) return probeLimit
    const infrastructure = await paymentInfrastructureStatus()
    if (!infrastructure.ready) {
      return NextResponse.json({ error: infrastructure.error, message: paymentErrorMessage(infrastructure.error) }, { status: infrastructure.status })
    }
    return build402Response(priceUsd, new URL('/api/proxy', request.url).toString())
  }

  const verificationLimit = await enforceRateLimit({ request, scope: 'proxy-payment', limit: 60, windowSeconds: 60, dimensions: [api_id], failClosed: true })
  if (verificationLimit) return verificationLimit

  // Verify and settle payment
  const paymentResult = await verifyAndSettlePayment(
    request,
    priceUsd,
    sellerAddress,
    api_id,
  )

  if (!paymentResult.success) {
    return NextResponse.json({
      error: paymentResult.error,
      message: paymentErrorMessage(paymentResult.error, undefined, paymentResult.attemptId),
      attemptId: paymentResult.attemptId,
    }, { status: paymentResult.status ?? 402 })
  }

  if (!paymentResult.payer || !paymentResult.attemptId || !paymentResult.callId) {
    return NextResponse.json({ error: 'Payment settled but payer address is missing' }, { status: 402 })
  }

  const purchaseAccessToken = issuePurchaseAccess({ purchaseId: paymentResult.callId, apiId: api_id, buyerWallet: paymentResult.payer })
  const paidHeaders = { 'Cache-Control': 'no-store', 'PAYMENT-RESPONSE': paymentResponseHeader(paymentResult) }
  let delivery
  try {
    delivery = await beginDelivery(settlementStore(), paymentResult.attemptId, deliveryRequestHash({
      apiId: api_id, method: resolvedMethod.method, path: path ?? '', body: reqBody,
    }))
  } catch (error) {
    const mismatch = error instanceof DeliveryRequestMismatchError
    return NextResponse.json({
      error: mismatch ? 'delivery_request_mismatch' : 'delivery_state_unavailable', delivery_state: 'UNKNOWN', retryable: false,
      payment: 'ACCOUNTING_COMPLETE', purchaseId: paymentResult.callId, attemptId: paymentResult.attemptId,
      purchase_access_token: purchaseAccessToken,
    }, { status: mismatch ? 409 : 503, headers: paidHeaders })
  }
  if (!delivery.execute) {
    const state = deliveryError(delivery.attempt)
    return NextResponse.json({
      ...(state.delivery_state === 'SUCCEEDED' ? { payment: 'ACCOUNTING_COMPLETE' } : { error: state.code }),
      delivery_state: state.delivery_state, retryable: state.retryable, purchaseId: paymentResult.callId,
      attemptId: paymentResult.attemptId, upstreamRetried: false, purchase_access_token: purchaseAccessToken,
      ...(state.delivery_state === 'SUCCEEDED' ? { retrieve_response: '/api/calls/last-response' } : {}),
    }, { status: state.status, headers: paidHeaders })
  }

  // Payment settled — proxy the request
  const result = await proxyRequest({
    apiId: api_id,
    buyerWallet: paymentResult.payer,
    paymentType: 'pay-per-call',
    method: resolvedMethod.method,
    path: path ?? '',
    incomingHeaders: incomingHeaders ?? {},
    body: reqBody,
  })

  let persistedDeliveryState = result.deliveryOutcome === 'succeeded' ? 'SUCCEEDED' :
    result.deliveryOutcome === 'failed_retryable' ? 'FAILED_RETRYABLE' :
      result.deliveryOutcome === 'failed_final' ? 'FAILED_FINAL' : 'UNKNOWN'
  try {
    const completed = await finishDelivery(settlementStore(), paymentResult.attemptId, delivery.token, result)
    persistedDeliveryState = completed.delivery_state ?? persistedDeliveryState
  } catch {
    persistedDeliveryState = 'UNKNOWN'
  }

  // Deferred via `after` so the memo tx is guaranteed to complete on Vercel
  // serverless — a bare fire-and-forget promise freezes when the response ships.
  if (persistedDeliveryState === 'SUCCEEDED' || persistedDeliveryState === 'FAILED_FINAL') after(() =>
    writeMemo(
      listing.name as string,
      sellerAddress,
      paymentResult.callId ?? api_id,
    ).catch(err => console.error('[memo] failed:', (err as Error).message ?? err))
  )

  return NextResponse.json(
    {
      response: result.body,
      latency_ms: result.latencyMs,
      payment: 'ACCOUNTING_COMPLETE',
      delivery_state: persistedDeliveryState,
      retryable: persistedDeliveryState === 'FAILED_RETRYABLE',
      attemptId: paymentResult.attemptId,
      purchase_access_token: purchaseAccessToken,
    },
    { status: result.status, headers: paidHeaders }
  )
}
