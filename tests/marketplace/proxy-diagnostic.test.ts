import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { proxyRequest } from '../../src/lib/proxy'
import { alice, reset, state } from './fixtures'
import { proxyState, resetProxyState } from './proxy-diagnostic-register.mjs'
import { authorizeProxyTarget, ProxyTargetError } from '../../src/lib/marketplace/proxy-target'
import { encryptKey } from '../../src/lib/crypto'

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

test('public, API-key, bearer, and query-parameter authentication retain the authorized proxy contract', async () => {
  const secret = 'seller-secret-never-returned'
  const models = [
    { auth_type: 'public', auth_param_name: null, encrypted_key: null },
    { auth_type: 'apikey', auth_param_name: null, encrypted_key: encryptKey(secret) },
    { auth_type: 'bearer', auth_param_name: null, encrypted_key: encryptKey(secret) },
    { auth_type: 'queryparam', auth_param_name: 'seller_token', encrypted_key: encryptKey(secret) },
  ] as const

  for (const [index, model] of models.entries()) {
    reset(); resetProxyState()
    const listing = {
      id: `auth-${index}`, name: model.auth_type, endpoint_url: 'https://api.example/v1?fixed=yes', method: 'GET',
      is_active: true, verified_at: '2026-09-28T00:00:00Z', dynamic_path_supported: true,
      path_parameters: [{ name: 'collection', enum: ['users'] }, { name: 'id', type: 'integer' as const }],
      query_parameters: [{ name: 'view', enum: ['summary'] }], ...model,
    }
    state.tables.api_listings.push(listing)
    proxyState.response = Response.json({ ok: true })
    const canonical = authorizeProxyTarget(listing, '/users/42?view=summary').toString()
    const result = await proxyRequest({
      apiId: listing.id, buyerWallet: alice.address, paymentType: 'pay-per-call', method: 'GET',
      dynamicPath: '/users/42?view=summary', canonicalTarget: canonical,
      incomingHeaders: { authorization: 'Bearer buyer-value', 'x-api-key': 'buyer-value' },
      purchaseId: `purchase-${index}`, deliveryAttemptId: `attempt-${index}`, purchaseAccessToken: `token-${index}`,
    })
    assert.equal(result.deliveryOutcome, 'succeeded', model.auth_type)
    assert.equal(result.responsePersisted, true, model.auth_type)
    assert.equal(JSON.stringify(result.body).includes(secret), false, model.auth_type)
    assert.equal(proxyState.outboundUrl?.startsWith(canonical), true, model.auth_type)
    const headers = proxyState.outboundInit?.headers as Record<string, string>
    assert.equal(headers?.['x-api-key'], model.auth_type === 'apikey' ? secret : undefined)
    assert.equal(headers?.authorization, model.auth_type === 'bearer' ? `Bearer ${secret}` : undefined)
    const outbound = new URL(proxyState.outboundUrl!)
    assert.equal(outbound.searchParams.get('seller_token'), model.auth_type === 'queryparam' ? secret : null)
    assert.equal([...outbound.searchParams.keys()].filter(key => key.toLowerCase() === 'seller_token').length,
      model.auth_type === 'queryparam' ? 1 : 0)

    const disabled = { ...listing, dynamic_path_supported: false }
    assert.throws(() => authorizeProxyTarget(disabled, '/users/42'), ProxyTargetError)
    for (const hostile of ['/../admin', '/../../users', '/%2e%2e/admin', '/%252e%252e/admin',
      '/users/42?debug=true', '/users/42?view=summary&view=summary']) {
      assert.throws(() => authorizeProxyTarget(listing, hostile), ProxyTargetError, `${model.auth_type}: ${hostile}`)
    }
    if (model.auth_type === 'queryparam') {
      for (const collision of ['/users/42?seller_token=buyer', '/users/42?SELLER_TOKEN=buyer']) {
        assert.throws(() => authorizeProxyTarget(listing, collision), ProxyTargetError, collision)
      }
    }
  }
})
