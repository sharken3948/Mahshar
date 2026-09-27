import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBuyerProxyEnvelope, exampleRequestHasForwardableBody } from './buyer-proxy-request'

const wallet = `0x${'11'.repeat(20)}`

test('buyer GET execution preserves GET and never opens a request-body flow', () => {
  assert.deepEqual(buildBuyerProxyEnvelope('get-api', wallet, 'GET'), {
    api_id: 'get-api', buyer_wallet: wallet, method: 'GET',
  })
  assert.equal(exampleRequestHasForwardableBody('GET', '{"ignored":true}'), false)
})

for (const method of ['POST', 'PUT'] as const) {
  test(`buyer ${method} execution preserves the listing method and JSON body`, () => {
    assert.equal(exampleRequestHasForwardableBody(method, '{"input":true}'), true)
    assert.deepEqual(buildBuyerProxyEnvelope(`${method.toLowerCase()}-api`, wallet, method, { input: true }), {
      api_id: `${method.toLowerCase()}-api`, buyer_wallet: wallet, method, body: { input: true },
    })
  })
}

test('buyer DELETE execution supports both no-body and JSON-body listings', () => {
  assert.equal(exampleRequestHasForwardableBody('DELETE', null), false)
  assert.deepEqual(buildBuyerProxyEnvelope('delete-api', wallet, 'DELETE'), {
    api_id: 'delete-api', buyer_wallet: wallet, method: 'DELETE',
  })

  assert.equal(exampleRequestHasForwardableBody('DELETE', '{}'), true)
  assert.deepEqual(buildBuyerProxyEnvelope('delete-api', wallet, 'DELETE', { reason: 'test' }), {
    api_id: 'delete-api', buyer_wallet: wallet, method: 'DELETE', body: { reason: 'test' },
  })
})

test('buyer request construction rejects methods outside the runtime proxy contract', () => {
  assert.throws(() => buildBuyerProxyEnvelope('patch-api', wallet, 'PATCH'), /unsupported/i)
})
