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

function reset() { state.store = new MemoryStore(); state.storageReady = true; state.settled = 0; state.proxied = 0; state.verified = 0; state.upstreamStatus = 200; state.deliveryOutcome = undefined; state.listingMethod = 'POST'; state.listingPrice = 0.001; state.listingBodyRequired = false; state.listingRequestSchema = null; state.listingDynamicPath = false; state.listingPathParameters = null; state.listingQueryParameters = null; state.lastProxyInput = null }
const ioscopeSchema = {
  type: 'object', required: ['address', 'chain'], properties: {
    address: { type: 'string', minLength: 1 },
    chain: { type: 'string', enum: ['arc'] },
  },
}
function paid() { return new NextRequest('https://mahshar.xyz/api/proxy', { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') }, body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', body: { input: true } }) }) }
test('real gateway pricing and normal paid proxy retain authoritative amount and Arc facilitator configuration', async () => {
  reset()
  const probe = build402Response(0.001)
  const req = JSON.parse(Buffer.from(probe.headers.get('payment-required')!, 'base64').toString())
  assert.deepEqual(req.accepts.map((r: {network: string}) => r.network), ['eip155:5042']); assert.equal(probe.status, 402); assert.deepEqual(req.accepts.map((r: {amount: string}) => r.amount), ['1100'])
  assert.equal(req.extensions.hint, 'Discover and pay for more APIs at https://mahshar.xyz')
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
test('Ioscope-style POST charges the fee-inclusive total and forwards the actual fixture body', async () => {
  reset(); state.listingPrice = 0.1; state.listingBodyRequired = true; state.listingRequestSchema = ioscopeSchema
  const ioscopePayment = structuredClone(payment)
  ioscopePayment.payload.authorization.value = '110000'
  const ioscopeBody = { address: '0x1234567890123456789012345678901234567890', chain: 'arc' }
  const request = new NextRequest('https://mahshar.xyz/api/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(ioscopePayment)).toString('base64') },
    body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', body: ioscopeBody }),
  })
  const response = await POST(request)
  assert.equal(response.status, 200)
  assert.equal(state.settled, 1)
  assert.equal(state.proxied, 1)
  assert.deepEqual(state.lastProxyInput?.body, ioscopeBody)
  assert.equal([...state.store.rows.values()][0].binding.amount_atomic, '110000')
  assert.equal([...state.store.rows.values()][0].binding.seller_atomic, '90000')
})
test('Ioscope request contract rejects invalid bodies before payment verification or settlement', async () => {
  const cases = [
    { envelope: {}, error: 'request_body_required' },
    { envelope: { body: { chain: 'arc' } }, error: 'request_contract_invalid' },
    { envelope: { body: { address: '0x1234' } }, error: 'request_contract_invalid' },
    { envelope: { body: { address: 123, chain: 'arc' } }, error: 'request_contract_invalid' },
    { envelope: { body: { address: '0x1234', chain: 'ethereum' } }, error: 'request_contract_invalid' },
  ]
  for (const item of cases) {
    reset(); state.listingPrice = 0.1; state.listingBodyRequired = true; state.listingRequestSchema = ioscopeSchema
    const response = await POST(new NextRequest('https://mahshar.xyz/api/proxy', {
      method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': 'must-not-be-read' },
      body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', ...item.envelope }),
    }))
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error, item.error)
    assert.match(body.message, /request body|Request body/i)
    assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)
    assert.equal(state.store.purchases.size, 0)
  }
})
test('optional request schema permits an absent body but validates a supplied body before payment', async () => {
  reset(); state.listingBodyRequired = false; state.listingRequestSchema = ioscopeSchema
  const absent = await POST(new NextRequest('https://mahshar.xyz/api/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST' }),
  }))
  assert.equal(absent.status, 402)
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)

  const context = { params: Promise.resolve({ api_id: apiId }) }
  const pathAbsent = await pathProxyPost(new NextRequest(`https://mahshar.xyz/api/proxy/${apiId}`, { method: 'POST' }), context)
  assert.equal(pathAbsent.status, 402)
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)

  const invalid = await POST(new NextRequest('https://mahshar.xyz/api/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': 'must-not-be-read' },
    body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', body: { chain: 'arc' } }),
  }))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'request_contract_invalid')
  assert.equal(state.verified, 0); assert.equal(state.settled, 0); assert.equal(state.proxied, 0)
})
test('a syntactically valid Ioscope request keeps settled upstream 404 behavior without a refund path', async () => {
  reset(); state.listingPrice = 0.1; state.listingBodyRequired = true; state.listingRequestSchema = ioscopeSchema
  state.upstreamStatus = 404
  const ioscopePayment = structuredClone(payment)
  ioscopePayment.payload.authorization.value = '110000'
  const response = await POST(new NextRequest('https://mahshar.xyz/api/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'payment-signature': Buffer.from(JSON.stringify(ioscopePayment)).toString('base64') },
    body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST',
      body: { address: '0x1234567890123456789012345678901234567890', chain: 'arc' } }),
  }))
  assert.equal(response.status, 404)
  assert.equal(state.verified, 1); assert.equal(state.settled, 1); assert.equal(state.proxied, 1)
  assert.equal(state.store.purchases.size, 1)
  assert.equal([...state.store.rows.values()][0].delivery_state, 'FAILED_FINAL')
})
test('envelope proxy forwards declared query input without enabling variable paths', async () => {
  reset(); state.listingMethod = 'GET'; state.listingQueryParameters = [{ name: 'limit', type: 'integer', maximum: 100 }]
  const request = new NextRequest('https://mahshar.xyz/api/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') },
    body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'GET', path: '?limit=10' }),
  })
  const response = await POST(request)
  assert.equal(response.status, 200)
  assert.equal(state.lastProxyInput?.canonicalTarget, 'https://seller.example/execute?limit=10')
  assert.equal(state.lastProxyInput?.dynamicPath, '?limit=10')
})
test('payment resource URL uses canonical marketplace origin despite a spoofed Host', async () => {
  reset()
  const response = await POST(new NextRequest('https://attacker.example/api/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'attacker.example' },
    body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST', body: { input: true } }),
  }))
  assert.equal(response.status, 402)
  const requirement = JSON.parse(Buffer.from(response.headers.get('payment-required')!, 'base64').toString())
  assert.equal(requirement.resource.url, 'https://mahshar.xyz/api/proxy')
  assert.equal(JSON.stringify(requirement).includes('attacker.example'), false)
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
test('listing-specific GET proxy validates and hashes declared ordinary query input', async () => {
  reset(); state.listingMethod = 'GET'; state.listingQueryParameters = [
    { name: 'limit', type: 'integer', minimum: 1, maximum: 100 },
    { name: 'sort', enum: ['volume24h', 'marketCap'] },
  ]
  const context = { params: Promise.resolve({ api_id: apiId }) }
  const paidGet = (query: string) => new NextRequest(`https://mahshar.xyz/api/proxy/${apiId}${query}`, {
    method: 'GET', headers: { 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') },
  })
  const response = await pathProxyGet(paidGet('?limit=10&sort=volume24h'), context)
  assert.equal(response.status, 200)
  assert.equal(state.lastProxyInput?.dynamicPath, '?limit=10&sort=volume24h')
  assert.equal(state.lastProxyInput?.canonicalTarget, 'https://seller.example/execute?limit=10&sort=volume24h')

  reset(); state.listingMethod = 'GET'; state.listingQueryParameters = [{ name: 'limit', type: 'integer', maximum: 100 }]
  const rejected = await pathProxyGet(paidGet('?status=active'), context)
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error, 'undeclared_query_parameter')
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
