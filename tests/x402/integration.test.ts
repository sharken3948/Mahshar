import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server.js'
import { state } from './integration-fixture'
import { apiId, MemoryStore, payer, payment, seller } from './fixture'
import { build402Response, verifyAndSettlePayment } from '../../src/lib/gateway'
import { POST } from '../../src/app/api/proxy/route'
import { POST as reconcile } from '../../src/app/api/payments/reconcile/route'
import { POST as retiredLegacy } from '../../src/app/api/payments/x402/route'
import { GET as pathProxyGet, POST as pathProxyPost } from '../../src/app/api/proxy/[api_id]/route'

function reset() { state.store = new MemoryStore(); state.storageReady = true; state.settled = 0; state.proxied = 0; state.verified = 0; state.upstreamStatus = 200; state.deliveryOutcome = undefined; state.listingMethod = 'POST' }
function paid() { return new NextRequest('https://mahshar.xyz/api/proxy', { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') }, body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', body: { input: true } }) }) }
test('real gateway pricing and normal paid proxy retain authoritative amount and Arc facilitator configuration', async () => {
  reset()
  const probe = build402Response(0.001)
  const req = JSON.parse(Buffer.from(probe.headers.get('payment-required')!, 'base64').toString())
  assert.deepEqual(req.accepts.map((r: {network: string}) => r.network), ['eip155:5042']); assert.equal(probe.status, 402); assert.deepEqual(req.accepts.map((r: {amount: string}) => r.amount), ['1100'])
  const result = await POST(paid()); assert.equal(result.status, 200); assert.equal(state.settled, 1); assert.equal(state.proxied, 1)
  const paymentResponse = JSON.parse(Buffer.from(result.headers.get('payment-response')!, 'base64').toString())
  assert.equal(paymentResponse.success, true); assert.equal(paymentResponse.network, 'eip155:5042'); assert.equal(paymentResponse.transaction, 'sdk-canonical-id')
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(typeof (await result.json()).purchase_access_token, 'string')
  assert.equal([...state.store.rows.values()][0].binding.seller_atomic, '900')
  assert.ok(state.configs.some(c => c.arcPrivateMainnet === true))
  const replay = await POST(paid()); assert.equal(replay.status, 200); assert.equal(state.settled, 1); assert.equal(state.proxied, 1)
  assert.equal(replay.headers.get('cache-control'), 'no-store')
  assert.equal(typeof (await replay.json()).purchase_access_token, 'string')
})
test('actual gateway returns 503, not duplicate/payment-required, for confirmed accounting failure', async () => {
  reset(); state.store.failAccounting = true
  const response = await POST(paid()); assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'payment_accounting_unavailable'); assert.equal(state.proxied, 0)
  state.store.failAccounting = false
  const retry = await POST(paid()); assert.equal(retry.status, 200); assert.equal(state.settled, 1); assert.equal(state.proxied, 1)
})
test('missing durable storage fails before 402 signing or settlement with a clear response', async () => {
  reset(); state.storageReady = false
  const response = await POST(new NextRequest('https://mahshar.xyz/api/proxy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_id: apiId, buyer_wallet: payer }) }))
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.error, 'payment_storage_unavailable')
  assert.match(body.message, /Secure payment recording is temporarily unavailable/)
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)
})
test('real proxy upstream 500 keeps durable purchase and never executes the paid call again', async () => {
  reset(); state.upstreamStatus = 500
  assert.equal((await POST(paid())).status, 500); assert.equal(state.store.purchases.size, 1)
  const replay = await POST(paid()); assert.equal(replay.status, 409); assert.equal(state.proxied, 1); assert.equal(state.settled, 1)
  assert.equal((await replay.json()).error, 'delivery_failed_final')
})
test('upstream 4xx is a completed final delivery and is not executed again', async () => {
  reset(); state.upstreamStatus = 400
  const first = await POST(paid()); assert.equal(first.status, 400); assert.equal((await first.json()).delivery_state, 'FAILED_FINAL')
  const replay = await POST(paid()); assert.equal(replay.status, 409); assert.equal((await replay.json()).error, 'delivery_failed_final')
  assert.equal(state.proxied, 1); assert.equal(state.settled, 1)
})
test('pre-dispatch failure is the only delivery state that may execute on exact replay', async () => {
  reset(); state.upstreamStatus = 502; state.deliveryOutcome = 'failed_retryable'
  const first = await POST(paid()); assert.equal(first.status, 502); assert.equal((await first.json()).delivery_state, 'FAILED_RETRYABLE')
  state.upstreamStatus = 200; state.deliveryOutcome = 'succeeded'
  const recovered = await POST(paid()); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).delivery_state, 'SUCCEEDED')
  assert.equal(state.settled, 1); assert.equal(state.proxied, 2)
})
test('timeout/unknown delivery and interrupted worker are fenced from upstream replay', async () => {
  reset(); state.upstreamStatus = 502; state.deliveryOutcome = 'unknown'
  assert.equal((await POST(paid())).status, 502)
  const timeoutReplay = await POST(paid()); assert.equal(timeoutReplay.status, 409)
  assert.equal((await timeoutReplay.json()).error, 'delivery_outcome_unknown'); assert.equal(state.proxied, 1)

  reset(); await verifyAndSettlePayment(paid(), 0.001, seller as `0x${string}`, apiId)
  const attempt = [...state.store.rows.values()][0]; attempt.delivery_state = 'IN_PROGRESS'; attempt.delivery_token = 'interrupted-worker'
  const interrupted = await POST(paid()); assert.equal(interrupted.status, 409)
  assert.equal((await interrupted.json()).error, 'delivery_in_progress'); assert.equal(state.proxied, 0); assert.equal(state.settled, 1)
})
test('a replay with a changed upstream request is rejected after payment accounting', async () => {
  reset(); await POST(paid())
  const changed = new NextRequest('https://mahshar.xyz/api/proxy', { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') }, body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', body: { changed: true } }) })
  const response = await POST(changed)
  assert.equal(response.status, 409); assert.equal((await response.json()).error, 'delivery_request_mismatch')
  assert.equal(state.proxied, 1); assert.equal(state.settled, 1)
})
test('recovery route rejects forged fields, malformed ids, unauthenticated and cross-wallet requests', async () => {
  reset(); state.store.failAccounting = true
  await verifyAndSettlePayment(paid(), 0.001, seller as `0x${string}`, apiId)
  state.store.failAccounting = false
  const attempt = [...state.store.rows.values()][0]
  const req = (body: unknown, principal?: string) => new NextRequest('https://mahshar.xyz/api/payments/reconcile', { method: 'POST', headers: { 'content-type': 'application/json', ...(principal ? { 'x-test-principal': principal } : {}) }, body: JSON.stringify(body) })
  assert.equal((await reconcile(req({attemptId:attempt.id}))).status, 401)
  assert.equal((await reconcile(req({attemptId:attempt.id}, seller))).status, 404)
  assert.equal((await reconcile(req({attemptId:'not-an-id'}, payer))).status, 400)
  assert.equal((await reconcile(req({attemptId:attempt.id, state:'SETTLEMENT_CONFIRMED'}, payer))).status, 400)
  assert.equal((await reconcile(req({attemptId:attempt.id}, payer))).status, 200)
  assert.equal(state.store.purchases.size, 1); assert.equal(state.settled, 1)
})
test('path proxy uses the same durable engine and never repeats upstream on retry', async () => {
  reset()
  const context = { params: Promise.resolve({ api_id: apiId }) }
  assert.equal((await pathProxyPost(paid(), context)).status, 200)
  assert.equal((await pathProxyPost(paid(), context)).status, 200)
  assert.equal(state.settled, 1); assert.equal(state.proxied, 1); assert.equal(state.store.purchases.size, 1)
})
test('path proxy permits only GET/POST requests matching the configured listing method', async () => {
  reset()
  const context = { params: Promise.resolve({ api_id: apiId }) }
  const paidGet = () => new NextRequest(`https://mahshar.xyz/api/proxy/${apiId}`, {
    method: 'GET', headers: { 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') },
  })

  assert.equal((await pathProxyGet(paidGet(), context)).status, 405)
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)

  state.listingMethod = 'GET'
  assert.equal((await pathProxyGet(paidGet(), context)).status, 200)
  assert.equal(state.settled, 1); assert.equal(state.proxied, 1)

  reset()
  state.listingMethod = 'PUT'
  assert.equal((await pathProxyPost(paid(), context)).status, 405)
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)
})
test('path POST rejects malformed JSON before payment verification or settlement', async () => {
  reset()
  const context = { params: Promise.resolve({ api_id: apiId }) }
  const malformed = new NextRequest(`https://mahshar.xyz/api/proxy/${apiId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': 'malformed-proof' }, body: '{not-json',
  })
  const response = await pathProxyPost(malformed, context)
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_request')
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)
})
test('retired legacy handler returns 410 without financial or upstream side effects', async () => {
  reset()
  const response = await retiredLegacy(new Request('http://localhost/api/payments/x402', { method: 'POST' }))
  assert.equal(response.status, 410); assert.equal((await response.json()).replacement, '/api/proxy')
  assert.equal(state.settled, 0); assert.equal(state.proxied, 0); assert.equal(state.store.rows.size, 0)
})
