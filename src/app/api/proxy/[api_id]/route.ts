import { credentialProxyAllowed } from '@/lib/marketplace/listing-security'
import { NextRequest, NextResponse, after } from 'next/server'
import { proxyRequest, proxyResponseEnvelope } from '@/lib/proxy'
import { verifyAndSettlePayment, build402Response, paymentInfrastructureStatus, paymentResponseHeader } from '@/lib/gateway'
import { paymentErrorMessage } from '@/lib/payments/errors'
import { writeMemo } from '@/lib/memo'
import { createServiceClient } from '@/lib/supabase/server'
import { issuePurchaseAccess } from '@/lib/marketplace/purchase-access'
import { resolveListingProxyMethod } from '@/lib/proxy-policy'
import { settlementStore } from '@/lib/payments/server'
import { beginDelivery, DeliveryRequestMismatchError, deliveryError, deliveryRequestHash, finishDelivery } from '@/lib/payments/delivery'
import { enforceRateLimit } from '@/lib/rate-limit'
import { authorizeProxyTarget, ProxyTargetError } from '@/lib/marketplace/proxy-target'
import { marketplaceOrigin } from '@/lib/marketplace/server'
import { validateRequestBody } from '@/lib/marketplace/request-body-schema'
import { readBoundedText, RequestBodyError } from '@/lib/request-body'

export const runtime = 'nodejs'

async function handle(request: NextRequest, apiId: string, method: 'GET' | 'POST') {
  const ingressLimit = await enforceRateLimit({ request, scope: 'proxy-ingress', limit: 180, windowSeconds: 60, failClosed: true })
  if (ingressLimit) return ingressLimit
  if (!apiId) {
    return NextResponse.json({ error: 'api_id is required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: listing, error } = await supabase
    .from('api_listings')
    .select('id, name, price_per_call, seller_wallet, encrypted_key, verified_at, is_active, method, endpoint_url, auth_type, auth_param_name, body_required, request_schema, dynamic_path_supported, path_parameters, query_parameters')
    .eq('id', apiId)
    .single()

  if (error || !listing) {
    return NextResponse.json({ error: 'API not found' }, { status: 404 })
  }
  if (!listing.is_active) {
    return NextResponse.json({ error: 'API is not active' }, { status: 403 })
  }

  if (!credentialProxyAllowed(listing)) return NextResponse.json({ error: 'Endpoint requires verification' }, { status: 409 })

  const resolvedMethod = resolveListingProxyMethod(method, listing.method)
  if ('error' in resolvedMethod) {
    return NextResponse.json({ error: resolvedMethod.error }, { status: 405 })
  }

  const sellerAddress = listing.seller_wallet as `0x${string}`
  const priceUsd = Number(listing.price_per_call)
  const requestSuffix = request.nextUrl.search
  let canonicalTarget: string
  try { canonicalTarget = authorizeProxyTarget(listing, requestSuffix).toString() }
  catch (targetError) {
    const code = targetError instanceof ProxyTargetError ? targetError.code : 'invalid_dynamic_path'
    return NextResponse.json({ error: code }, { status: 400 })
  }

  // Validate the paid request payload before presenting a 402 so an agent is
  // never charged for JSON that Mahshar cannot forward.
  let upstreamBody: unknown = undefined
  if (method === 'POST') {
    let rawBody: string
    try { rawBody = await readBoundedText(request.clone(), 256 * 1024) }
    catch (error) {
      const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
      return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' }, { status: tooLarge ? 413 : 400 })
    }
    if (rawBody.trim()) {
      try { upstreamBody = JSON.parse(rawBody) }
      catch { return NextResponse.json({ error: 'invalid_request', message: 'POST body must be valid JSON.' }, { status: 400 }) }
    }
  }
  if (listing.body_required === true && upstreamBody === undefined) {
    return NextResponse.json({ error: 'request_body_required', message: 'POST listing requires a JSON request body.' }, { status: 400 })
  }
  if (upstreamBody !== undefined) {
    const bodyValidation = validateRequestBody(listing.request_schema, upstreamBody)
    if (!bodyValidation.ok) {
      return NextResponse.json({ error: 'request_contract_invalid', message: bodyValidation.error }, { status: 400 })
    }
  }

  const resourceUrl = new URL(`/api/proxy/${encodeURIComponent(apiId)}${requestSuffix}`, marketplaceOrigin()).toString()

  const paymentSignature = request.headers.get('payment-signature')
  if (!paymentSignature) {
    const probeLimit = await enforceRateLimit({ request, scope: 'proxy-probe', limit: 120, windowSeconds: 60, dimensions: [apiId], failClosed: true })
    if (probeLimit) return probeLimit
    const infrastructure = await paymentInfrastructureStatus()
    if (!infrastructure.ready) {
      return NextResponse.json({ error: infrastructure.error, message: paymentErrorMessage(infrastructure.error) }, { status: infrastructure.status })
    }
    return build402Response(priceUsd, resourceUrl)
  }

  const verificationLimit = await enforceRateLimit({ request, scope: 'proxy-payment', limit: 60, windowSeconds: 60, dimensions: [apiId], failClosed: true })
  if (verificationLimit) return verificationLimit

  const paymentResult = await verifyAndSettlePayment(request, priceUsd, sellerAddress, apiId)
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

  const purchaseAccessToken = issuePurchaseAccess({ purchaseId: paymentResult.callId, apiId, buyerWallet: paymentResult.payer })
  const paidHeaders = { 'Cache-Control': 'no-store', 'PAYMENT-RESPONSE': paymentResponseHeader(paymentResult) }
  let delivery
  try {
    delivery = await beginDelivery(settlementStore(), paymentResult.attemptId, deliveryRequestHash({
      apiId, method: resolvedMethod.method, target: canonicalTarget, body: upstreamBody,
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

  const result = await proxyRequest({
    apiId,
    buyerWallet: paymentResult.payer,
    paymentType: 'pay-per-call',
    purchaseId: paymentResult.callId,
    deliveryAttemptId: paymentResult.attemptId,
    purchaseAccessToken,
    method: resolvedMethod.method,
    dynamicPath: requestSuffix,
    canonicalTarget,
    incomingHeaders: {},
    body: upstreamBody,
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

  if (result.deliveryOutcome === 'succeeded' && persistedDeliveryState !== 'SUCCEEDED') {
    return NextResponse.json({
      error: 'delivery_state_unavailable', payment: 'ACCOUNTING_COMPLETE', delivery_state: 'UNKNOWN', retryable: false,
      attemptId: paymentResult.attemptId, purchase_access_token: purchaseAccessToken,
      ...(result.responsePersisted ? { retrieve_response: '/api/calls/last-response' } : {}),
    }, { status: 503, headers: paidHeaders })
  }

  // Deferred via `after` so the memo tx is guaranteed to complete on Vercel
  // serverless — a bare fire-and-forget promise freezes when the response ships.
  if (persistedDeliveryState === 'SUCCEEDED' || persistedDeliveryState === 'FAILED_FINAL') after(() =>
    writeMemo(
      listing.name as string,
      sellerAddress,
      paymentResult.callId ?? apiId,
    ).catch(err => console.error('[memo] failed:', (err as Error).message ?? err))
  )

  return NextResponse.json(
    proxyResponseEnvelope({ body: result.body, latencyMs: result.latencyMs, deliveryState: persistedDeliveryState,
      retryable: persistedDeliveryState === 'FAILED_RETRYABLE', attemptId: paymentResult.attemptId, purchaseAccessToken }),
    { status: result.status, headers: paidHeaders }
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
