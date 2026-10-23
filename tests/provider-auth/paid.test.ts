import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { boundary, resetBoundary } from './register.mjs'
import { paidBoundary, resetPaid } from './paid-register.mjs'
import { alice, bob, reset, sessionHeaders, state, origin } from '../marketplace/fixtures'
import { encryptKey } from '../../src/lib/crypto'
import { POST as envelopeProxy } from '../../src/app/api/proxy/route'
import { GET as pathProxy } from '../../src/app/api/proxy/[api_id]/route'
import { GET as recover } from '../../src/app/api/calls/last-response/route'
import { PURCHASE_ACCESS_HEADER } from '../../src/lib/marketplace/purchase-access'
import { listingOAuth } from '../../src/lib/marketplace/provider-oauth'
import type { AuthType } from '../../src/types'

const apiId = '11111111-1111-4111-8111-111111111111'
const seller = alice.address.toLowerCase(), buyer = bob.address.toLowerCase()
beforeEach(() => { reset(); resetBoundary(); resetPaid(); paidBoundary.payer = buyer })
function seed(type: AuthType, credential?: string) {
  const row = { id: apiId, name: 'Paid provider', seller_wallet: seller, price_per_call: 0.01, auth_type: type,
    encrypted_key: credential ? encryptKey(credential) : null, auth_param_name: type === 'queryparam' ? 'api_key' : null, method: 'GET',
    endpoint_url: 'https://provider.example/data', is_active: true, verified_at: new Date().toISOString(),
    dynamic_path_supported: false, path_parameters: [], query_parameters: [] }
  state.tables.api_listings.push(row)
  return row
}
function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, { method, headers: { origin, 'payment-signature': 'synthetic-no-money', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}
const models: Array<[AuthType, string | undefined, string, string]> = [
  ['public', undefined, 'content-type', 'application/json'],
  ['apikey', 'paid-legacy-key', 'x-api-key', 'paid-legacy-key'],
  ['bearer', 'paid-legacy-bearer', 'authorization', 'Bearer paid-legacy-bearer'],
  ['queryparam', 'paid-legacy-query', 'query:api_key', 'paid-legacy-query'],
  ['basic', '{"username":"token-id","password":"paid-basic-secret"}', 'authorization', `Basic ${Buffer.from('token-id:paid-basic-secret').toString('base64')}`],
  ['headers', '{"headers":[{"name":"X-Provider-Key","value":"paid-custom-secret"}]}', 'x-provider-key', 'paid-custom-secret'],
  ['authorization', '{"scheme":"Token","token":"paid-token-secret"}', 'authorization', 'Token paid-token-secret'],
  ['authorization', '{"scheme":"ApiKey","token":"paid-apikey-secret"}', 'authorization', 'ApiKey paid-apikey-secret'],
  ['headers', '{"headers":[{"name":"X-Provider-Key","value":"paid-multi-secret"},{"name":"Client.ID","value":"client-identity"}],"authorization":{"scheme":"Bearer","token":"paid-multi-bearer"}}', 'authorization', 'Bearer paid-multi-bearer'],
  ['headers', '{"headers":[{"name":"api_key","value":"paid-combined-secret"}],"authorization":{"scheme":"Basic","username":"paid-identifier","password":"paid-password"}}', 'authorization', `Basic ${Buffer.from('paid-identifier:paid-password').toString('base64')}`],
]
for (const [index, [type, credential, name, value]] of models.entries()) for (const entrance of ['envelope', 'path']) test(`paid ${index} ${type}/${entrance}: actual proxy, durable delivery, replay and capability-only recovery`, async () => {
  seed(type, credential)
  const input = { api_id: apiId, buyer_wallet: buyer }
  const execute = () => entrance === 'envelope' ? envelopeProxy(request('/api/proxy', 'POST', input))
    : pathProxy(request(`/api/proxy/${apiId}`, 'GET'), { params: Promise.resolve({ api_id: apiId }) })
  const response = await execute()
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json()
  assert.equal(body.payment, 'ACCOUNTING_COMPLETE')
  assert.equal(body.delivery_state, 'SUCCEEDED')
  assert.deepEqual(body.response, { result: 'safe-result' })
  assert.equal(name.startsWith('query:') ? new URL(boundary.requests[0].url).searchParams.get('api_key') : boundary.requests[0].init.headers[name], value)
  if (credential?.includes('paid-multi-secret')) {
    assert.equal(boundary.requests[0].init.headers['x-provider-key'], 'paid-multi-secret')
    assert.equal(boundary.requests[0].init.headers['client.id'], 'client-identity')
  }
  assert.equal(state.settled, 1)
  assert.equal(boundary.requests.length, 1)
  const replay = await execute()
  assert.equal(replay.status, 200)
  assert.equal(state.settled, 1)
  assert.equal(boundary.requests.length, 1)
  const recovered = await recover(request(`/api/calls/last-response?api_id=${apiId}&buyer_wallet=${buyer}`, 'GET', undefined,
    { [PURCHASE_ACCESS_HEADER]: body.purchase_access_token }))
  assert.equal(recovered.status, 200)
  assert.deepEqual((await recovered.json()).response_body, { result: 'safe-result' })
  assert.ok(!JSON.stringify(state.tables.api_calls).includes(value))
})

test('both paid entrances reject missing buyer OAuth connection before payment or upstream dispatch', async () => {
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ id: 'fixture', token_endpoint: 'https://auth.provider.example/token',
    authorization_endpoint: 'https://auth.provider.example/authorize', resource_origins: ['https://provider.example'], scopes: [],
    grants: ['authorization_code'], client_auth: 'none' }])
  seed('oauth_pkce', '{"provider":"fixture","client_id":"buyer-client","account_mode":"buyer"}')
  const headers = sessionHeaders(bob)
  const envelope = await envelopeProxy(request('/api/proxy', 'POST', { api_id: apiId, buyer_wallet: buyer }, headers))
  assert.equal(envelope.status, 409)
  assert.equal((await envelope.json()).error, 'provider_connection_required')
  const path = await pathProxy(request(`/api/proxy/${apiId}`, 'GET', undefined, headers), { params: Promise.resolve({ api_id: apiId }) })
  assert.equal(path.status, 409)
  assert.equal(state.settled, 0)
  assert.equal(boundary.requests.length, 0)
})

for (const [type, mode] of [['oauth_client_credentials', 'seller'], ['oauth_pkce', 'seller'], ['oauth_pkce', 'buyer']] as const) for (const entrance of ['envelope', 'path']) {
  test(`paid OAuth ${type}/${mode}/${entrance} keeps tokens server-side and recovers the original response`, async () => {
    process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ id: 'fixture', token_endpoint: 'https://auth.provider.example/token',
      authorization_endpoint: 'https://auth.provider.example/authorize', resource_origins: ['https://provider.example'], scopes: [],
      grants: ['authorization_code', 'client_credentials'], client_auth: 'client_secret_post' }])
    const row = seed(type, JSON.stringify({ provider: 'fixture', client_id: 'client-id', client_secret: 'client-secret', account_mode: mode }))
    if (type === 'oauth_pkce') {
      for (const owner of [seller, buyer]) state.tables.provider_oauth_accounts.push({ id: owner, api_id: apiId,
        owner_wallet: owner, account_mode: mode, config_hash: listingOAuth(row).hash, status: 'active', revision: 0,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        encrypted_tokens: encryptKey(JSON.stringify({ access_token: owner === buyer ? 'buyer-token' : 'seller-token',
          refresh_token: 'refresh-token', expires_at: Date.now() + 3600000 })), lease_id: null })
    }
    boundary.respond = async call => call.url.endsWith('/token')
      ? Response.json({ access_token: 'client-token', token_type: 'Bearer', expires_in: 3600 })
      : Response.json({ original: 'paid-response' })
    const headers = sessionHeaders(bob), input = { api_id: apiId, buyer_wallet: buyer }
    const execute = () => entrance === 'envelope' ? envelopeProxy(request('/api/proxy', 'POST', input, headers))
      : pathProxy(request(`/api/proxy/${apiId}`, 'GET', undefined, headers), { params: Promise.resolve({ api_id: apiId }) })
    const response = await execute()
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    const resource = boundary.requests.find(call => call.url === row.endpoint_url)!
    assert.equal(resource.init.headers.authorization, `Bearer ${type === 'oauth_client_credentials' ? 'client-token' : mode === 'buyer' ? 'buyer-token' : 'seller-token'}`)
    assert.equal(body.delivery_state, 'SUCCEEDED')
    const replay = await execute()
    assert.equal(replay.status, 200)
    assert.equal(state.settled, 1)
    assert.equal(boundary.requests.filter(call => call.url === row.endpoint_url).length, 1)
    const recovered = await recover(request(`/api/calls/last-response?api_id=${apiId}&buyer_wallet=${buyer}`, 'GET', undefined,
      { [PURCHASE_ACCESS_HEADER]: body.purchase_access_token }))
    assert.deepEqual((await recovered.json()).response_body, { original: 'paid-response' })
    assert.ok(!JSON.stringify(state.tables.api_calls).includes('token'))
  })
}

for (const entrance of ['envelope', 'path']) test(`buyer session cannot use another payer's account; same-proof owner recovery: ${entrance}`, async () => {
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ id: 'fixture', token_endpoint: 'https://auth.provider.example/token',
    authorization_endpoint: 'https://auth.provider.example/authorize', resource_origins: ['https://provider.example'], scopes: [],
    grants: ['authorization_code'], client_auth: 'none' }])
  const row = seed('oauth_pkce', '{"provider":"fixture","client_id":"client-id","account_mode":"buyer"}')
  for (const owner of [seller, buyer]) state.tables.provider_oauth_accounts.push({ id: owner, api_id: apiId,
    owner_wallet: owner, account_mode: 'buyer', config_hash: listingOAuth(row).hash, status: 'active', revision: 0,
    expires_at: new Date(Date.now() + 3600000).toISOString(), encrypted_tokens: encryptKey(JSON.stringify({
      access_token: owner === buyer ? 'buyer-private-token' : 'seller-private-token', expires_at: Date.now() + 3600000 })), lease_id: null })
  const call = async (account: typeof alice) => entrance === 'envelope'
    ? envelopeProxy(request('/api/proxy', 'POST', { api_id: apiId, buyer_wallet: account.address.toLowerCase() }, sessionHeaders(account)))
    : pathProxy(request(`/api/proxy/${apiId}`, 'GET', undefined, sessionHeaders(account)), { params: Promise.resolve({ api_id: apiId }) })
  const mismatch = await call(alice)
  assert.equal(mismatch.status, 403)
  const rejected = await mismatch.json()
  assert.equal(rejected.error, 'provider_account_wallet_mismatch')
  assert.equal(rejected.payment, 'ACCOUNTING_COMPLETE')
  assert.equal('purchase_access_token' in rejected, false)
  assert.equal(boundary.requests.length, 0)
  assert.equal(state.settled, 1)
  const correctOwner = await call(bob)
  assert.equal(correctOwner.status, 200, await correctOwner.clone().text())
  assert.equal((await correctOwner.json()).delivery_state, 'SUCCEEDED')
  assert.equal(state.settled, 1)
  assert.equal(boundary.requests[0].init.headers.authorization, 'Bearer buyer-private-token')
})

test('OAuth and additional encrypted resource credentials compose without forwarding them to the token endpoint', async () => {
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ id: 'fixture', token_endpoint: 'https://auth.provider.example/token',
    resource_origins: ['https://provider.example'], scopes: [], grants: ['client_credentials'], client_auth: 'client_secret_post' }])
  seed('oauth_client_credentials', JSON.stringify({ provider: 'fixture', client_id: 'client-id', client_secret: 'client-secret',
    account_mode: 'seller', headers: [{ name: 'Developer_Token', value: 'private-developer-token' }] }))
  boundary.respond = async call => call.url.endsWith('/token')
    ? Response.json({ access_token: 'client-access-token', token_type: 'Bearer', expires_in: 3600 })
    : Response.json({ result: 'safe-resource' })
  const response = await envelopeProxy(request('/api/proxy', 'POST', { api_id: apiId, buyer_wallet: buyer }, sessionHeaders(bob)))
  assert.equal(response.status, 200, await response.clone().text())
  const token = boundary.requests.find(call => call.url.endsWith('/token'))!
  assert.equal(token.init.headers.developer_token, undefined)
  assert.ok(!token.init.body!.includes('private-developer-token'))
  const resource = boundary.requests.find(call => call.url === 'https://provider.example/data')!
  assert.equal(resource.init.headers.developer_token, 'private-developer-token')
  assert.equal(resource.init.headers.authorization, 'Bearer client-access-token')
  assert.ok(!JSON.stringify(state.tables.api_calls).includes('private-developer-token'))
})
