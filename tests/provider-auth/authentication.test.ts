import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { boundary, resetBoundary } from './register.mjs'
import { alice, bob, origin, reset, sessionHeaders, operationHeaders, state } from '../marketplace/fixtures'
import { encryptKey, decryptKey } from '../../src/lib/crypto'
import { validateProviderCredential } from '../../src/lib/marketplace/provider-auth-config'
import { buildUpstreamAuthentication } from '../../src/lib/marketplace/upstream-auth'
import { proxyRequest } from '../../src/lib/proxy'
import * as listings from '../../src/app/api/apis/route'
import * as listingRoute from '../../src/app/api/apis/[id]/route'
import { POST as verify } from '../../src/app/api/apis/[id]/verify/route'
import { POST as score } from '../../src/app/api/ai/score/route'
import type { AuthType } from '../../src/types'

const wallet = alice.address.toLowerCase()
const context = (id: string) => ({ params: Promise.resolve({ id }) })
const base = { name: 'Provider', description: 'API description', category: 'Data', price_per_call: 0.01,
  payment_model: 'pay-per-call', endpoint_url: 'https://provider.example/data', method: 'GET',
  example_request: '', example_response: '{}', dynamic_path_supported: false, path_parameters: [], query_parameters: [] }
const models: Array<{ type: AuthType; key?: string; param?: string; headers: Record<string, string> }> = [
  { type: 'public', headers: {} },
  { type: 'apikey', key: 'legacy-header-secret', headers: { 'x-api-key': 'legacy-header-secret' } },
  { type: 'bearer', key: 'legacy-bearer-secret', headers: { authorization: 'Bearer legacy-bearer-secret' } },
  { type: 'queryparam', key: 'legacy-query-secret', param: 'api_key', headers: {} },
  { type: 'basic', key: JSON.stringify({ username: 'token-identifier', password: 'basic-password' }),
    headers: { authorization: `Basic ${Buffer.from('token-identifier:basic-password').toString('base64')}` } },
  { type: 'basic', key: JSON.stringify({ username: 'basic-token-key', password: '' }),
    headers: { authorization: `Basic ${Buffer.from('basic-token-key:').toString('base64')}` } },
  { type: 'headers', key: JSON.stringify({ headers: [{ name: 'X-Custom-Key', value: 'custom-header-secret' }] }),
    headers: { 'x-custom-key': 'custom-header-secret' } },
  { type: 'headers', key: JSON.stringify({ headers: [{ name: 'api_key', value: 'underscore-secret' }],
    authorization: { scheme: 'Basic', username: 'client-identifier', password: 'client-secret' } }),
    headers: { api_key: 'underscore-secret', authorization: `Basic ${Buffer.from('client-identifier:client-secret').toString('base64')}` } },
  { type: 'authorization', key: JSON.stringify({ scheme: 'Token', token: 'custom-token-secret' }),
    headers: { authorization: 'Token custom-token-secret' } },
  { type: 'headers', key: JSON.stringify({ headers: [{ name: 'X-Client-ID', value: 'multi-identifier' },
    { name: 'X-Client-Secret', value: 'multi-secret' }], authorization: { scheme: 'Bearer', token: 'multi-bearer' } }),
    headers: { 'x-client-id': 'multi-identifier', 'x-client-secret': 'multi-secret', authorization: 'Bearer multi-bearer' } },
]
beforeEach(() => { reset(); resetBoundary() })
function request(path: string, method: string, body?: unknown, headers = sessionHeaders()) {
  return new NextRequest(origin + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

for (const [index, model] of models.entries()) test(`Create/Edit/Verify/Score/Proxy compatibility: ${model.type} ${index}`, async () => {
  const body = { ...base, auth_type: model.type, auth_key: model.key, auth_param_name: model.param }
  const created = await listings.POST(request('/api/apis', 'POST', body))
  assert.equal(created.status, 201, await created.text())
  const row = state.tables.api_listings[0]
  assert.equal(row.encrypted_key ? decryptKey(row.encrypted_key) : undefined, model.key)
  assert.equal(row.encrypted_key?.includes(model.key ?? '\x00'), model.key ? false : undefined)
  const publicBody = JSON.stringify(await (await listings.GET(request('/api/apis', 'GET'))).json())
  assert.ok(!publicBody.includes('encrypted_key'))
  const owner = await listingRoute.GET(request(`/api/apis/${row.id}`, 'GET'), context(row.id))
  assert.ok(!(await owner.text()).includes('encrypted_key'))
  const verified = await verify(request(`/api/apis/${row.id}/verify`, 'POST'), context(row.id))
  assert.equal((await verified.json()).verified, true)
  const scored = await score(request('/api/ai/score', 'POST', { api_id: row.id }))
  assert.equal((await scored.json()).endpoint_verified, true)
  const activate = await listingRoute.PATCH(request(`/api/apis/${row.id}`, 'PATCH', { is_active: true }), context(row.id))
  assert.equal(activate.status, 200, await activate.text())
  const catalog = await (await listings.GET(request('/api/apis', 'GET'))).json()
  assert.equal(catalog.apis.length, 1)
  assert.ok(!JSON.stringify(catalog).includes('encrypted_key'))
  const configured = buildUpstreamAuthentication(new URL(base.endpoint_url), model.type, model.key, model.param)
  for (const value of configured.secrets) assert.ok(!JSON.stringify(catalog).includes(value))
  boundary.requests = []
  const proxied = await proxyRequest({ apiId: row.id, buyerWallet: bob.address, paymentType: 'pay-per-call', method: 'GET',
    incomingHeaders: { authorization: 'attacker', 'x-custom-key': 'attacker', cookie: 'attacker' }, canonicalTarget: base.endpoint_url,
    purchaseId: 'purchase-fixture', deliveryAttemptId: 'delivery-fixture' })
  assert.equal(proxied.deliveryOutcome, 'succeeded')
  assert.equal(proxied.responsePersisted, true)
  const call = boundary.requests[0]
  assert.deepEqual(call.init.headers, { 'content-type': 'application/json', ...model.headers })
  assert.equal(new URL(call.url).searchParams.get('api_key'), model.type === 'queryparam' ? model.key : null)
  const replacement = model.type === 'public' ? undefined : model.key!.replaceAll('secret', 'replacement')
  const patch = replacement ? { auth_key: replacement } : { name: 'New name' }
  const headers = { ...sessionHeaders(), ...await operationHeaders(`/api/apis/${row.id}`, 'PATCH', patch) }
  const edited = await listingRoute.PATCH(request(`/api/apis/${row.id}`, 'PATCH', patch, headers), context(row.id))
  assert.equal(edited.status, 200, await edited.text())
  if (replacement) { assert.equal(decryptKey(row.encrypted_key), replacement); assert.equal(row.verified_at, null); assert.equal(row.is_active, false) }
})

test('credential headers reject reserved names, duplicates, injection and excessive bundles', () => {
  const unsafe = ['Authorization', 'Host', 'Cookie', 'Set-Cookie', 'Content-Length', 'Connection', 'Transfer-Encoding',
    'Payment-Signature', 'X-Payment', 'X-ARC-PRIVATE-MAINNET-ENABLED', 'X-Mahshar-Operation', 'X-Forwarded-Host',
    'Sec-Fetch-Site', 'Proxy-Authorization', '__proto__', 'X-Key\r\nHost', 'Content-Type', 'X-HTTP-Method-Override',
    'Idempotency-Key', 'X-Real-IP', 'If-Match', 'Cache-Control', 'X_Forwarded_Host', 'X.ARC.PRIVATE.MAINNET.ENABLED',
    'X-HTTP-Method', 'X-Method']
  for (const name of unsafe) assert.equal(validateProviderCredential('headers', JSON.stringify({ headers: [{ name, value: 'credential' }] })), false, name)
  for (const headers of [[{ name: 'X-Key', value: 'ok' }, { name: 'x-key', value: 'duplicate' }],
    [{ name: 'X-Key', value: 'bad\r\nInjected: yes' }], Array.from({ length: 9 }, (_, i) => ({ name: `X-Key-${i}`, value: 'secret' }))]) {
    assert.equal(validateProviderCredential('headers', JSON.stringify({ headers })), false)
  }
  for (const scheme of ['Basic', 'Bearer', 'Digest', 'Negotiate', 'Token\r\n']) assert.equal(
    validateProviderCredential('authorization', JSON.stringify({ scheme, token: 'token' })), false)
  assert.equal(validateProviderCredential('basic', '{"username":"bad:name","password":"valid"}'), false)
  assert.equal(validateProviderCredential('basic', '{"username":"user","password":"valid","extra":"ignored"}'), false)
  assert.throws(() => buildUpstreamAuthentication(new URL(base.endpoint_url), 'bearer', 'unsafe\nheader'))
  assert.equal(validateProviderCredential('bearer', '\ud800'), false)
  assert.equal(validateProviderCredential('queryparam', '\ud800', 'api_key'), false)
  assert.equal(validateProviderCredential('basic', JSON.stringify({ username: 'user', password: '\ud800' })), false)
})

test('all credential components, wire encodings, and JSON-escaped reflections are blocked before persistence and AI', async () => {
  for (const type of ['basic', 'headers', 'authorization'] as const) {
    const model = models.find(model => model.type === type)!
    const auth = buildUpstreamAuthentication(new URL(base.endpoint_url), model.type, model.key)
    for (const secret of auth.secrets) {
      reset(); resetBoundary()
      const row = { ...base, id: 'reflection', seller_wallet: wallet, auth_type: type, encrypted_key: encryptKey(model.key!),
        is_active: true, verified_at: new Date().toISOString() }
      state.tables.api_listings.push(row)
      boundary.response = Response.json({ echoed: secret })
      const result = await proxyRequest({ apiId: row.id, buyerWallet: bob.address, paymentType: 'pay-per-call',
        method: 'GET', incomingHeaders: {}, canonicalTarget: base.endpoint_url })
      assert.equal(result.errorCode, 'upstream_credential_reflection')
      assert.ok(!JSON.stringify(state.tables.api_calls).includes(secret))
      boundary.response = Response.json({ echoed: secret })
      const response = await score(request('/api/ai/score', 'POST', { api_id: row.id }))
      assert.equal((await response.json()).endpoint_verified, false)
      assert.ok(!JSON.stringify(boundary.aiTestResult).includes(secret))
      assert.ok(!JSON.stringify(boundary.aiInput).includes(secret))
    }
  }
})

test('invalid bundle and cross-tenant edits fail without mutations or upstream calls', async () => {
  const response = await listings.POST(request('/api/apis', 'POST', { ...base, auth_type: 'headers', auth_key: '{"headers":[{"name":"Host","value":"evil"}]}' }))
  assert.equal(response.status, 400)
  assert.equal(state.tables.api_listings.length, 0)
  assert.equal(boundary.requests.length, 0)
})

test('new bundle limits preserve large legacy keys/tokens and safely encoded legacy query credentials', () => {
  const large = 'legacy-key-'.repeat(2000)
  assert.equal(buildUpstreamAuthentication(new URL(base.endpoint_url), 'apikey', large).headers['x-api-key'], large)
  assert.equal(buildUpstreamAuthentication(new URL(base.endpoint_url), 'bearer', large).headers.authorization, `Bearer ${large}`)
  const multiline = 'legacy\nquery\ncredential'
  const query = buildUpstreamAuthentication(new URL(base.endpoint_url), 'queryparam', multiline, 'api_key')
  assert.equal(query.requestUrl.searchParams.get('api_key'), multiline)
  assert.ok(!query.requestUrl.toString().includes('\n'))
  assert.throws(() => buildUpstreamAuthentication(new URL(base.endpoint_url), 'headers', JSON.stringify({ headers: [{ name: 'X-Custom', value: large }] })))
})

test('reflection blocks the normalized wire value of credentials with surrounding whitespace', async () => {
  state.tables.api_listings.push({ ...base, id: 'wire-reflection', seller_wallet: wallet, auth_type: 'bearer',
    encrypted_key: encryptKey('  wire-private-key  '), is_active: true, verified_at: new Date().toISOString() })
  boundary.response = Response.json({ error: 'wire-private-key' }, { status: 401 })
  const result = await proxyRequest({ apiId: 'wire-reflection', buyerWallet: bob.address, paymentType: 'pay-per-call',
    method: 'GET', incomingHeaders: {}, canonicalTarget: base.endpoint_url })
  assert.equal(result.errorCode, 'upstream_credential_reflection')
  assert.ok(!JSON.stringify(state.tables.api_calls).includes('wire-private-key'))
})
