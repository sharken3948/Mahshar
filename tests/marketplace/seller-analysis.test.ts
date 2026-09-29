import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import './seller-analysis-register.mjs'
import { sellerAnalysisState, resetSellerAnalysisState } from './seller-analysis-register.mjs'
import { alice, origin, reset, sessionHeaders, state } from './fixtures'
import { encryptKey } from '../../src/lib/crypto'

// The marketplace harness installs module mocks synchronously before this route is loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST: analyze } = require('../../src/app/api/ai/score/route') as typeof import('../../src/app/api/ai/score/route')

function request(body: Record<string, unknown>) {
  return new NextRequest(`${origin}/api/ai/score`, {
    method: 'POST', headers: { ...sessionHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing', seller_wallet: alice.address.toLowerCase(), name: 'Fixture', description: 'A fixture API',
    category: 'Data', price_per_call: 0.001, payment_model: 'pay-per-call', endpoint_url: 'https://seller.example/data',
    method: 'GET', auth_type: 'public', auth_param_name: null, encrypted_key: null, example_request: '',
    example_response: '{}', expected_status_codes: null, body_required: false, dynamic_path_supported: false,
    path_parameters: [], query_parameters: [], verified_at: null, is_active: false, consecutive_transient_count: 0,
    ...overrides,
  }
}

beforeEach(() => { reset(); resetSellerAnalysisState() })

test('URL-first analysis returns deterministic facts and validated Groq suggestions without creating a listing', async () => {
  sellerAnalysisState.response = Response.json({ temperature: 18 }, { status: 200 })
  const response = await analyze(request({ endpoint_url: 'https://seller.example/weather?city=Istanbul', method: 'GET',
    auth_type: 'public', seller_wallet: alice.address }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.endpoint_verified, true)
  assert.equal(body.analysis.json_response, true)
  assert.equal(body.suggestions.name, 'Suggested API')
  assert.equal(body.suggestions.example_response.includes('temperature'), true)
  assert.equal(body.suggestions.query_parameters[0].name, 'city')
  assert.equal(state.tables.api_listings.length, 0)
  assert.equal('auth_key' in sellerAnalysisState.groqInput, false)
})

test('successful persisted verification survives Groq failure and never sends stored credentials to Groq', async () => {
  const row = listing({ auth_type: 'bearer', encrypted_key: encryptKey('seller-secret-value') })
  state.tables.api_listings.push(row)
  sellerAnalysisState.groqError = true
  sellerAnalysisState.response = Response.json({ ok: true })
  const response = await analyze(request({ api_id: 'listing', name: 'Fixture', category: 'Data',
    description: 'A fixture API', endpoint_url: 'https://attacker.example/ignored', seller_wallet: alice.address }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.endpoint_verified, true)
  assert.equal(body.ai_available, false)
  assert.equal(body.approved, true)
  assert.ok(row.verified_at)
  assert.equal(sellerAnalysisState.outboundInit.headers.authorization, 'Bearer seller-secret-value')
  assert.equal(JSON.stringify(sellerAnalysisState.groqInput).includes('seller-secret-value'), false)
})

test('explicit edit-draft analysis uses the stored credential without mutating the listing', async () => {
  const row = listing({ auth_type: 'bearer', encrypted_key: encryptKey('existing-edit-secret'),
    verified_at: '2026-09-01T00:00:00.000Z', is_active: true, score: 7, consecutive_transient_count: 2 })
  state.tables.api_listings.push(row)
  const before = structuredClone(row)
  sellerAnalysisState.groqError = true
  sellerAnalysisState.response = Response.json({ draft: true })

  const response = await analyze(request({ api_id: 'listing', draft: true, seller_wallet: alice.address,
    name: 'Edited draft', category: 'Data', description: 'Draft metadata',
    endpoint_url: 'https://seller.example/data', method: 'POST', auth_type: 'bearer', example_request: '{"value":1}',
    body_required: true,
    dynamic_path_supported: false, path_parameters: [], query_parameters: [] }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.endpoint_verified, true)
  assert.equal(body.ai_available, false)
  assert.equal(sellerAnalysisState.outboundUrl, 'https://seller.example/data')
  assert.equal(sellerAnalysisState.outboundInit.headers.authorization, 'Bearer existing-edit-secret')
  assert.equal(JSON.stringify(sellerAnalysisState.groqInput).includes('existing-edit-secret'), false)
  assert.deepEqual(row, before)
})

test('edit-draft analysis never forwards a stored credential to a changed endpoint', async () => {
  const row = listing({ auth_type: 'bearer', encrypted_key: encryptKey('endpoint-bound-secret') })
  state.tables.api_listings.push(row)
  const response = await analyze(request({ api_id: 'listing', draft: true, seller_wallet: alice.address,
    endpoint_url: 'https://different.example/data', method: 'GET', auth_type: 'bearer',
    body_required: false, dynamic_path_supported: false, path_parameters: [], query_parameters: [] }))
  const body = await response.json()
  assert.equal(body.endpoint_verified, false)
  assert.match(body.blocking_issue, /credentials are required/i)
  assert.equal(sellerAnalysisState.outboundCalls, 0)
  assert.equal(sellerAnalysisState.groqInput, null)
})

test('401 analysis gives actionable auth guidance and detects Bearer evidence without verifying', async () => {
  sellerAnalysisState.response = Response.json({ error: 'missing token' }, {
    status: 401, headers: { 'www-authenticate': 'Bearer realm="seller"' },
  })
  const response = await analyze(request({ endpoint_url: 'https://seller.example/private', method: 'GET',
    auth_type: 'public', seller_wallet: alice.address }))
  const body = await response.json()
  assert.equal(body.endpoint_verified, false)
  assert.match(body.blocking_issue, /401 Unauthorized/)
  assert.equal(body.analysis.authentication_likely, true)
  assert.equal(body.suggestions.auth_type, 'bearer')
})

test('unsafe destinations are rejected before outbound transport or Groq', async () => {
  sellerAnalysisState.urlValidation = { valid: false, error: 'Endpoint resolves to a prohibited address' }
  const response = await analyze(request({ endpoint_url: 'https://127.0.0.1/data', method: 'GET',
    auth_type: 'public', seller_wallet: alice.address }))
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.match(body.blocking_issue, /cannot be used/)
  assert.equal(sellerAnalysisState.outboundCalls, 0)
  assert.equal(sellerAnalysisState.groqInput, null)
})
