import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBuyerProxyEnvelope, buildBuyerRequestSuffix, exampleRequestHasForwardableBody } from './buyer-proxy-request'

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

test('buyer constructs declared path and query inputs without exposing credentials', () => {
  const suffix = buildBuyerRequestSuffix(
    [{ name: 'address', type: 'string', required: true }],
    [{ name: 'limit', type: 'integer', minimum: 1, maximum: 100 }, { name: 'sort', enum: ['volume24h', 'marketCap'] }],
    { path: { address: '0x1234' }, query: { limit: '10', sort: 'volume24h' } },
  )
  assert.equal(suffix, '/0x1234?limit=10&sort=volume24h')
  assert.deepEqual(buildBuyerProxyEnvelope('api', wallet, 'GET', undefined, suffix), {
    api_id: 'api', buyer_wallet: wallet, method: 'GET', path: suffix,
  })
  assert.throws(() => buildBuyerRequestSuffix([], [{ name: 'limit', type: 'integer', maximum: 100 }],
    { path: {}, query: { limit: '101' } }), /invalid/)
  assert.throws(() => buildBuyerRequestSuffix([], [], { path: {}, query: { api_key: 'attacker' } }), /undeclared/)
})

test('buyer supports mixed body and query input for POST and PUT', () => {
  const suffix = buildBuyerRequestSuffix([], [{ name: 'dry_run', type: 'boolean', required: true }],
    { path: {}, query: { dry_run: 'true' } })
  for (const method of ['POST', 'PUT'] as const) {
    assert.deepEqual(buildBuyerProxyEnvelope('api', wallet, method, { value: 1 }, suffix), {
      api_id: 'api', buyer_wallet: wallet, method, path: '?dry_run=true', body: { value: 1 },
    })
  }
})
