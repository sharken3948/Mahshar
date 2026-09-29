import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { encryptKey } from '../../src/lib/crypto'
import { POST as verify } from '../../src/app/api/apis/[id]/verify/route'
import { alice, origin, reset, sessionHeaders, state } from './fixtures'
import { resetVerificationState, verificationState } from './verification-contract-register.mjs'

test('verification executes the declared representative query and injects all four auth models afterward', async () => {
  const models = [
    { auth_type: 'public', auth_param_name: null, encrypted_key: null },
    { auth_type: 'apikey', auth_param_name: null, encrypted_key: encryptKey('stored-secret') },
    { auth_type: 'bearer', auth_param_name: null, encrypted_key: encryptKey('stored-secret') },
    { auth_type: 'queryparam', auth_param_name: 'api_key', encrypted_key: encryptKey('stored-secret') },
  ] as const
  for (const model of models) {
    reset(); resetVerificationState()
    const row = { id: 'representative', seller_wallet: alice.address.toLowerCase(), name: 'API', description: 'description', category: 'Data',
      endpoint_url: 'https://anewone.xyz/api/basedbot/tokens', method: 'GET', is_active: false, verified_at: null,
      price_per_call: 0.1, example_request: '{"limit":10,"sort":"volume24h"}', example_response: '{}',
      dynamic_path_supported: false, path_parameters: [], query_parameters: [
        { name: 'limit', type: 'integer', maximum: 100, example: 10 },
        { name: 'sort', enum: ['volume24h'], example: 'volume24h' },
      ], ...model }
    state.tables.api_listings.push(row)
    const request = new NextRequest(`${origin}/api/apis/representative/verify`, {
      method: 'POST', headers: sessionHeaders(),
    })
    const response = await verify(request, { params: Promise.resolve({ id: 'representative' }) })
    assert.equal(response.status, 200, model.auth_type)
    const url = new URL(verificationState.url!)
    assert.equal(url.searchParams.get('limit'), '10')
    assert.equal(url.searchParams.get('sort'), 'volume24h')
    assert.equal(url.searchParams.get('api_key'), model.auth_type === 'queryparam' ? 'stored-secret' : null)
    const headers = verificationState.init?.headers as Record<string, string>
    assert.equal(headers['x-api-key'], model.auth_type === 'apikey' ? 'stored-secret' : undefined)
    assert.equal(headers.authorization, model.auth_type === 'bearer' ? 'Bearer stored-secret' : undefined)
    assert.ok(row.verified_at)
  }
})

test('verification cannot be inherited when the representative request changes in flight', async () => {
  reset(); resetVerificationState()
  const row = { id: 'representative', seller_wallet: alice.address.toLowerCase(), name: 'API', description: 'description', category: 'Data',
    endpoint_url: 'https://seller.example/data', method: 'POST', auth_type: 'public', auth_param_name: null,
    encrypted_key: null, is_active: false, verified_at: null, price_per_call: 0.1,
    example_request: '{"value":1}', example_response: '{}', expected_status_codes: null, body_required: true,
    dynamic_path_supported: false, path_parameters: [], query_parameters: [] }
  state.tables.api_listings.push(row)
  verificationState.beforeResponse = () => { row.example_request = '{"value":2}' }
  const request = new NextRequest(`${origin}/api/apis/representative/verify`, {
    method: 'POST', headers: sessionHeaders(),
  })
  const response = await verify(request, { params: Promise.resolve({ id: 'representative' }) })
  assert.equal(response.status, 409)
  assert.equal(row.verified_at, null)
})
