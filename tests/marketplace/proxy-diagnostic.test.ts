import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { proxyRequest } from '../../src/lib/proxy'
import { alice, reset, state } from './fixtures'
import { proxyState, resetProxyState } from './proxy-diagnostic-register.mjs'

beforeEach(() => {
  reset()
  resetProxyState()
  state.tables.api_listings.push({
    id: 'ioscope',
    name: 'Ioscope Wallet Risk Scoring',
    endpoint_url: 'https://www.ioscope.xyz/api/analyze',
    method: 'POST',
    is_active: true,
    auth_type: 'public',
    encrypted_key: null,
    verified_at: '2026-09-26T00:00:00.000Z',
    dynamic_path_supported: false,
    path_parameters: null,
    query_parameters: null,
  })
})

test('Ioscope 404 preserves the exact outbound URL and a bounded raw upstream diagnostic', async () => {
  const rawBody = '<html><body>upstream route not found</body></html>'
  proxyState.response = new Response(rawBody, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

  const result = await proxyRequest({
    apiId: 'ioscope',
    buyerWallet: alice.address,
    paymentType: 'pay-per-call',
    method: 'POST',
    dynamicPath: '',
    canonicalTarget: 'https://www.ioscope.xyz/api/analyze',
    incomingHeaders: {},
    body: { address: alice.address, chain: 'arc' },
  })

  assert.equal(proxyState.targetUrl, 'https://www.ioscope.xyz/api/analyze')
  assert.equal(proxyState.outboundUrl, 'https://www.ioscope.xyz/api/analyze')
  assert.equal(result.status, 404)
  assert.equal(result.body, rawBody)
  assert.deepEqual(state.tables.api_calls[0].response_body, {
    upstream_status: 404,
    upstream_content_type: 'text/html; charset=utf-8',
    upstream_body: rawBody,
    upstream_body_truncated: false,
  })
})

test('successful paid response is linked to its exact purchase before delivery can succeed', async () => {
  proxyState.response = Response.json({ result: 'ok' })
  const result = await proxyRequest({
    apiId: 'ioscope', buyerWallet: alice.address, paymentType: 'pay-per-call', method: 'POST', dynamicPath: '',
    canonicalTarget: 'https://www.ioscope.xyz/api/analyze', incomingHeaders: {}, body: { input: true },
    purchaseId: 'purchase-a', deliveryAttemptId: 'attempt-a', purchaseAccessToken: 'access-a',
  })
  assert.equal(result.deliveryOutcome, 'succeeded')
  assert.equal(result.responsePersisted, true)
  assert.equal(state.tables.api_calls[0].purchase_id, 'purchase-a')
  assert.equal(state.tables.api_calls[0].delivery_attempt_id, 'attempt-a')
  assert.deepEqual(state.tables.api_calls[0].response_body, { result: 'ok' })
})

test('api_calls insert failure makes delivery unknown and withholds the upstream response', async () => {
  state.failApiCallInsert = true
  proxyState.response = Response.json({ secret: 'one-shot result' })
  const result = await proxyRequest({
    apiId: 'ioscope', buyerWallet: alice.address, paymentType: 'pay-per-call', method: 'POST', dynamicPath: '',
    canonicalTarget: 'https://www.ioscope.xyz/api/analyze', incomingHeaders: {}, purchaseId: 'purchase-a',
    deliveryAttemptId: 'attempt-a', purchaseAccessToken: 'access-a',
  })
  assert.equal(result.status, 503)
  assert.equal(result.deliveryOutcome, 'unknown')
  assert.equal(result.responsePersisted, false)
  assert.notDeepEqual(result.body, { secret: 'one-shot result' })
})

test('serialized wrapper expansion over the safe limit is rejected and never stored as success', async () => {
  proxyState.response = new Response('"'.repeat(2_100_000), { status: 200, headers: { 'content-type': 'text/plain' } })
  const result = await proxyRequest({
    apiId: 'ioscope', buyerWallet: alice.address, paymentType: 'pay-per-call', method: 'POST', dynamicPath: '',
    canonicalTarget: 'https://www.ioscope.xyz/api/analyze', incomingHeaders: {}, purchaseId: 'purchase-a',
    deliveryAttemptId: 'attempt-a', purchaseAccessToken: 'access-a',
  })
  assert.equal(result.status, 502)
  assert.equal(result.deliveryOutcome, 'failed_final')
  assert.equal(state.tables.api_calls[0].success, false)
  assert.equal(state.tables.api_calls[0].response_body, undefined)
})
