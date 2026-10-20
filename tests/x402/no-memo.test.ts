import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { NextRequest } from 'next/server.js'
import { POST } from '../../src/app/api/proxy/route'
import { GET as pathGet, POST as pathPost } from '../../src/app/api/proxy/[api_id]/route'
import { state } from './integration-fixture'
import { apiId, MemoryStore, payer, payment } from './fixture'

const routes = {
  envelope: () => POST(new NextRequest('https://mahshar.xyz/api/proxy', {
    method: 'POST', headers: headers(), body: JSON.stringify({ api_id: apiId, buyer_wallet: payer, method: 'POST' }),
  })),
  pathPost: () => pathPost(new NextRequest(`https://mahshar.xyz/api/proxy/${apiId}`, {
    method: 'POST', headers: headers(),
  }), { params: Promise.resolve({ api_id: apiId }) }),
  pathGet: () => pathGet(new NextRequest(`https://mahshar.xyz/api/proxy/${apiId}`, {
    headers: headers(),
  }), { params: Promise.resolve({ api_id: apiId }) }),
}
function headers() {
  return { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') }
}
function reset(method: string) {
  Object.assign(state, { store: new MemoryStore(), storageReady: true, settled: 0, verified: 0, proxied: 0,
    upstreamStatus: 200, deliveryOutcome: undefined, proxyBody: { retained: true }, proxyErrorCode: undefined,
    listingMethod: method, listingPrice: 0.001, listingBodyRequired: false, listingRequestSchema: null,
    listingDynamicPath: false, listingPathParameters: null, listingQueryParameters: null, lastProxyInput: null })
}
function accounted(deliveryState: string) {
  assert.equal(state.settled, 1)
  assert.equal(state.store.purchases.size, 1)
  const attempt = [...state.store.rows.values()][0]
  assert.equal(attempt.state, 'ACCOUNTING_COMPLETE')
  assert.equal(attempt.delivery_state, deliveryState)
  assert.equal(attempt.binding.amount_atomic, '1100')
  assert.equal(attempt.binding.seller_atomic, '900')
  assert.equal(attempt.binding.platform_atomic, '200')
  return attempt
}

for (const [name, execute] of Object.entries(routes)) {
  for (const [outcome, status, deliveryState] of [
    ['succeeded', 200, 'SUCCEEDED'], ['failed_final', 404, 'FAILED_FINAL'],
    ['failed_retryable', 502, 'FAILED_RETRYABLE'], ['unknown', 502, 'UNKNOWN'],
  ] as const) {
    test(`${name}: ${deliveryState} and replay create no Memo or background transaction`, async () => {
      reset(name === 'pathGet' ? 'GET' : 'POST')
      state.deliveryOutcome = outcome; state.upstreamStatus = status
      const first = await execute()
      assert.equal(first.status, status)
      const body = await first.json()
      assert.equal(body.payment, 'ACCOUNTING_COMPLETE')
      assert.equal(body.delivery_state, deliveryState)
      assert.equal(typeof body.purchase_access_token, 'string')
      assert.ok(first.headers.has('payment-response'))
      const attempt = accounted(deliveryState)
      const purchase = structuredClone([...state.store.purchases.values()][0])
      if (outcome === 'failed_retryable') { state.deliveryOutcome = 'succeeded'; state.upstreamStatus = 200 }
      const replay = await execute()
      assert.equal(replay.status, outcome === 'succeeded' || outcome === 'failed_retryable' ? 200 : 409)
      accounted(outcome === 'failed_retryable' ? 'SUCCEEDED' : deliveryState)
      assert.deepEqual([...state.store.purchases.values()][0], purchase)
      assert.equal(state.proxied, outcome === 'failed_retryable' ? 2 : 1)
      assert.equal([...state.store.rows.values()][0].id, attempt.id)
      if (outcome === 'succeeded') assert.equal((await replay.json()).retrieve_response, '/api/calls/last-response')
    })
  }
  test(`${name}: accounting recovery creates no Memo and never resettles`, async () => {
    reset(name === 'pathGet' ? 'GET' : 'POST')
    state.store.failAccounting = true
    assert.equal((await execute()).status, 503)
    assert.equal(state.settled, 1); assert.equal(state.proxied, 0)
    assert.equal([...state.store.rows.values()][0].state, 'SETTLEMENT_CONFIRMED')
    state.store.failAccounting = false
    assert.equal((await execute()).status, 200)
    accounted('SUCCEEDED')
    assert.equal((await execute()).status, 200)
    assert.equal(state.settled, 1); assert.equal(state.proxied, 1)
  })
  test(`${name}: lost delivery completion preserves accounted payment without scheduling`, async () => {
    reset(name === 'pathGet' ? 'GET' : 'POST')
    state.store.completeDelivery = async () => { throw new Error('lost completion acknowledgement') }
    const response = await execute()
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.payment, 'ACCOUNTING_COMPLETE'); assert.equal(body.delivery_state, 'UNKNOWN')
    assert.equal(body.retrieve_response, '/api/calls/last-response')
    accounted('IN_PROGRESS')
    assert.equal((await execute()).status, 409)
    assert.equal(state.proxied, 1); assert.equal(state.settled, 1)
  })
}

test('application source has no Memo integration, contract address or writer', () => {
  assert.equal(existsSync('src/lib/memo.ts'), false)
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
  }
  const applicationFiles = files('src').filter(path => /\.[cm]?[jt]sx?$/.test(path))
  assert.ok(applicationFiles.length > 0, 'application source scan must inspect files')
  for (const path of applicationFiles) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\bwriteMemo\b|\bMEMO_(?:CONTRACT|ABI)\b|[@.]\/?lib\/memo|0x5294E9927c3306DcBaDb03fe70b92e01cCede505|functionName:\s*['"]memo['"]/i, path)
  }
})
