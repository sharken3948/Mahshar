import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server.js'
import { POST as proxyPost } from '../../src/app/api/proxy/route'
import type { AgentListing } from '../../src/lib/mcp/discovery-client'
import { createPaidClient } from '../../src/lib/mcp/paid-client'
import { buildProxyRequest, normalizePreparedCall } from '../../src/lib/mcp/request-builder'
import { state } from '../x402/integration-fixture'
import { apiId, MemoryStore, payer } from '../x402/fixture'

const listing: AgentListing = {
  id: apiId, name: 'Fixture', description: 'No-money route fixture', category: 'test', price_per_call_usdc: 0.001,
  payment_model: 'x402-pay-per-call', auth: { type: 'public', injected_by: 'none', credential_location: null, seller_credentials_exposed: false },
  auth_type: 'public', method: 'POST', score: 1, verified: true, example_request: null, example_response: null,
  total_calls: 0, success_rate: null, avg_latency_ms: null, proxy_url: 'https://mahshar.xyz/api/proxy', proxy_style: 'envelope',
  request: {
    outer_method: 'POST', content_type: 'application/json',
    body: { supported: true, required: false, schema: null, example: null, delete_body_supported: false },
    dynamic_path: { supported: false, transport: null }, query_transport: 'envelope.path query string',
    path_parameters: [], query_parameters: [], example: null,
    incoming_headers: { supported: false, reason: 'Buyer-supplied headers are not forwarded upstream.' },
  },
  response: {
    content_type: 'application/json', schema: null, example: null,
    wrapper: { response: 'unknown', latency_ms: 'number', payment: 'ACCOUNTING_COMPLETE', delivery_state: 'string', attemptId: 'string', purchase_access_token: 'string' },
  },
}

function reset() {
  state.store = new MemoryStore()
  state.storageReady = true
  state.settled = 0
  state.verified = 0
  state.proxied = 0
  state.listingMethod = 'POST'
  state.listingPrice = 0.001
  state.listingBodyRequired = false
  state.listingRequestSchema = null
  state.listingDynamicPath = false
  state.listingPathParameters = null
  state.listingQueryParameters = null
}

function client(onProxy?: (request: NextRequest) => void) {
  return createPaidClient({
    origin: 'https://mahshar.xyz',
    fetcher: async (input, init) => {
      const request = new NextRequest(new URL(String(input)), init ? { ...init, signal: init.signal ?? undefined } : undefined)
      onProxy?.(request)
      return proxyPost(request)
    },
  })
}

test('unsigned MCP Stage A receives the actual proxy 402 without financial, delivery, or upstream side effects', async () => {
  reset()
  let requestHeaders: Headers | undefined
  const call = normalizePreparedCall({ api_id: apiId, buyer_wallet: payer, body: { input: true } }, true)
  const result = await client(request => { requestHeaders = request.headers }).execute(listing, call, {})

  assert.equal(result.status, 'payment_required')
  assert.equal((result as { http_status: number }).http_status, 402)
  assert.equal((result as { challenge: { x402Version: number; accepts: Array<{ network: string; amount: string }> } }).challenge.x402Version, 2)
  assert.equal((result as { challenge: { accepts: Array<{ network: string }> } }).challenge.accepts[0].network, 'eip155:5042')
  assert.equal(requestHeaders?.has('payment-signature'), false)
  assert.equal(state.verified, 0)
  assert.equal(state.settled, 0)
  assert.equal(state.proxied, 0)
  assert.equal(state.store.rows.size, 0)
  assert.equal(state.store.purchases.size, 0)
})
test('structured dynamic values stay single-valued and the actual proxy rejects traversal and constraints before payment', async () => {
  reset()
  state.listingDynamicPath = true
  const pathParameters: AgentListing['request']['path_parameters'] = [{ name: 'slug', required: true, type: 'string', pattern: '^[A-Za-z0-9-]+$' }]
  const queryParameters: AgentListing['request']['query_parameters'] = [{ name: 'limit', type: 'integer', minimum: 1, maximum: 10 }]
  state.listingPathParameters = pathParameters
  state.listingQueryParameters = queryParameters
  const dynamicListing: AgentListing = {
    ...listing,
    request: {
      ...listing.request,
      dynamic_path: { supported: true, transport: 'envelope.path' },
      path_parameters: pathParameters,
      query_parameters: queryParameters,
    },
  }
  let proxyCalls = 0
  const paid = client(() => { proxyCalls += 1 })

  for (const [pathValue, queryValue, expected] of [
    ['..', 5, 'invalid_dynamic_path'],
    ['%2e%2e', 5, 'invalid_dynamic_path'],
    ['bad value', 5, 'undeclared_path'],
    ['valid', 99, 'invalid_query_parameter'],
  ] as const) {
    const call = normalizePreparedCall({ api_id: apiId, buyer_wallet: payer, path_values: { slug: pathValue }, query_values: { limit: queryValue } }, false)
    const result = await paid.execute(dynamicListing, call, {})
    assert.equal(result.status, 'request_rejected')
    assert.equal((result as { result: { error: string } }).result.error, expected)
  }

  const undeclared = normalizePreparedCall({ api_id: apiId, buyer_wallet: payer, path_values: { slug: 'valid' }, query_values: { other: 1 } }, false)
  const before = proxyCalls
  assert.deepEqual(await paid.execute(dynamicListing, undeclared, {}), { status: 'request_rejected', error: 'undeclared_request_input' })
  assert.equal(proxyCalls, before)

  const valid = normalizePreparedCall({ api_id: apiId, buyer_wallet: payer, path_values: { slug: 'valid' }, query_values: { limit: 5 } }, false)
  const built = buildProxyRequest(dynamicListing, valid, 'https://mahshar.xyz')
  const envelope = JSON.parse(String(built.init.body)) as { path: string }
  assert.deepEqual(new URLSearchParams(envelope.path.split('?')[1]).getAll('limit'), ['5'])
})
