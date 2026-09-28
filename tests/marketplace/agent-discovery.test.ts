import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listingProxyEntry } from '../../src/lib/marketplace/proxy-entry'
import { agentExecutionContract } from '../../src/lib/marketplace/agent-contract'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { GET as discover } from '../../src/app/api/agent/discover/route'
import { GET as openapi } from '../../src/app/api/openapi/route'
import { reset, state } from './fixtures'

test('agent discovery publishes listing methods and selects only compatible proxy routes', async () => {
  const byMethod = Object.fromEntries(['GET', 'POST', 'PUT', 'DELETE'].map(method => [
    method, listingProxyEntry(`${method.toLowerCase()}-listing`, method),
  ]))

  for (const method of ['GET', 'POST']) {
    assert.equal(byMethod[method].proxy_style, 'path')
    assert.match(byMethod[method].proxy_url, new RegExp(`/api/proxy/${method.toLowerCase()}-listing$`))
  }
  for (const method of ['PUT', 'DELETE']) {
    assert.equal(byMethod[method].proxy_style, 'envelope')
    assert.equal(byMethod[method].proxy_url, 'https://mahshar.xyz/api/proxy')
  }
})

test('agent execution contract is self-describing without guessing legacy schemas or exposing seller endpoints', () => {
  const dynamicDelete = agentExecutionContract({
    id: 'delete-listing', method: 'DELETE', example_request: '{"reason":"test"}',
    example_response: '{"ok":true}', dynamic_path_supported: true,
    body_required: false, request_schema: null, response_schema: null,
    query_parameters: [{ name: 'mode', enum: ['server-error'] }], path_parameters: null,
  })
  assert.equal(dynamicDelete.proxy_style, 'envelope')
  assert.equal(dynamicDelete.request.outer_method, 'POST')
  assert.equal(dynamicDelete.request.body.delete_body_supported, true)
  assert.equal(dynamicDelete.request.body.schema, null)
  assert.deepEqual(dynamicDelete.request.body.example, { reason: 'test' })
  assert.equal(dynamicDelete.request.dynamic_path.transport, 'envelope.path')
  assert.equal(JSON.stringify(dynamicDelete).includes('endpoint_url'), false)
})

test('public OpenAPI covers v2 payment, delivery, capability, and all supported methods', () => {
  const document = readFileSync('openapi.yaml', 'utf8')
  for (const token of ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'purchase_access_token',
    'x-mahshar-purchase-access', '/api/payments/reconcile', 'FAILED_RETRYABLE',
    'GET, POST, PUT, DELETE', 'maxProperties: 0']) assert.match(document, new RegExp(token))
  assert.doesNotMatch(document, /maxAmountRequired|request_body|PATCH/)
})

test('OpenAPI is served publicly with a machine-readable media type', async () => {
  const response = await openapi()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/yaml/)
  assert.match(await response.text(), /^openapi: 3\.1\.0/m)
})

test('served OpenAPI substitutes MARKETPLACE_ORIGIN rather than request or template hosts', async () => {
  const previous = process.env.MARKETPLACE_ORIGIN
  process.env.MARKETPLACE_ORIGIN = 'https://staging.mahshar.example'
  try {
    const response = await openapi()
    const document = await response.text()
    assert.match(document, /- url: https:\/\/staging\.mahshar\.example/)
    assert.equal(document.includes('https://mahshar.xyz'), false)
  } finally {
    process.env.MARKETPLACE_ORIGIN = previous
  }
})

test('agent discovery route emits the safe executable contract and pagination without seller configuration', async () => {
  reset()
  state.tables.api_listings.push({
    id: 'listing-id', name: 'Fixture', description: 'Fixture API', category: 'Data', price_per_call: 0.001,
    payment_model: 'pay-per-call', auth_type: 'apikey', method: 'PUT', endpoint_url: 'https://secret-upstream.example',
    encrypted_key: 'encrypted-secret', auth_param_name: 'secret_name', example_request: '{"value":1}', example_response: '{"ok":true}',
    score: 9, verified_at: '2026-09-26T00:00:00Z', created_at: '2026-09-26T00:00:00Z', is_active: true,
    request_schema: { type: 'object' }, response_schema: null, body_required: true,
    dynamic_path_supported: false, path_parameters: null, query_parameters: null,
  })
  const response = await discover(new NextRequest('https://mahshar.xyz/api/agent/discover?limit=25&offset=0'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.openapi_url, 'https://mahshar.xyz/api/openapi')
  assert.equal(payload.payment_recipient, `0x${'44'.repeat(20)}`)
  assert.deepEqual(payload.pagination, { limit: 25, offset: 0, returned: 1, next_offset: null })
  assert.equal(payload.apis[0].method, 'PUT'); assert.equal(payload.apis[0].proxy_style, 'envelope')
  assert.equal(payload.apis[0].payment_model, 'x402-pay-per-call')
  assert.equal(payload.apis[0].request.body.required, true)
  const serialized = JSON.stringify(payload)
  assert.doesNotMatch(serialized, /secret-upstream|encrypted-secret|secret_name|endpoint_url|encrypted_key|auth_param_name/)
})

test('machine URLs ignore a spoofed request Host and use MARKETPLACE_ORIGIN', async () => {
  reset()
  const response = await discover(new NextRequest('https://attacker.example/api/agent/discover', {
    headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
  }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.openapi_url, 'https://mahshar.xyz/api/openapi')
  assert.equal(payload.proxy_urls.envelope, 'https://mahshar.xyz/api/proxy')
  assert.equal(JSON.stringify(payload).includes('attacker.example'), false)
})
