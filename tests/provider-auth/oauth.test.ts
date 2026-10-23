import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { boundary, resetBoundary } from './register.mjs'
import { alice, bob, origin, reset, sessionHeaders, operationHeaders, state } from '../marketplace/fixtures'
import { encryptKey, decryptKey } from '../../src/lib/crypto'
import { accessTokenForListing, listingOAuth, oauthHash, pkceChallenge } from '../../src/lib/marketplace/provider-oauth'
import { approvedOAuthProfile } from '../../src/lib/marketplace/provider-oauth-profiles'
import { proxyRequest } from '../../src/lib/proxy'
import * as oauth from '../../src/app/api/provider-oauth/[id]/route'
import * as callback from '../../src/app/api/provider-oauth/[id]/callback/route'
import { POST as verify } from '../../src/app/api/apis/[id]/verify/route'
import { POST as score } from '../../src/app/api/ai/score/route'
import { POST as createListing } from '../../src/app/api/apis/route'
import { PATCH as editListing } from '../../src/app/api/apis/[id]/route'

const profile = { id: 'fixture', token_endpoint: 'https://auth.provider.example/token',
  authorization_endpoint: 'https://auth.provider.example/authorize', revocation_endpoint: 'https://auth.provider.example/revoke',
  resource_origins: ['https://provider.example'], scopes: ['data.read'], grants: ['client_credentials', 'authorization_code'],
  client_auth: 'client_secret_basic' }
const seller = alice.address.toLowerCase(), buyer = bob.address.toLowerCase()
const context = { params: Promise.resolve({ id: 'oauth-listing' }) }
beforeEach(() => { reset(); resetBoundary(); process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([profile]) })

test('S256 PKCE matches the RFC 7636 reference vector', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('unsaved OAuth analysis asks to save and connect without acquiring or disclosing a token', async () => {
  const row = seed()
  const response = await score(request('/api/ai/score', 'POST', sessionHeaders(), {
    endpoint_url: row.endpoint_url, auth_type: row.auth_type, auth_key: decryptKey(row.encrypted_key),
  }))
  const body = await response.json()
  assert.equal(body.endpoint_verified, false)
  assert.match(body.blocking_issue, /Save the OAuth configuration/)
  assert.equal(boundary.requests.length, 0)
})
function seed(type = 'oauth_client_credentials', mode = 'seller', id = 'oauth-listing') {
  const row = { id, seller_wallet: seller, name: 'OAuth API', description: 'OAuth data', category: 'Data',
    endpoint_url: 'https://provider.example/data', method: 'GET', auth_type: type, auth_param_name: null,
    encrypted_key: encryptKey(JSON.stringify({ provider: 'fixture', client_id: 'client-id', client_secret: 'client-secret', account_mode: mode })),
    is_active: true, verified_at: new Date().toISOString(), dynamic_path_supported: false, path_parameters: [], query_parameters: [], example_request: '' }
  state.tables.api_listings.push(row)
  return row
}
function request(path: string, method: string, headers = sessionHeaders(), body?: unknown) {
  return new NextRequest(origin + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}
function tokens(access = 'access-fixture', refresh: string | undefined = 'refresh-fixture') {
  return Response.json({ access_token: access, token_type: 'Bearer', expires_in: 3600, ...(refresh ? { refresh_token: refresh } : {}), scope: 'data.read' })
}
async function consent(account = alice) {
  const headers: { origin: string; cookie: string; [name: string]: string } = {
    ...sessionHeaders(account), ...await operationHeaders('/api/provider-oauth/oauth-listing', 'POST', undefined, account),
  }
  const response = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', headers), context)
  assert.equal(response.status, 200, await response.clone().text())
  const url = new URL((await response.json()).authorization_url)
  const stateValue = url.searchParams.get('state')!
  const cookieName = `mahshar_oauth_${oauthHash(stateValue).slice(0, 20)}`
  const browser = response.headers.get('set-cookie')!.match(new RegExp(`${cookieName}=([^;]+)`))![1]
  return { url, stateValue, headers: { ...headers, cookie: `${headers.cookie}; ${cookieName}=${browser}` } }
}
async function complete(flow: Awaited<ReturnType<typeof consent>>, params = '') {
  return callback.GET(request(`/api/provider-oauth/oauth-listing/callback?state=${flow.stateValue}&code=authorization-code${params}`, 'GET', flow.headers), context)
}

test('Client Credentials securely acquires, encrypts, caches and renews under concurrent requests', async () => {
  const row = seed()
  boundary.respond = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return tokens() }
  const results = await Promise.all(Array.from({ length: 16 }, () => accessTokenForListing(row, buyer)))
  assert.equal(boundary.tokenCalls, 1)
  assert.ok(results.every(result => result.access_token === 'access-fixture'))
  const account = state.tables.provider_oauth_accounts[0]
  assert.equal(account.owner_wallet, seller)
  assert.ok(!account.encrypted_tokens.includes('access-fixture'))
  assert.equal(JSON.parse(decryptKey(account.encrypted_tokens)).access_token, 'access-fixture')
  const first = boundary.requests[0]
  assert.equal(first.url, profile.token_endpoint)
  assert.equal(new URLSearchParams(first.init.body).get('grant_type'), 'client_credentials')
  assert.equal(new URLSearchParams(first.init.body).get('client_secret'), null)
  assert.match(first.init.headers.authorization, /^Basic /)
  assert.equal(first.init.redirect, 'manual')
  account.expires_at = new Date(Date.now() - 1000).toISOString()
  await Promise.all(Array.from({ length: 12 }, () => accessTokenForListing(row, buyer)))
  assert.equal(boundary.tokenCalls, 2)
})

test('token endpoint validation rejects arbitrary destinations, malformed profiles, scopes and redirect endpoints', () => {
  for (const overrides of [{ token_endpoint: 'http://127.0.0.1/token' }, { token_endpoint: 'https://127.0.0.1/token' },
    { token_endpoint: 'https://auth.provider.example/token?redirect=x' }, { authorization_endpoint: 'javascript:alert(1)' },
    { resource_origins: ['https://elsewhere.example'] }, { scopes: ['data.read\r\n'] }, { client_auth: 'unknown' }]) {
    process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ ...profile, ...overrides }])
    assert.throws(() => approvedOAuthProfile('fixture', 'https://provider.example/data', 'authorization_code'))
  }
  delete process.env.PROVIDER_OAUTH_PROFILES
  assert.throws(() => approvedOAuthProfile('fixture', 'https://provider.example/data', 'client_credentials'))
})

test('OAuth Create rejects endpoint injection and only persists approved configuration encrypted', async () => {
  const base = { name: 'OAuth API', description: 'Data', category: 'Data', price_per_call: 0.01, payment_model: 'pay-per-call',
    endpoint_url: 'https://provider.example/data', auth_type: 'oauth_client_credentials' }
  const auth = { provider: 'fixture', client_id: 'client-id', client_secret: 'client-secret', account_mode: 'seller' }
  for (const invalid of [{ ...auth, token_endpoint: 'https://evil.example' }, { ...auth, provider: 'unapproved' }, { ...auth, account_mode: 'buyer' }]) {
    const response = await createListing(request('/api/apis', 'POST', sessionHeaders(), { ...base, auth_key: JSON.stringify(invalid) }))
    assert.equal(response.status, 400)
  }
  const response = await createListing(request('/api/apis', 'POST', sessionHeaders(), { ...base, auth_key: JSON.stringify(auth) }))
  assert.equal(response.status, 201, await response.text())
  assert.equal(boundary.tokenCalls, 0)
  assert.ok(!state.tables.api_listings[0].encrypted_key.includes('client-secret'))
})

test('PKCE consent uses fixed callback, unpredictable state, encrypted verifier and browser/session binding', async () => {
  seed('oauth_pkce')
  const flow = await consent()
  assert.equal(flow.url.origin + flow.url.pathname, profile.authorization_endpoint)
  assert.equal(flow.url.searchParams.get('redirect_uri'), `${origin}/api/provider-oauth/oauth-listing/callback`)
  const pending = state.tables.provider_oauth_states[0]
  assert.notEqual(pending.encrypted_verifier, decryptKey(pending.encrypted_verifier))
  assert.equal(flow.url.searchParams.get('code_challenge'), pkceChallenge(decryptKey(pending.encrypted_verifier)))
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(pending.state_hash, oauthHash(flow.stateValue))
  assert.ok(!JSON.stringify(pending).includes(flow.stateValue))
  boundary.response = tokens()
  const completed = await complete(flow)
  assert.equal(completed.status, 303)
  assert.equal(completed.headers.get('location'), `${origin}/dashboard?provider_oauth=connected`)
  assert.equal(completed.headers.get('referrer-policy'), 'no-referrer')
  const exchange = new URLSearchParams(boundary.requests[0].init.body)
  assert.equal(exchange.get('code_verifier'), decryptKey(pending.encrypted_verifier))
  assert.equal(exchange.get('code'), 'authorization-code')
  assert.ok(!completed.headers.get('location')!.includes('access-fixture'))
})

test('OAuth rejects CSRF, missing browser binding, wrong session/tenant, expiry, duplicate parameters, replay and consent denial', async () => {
  seed('oauth_pkce')
  const flow = await consent()
  boundary.response = tokens()
  const badOrigin = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', { ...flow.headers, origin: 'https://evil.example' }), context)
  assert.equal(badOrigin.status, 403)
  const b = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', sessionHeaders(bob)), context)
  assert.equal(b.status, 403)
  for (const headers of [sessionHeaders(), { ...flow.headers, cookie: sessionHeaders(bob).cookie + '; ' + flow.headers.cookie.split('; ')[1] }]) {
    const response = await complete({ ...flow, headers })
    assert.match(response.headers.get('location')!, /failed$/)
  }
  const dup = await complete(flow, '&state=duplicate')
  assert.match(dup.headers.get('location')!, /failed$/)
  assert.equal(boundary.tokenCalls, 0)
  const success = await complete(flow)
  assert.match(success.headers.get('location')!, /connected$/)
  const replay = await complete(flow)
  assert.match(replay.headers.get('location')!, /failed$/)
  assert.equal(boundary.tokenCalls, 1)
  const denied = await consent()
  assert.match((await complete(denied, '&error=access_denied')).headers.get('location')!, /failed$/)
  const expired = await consent()
  state.tables.provider_oauth_states.find(row => row.state_hash === oauthHash(expired.stateValue))!.expires_at = new Date(0).toISOString()
  assert.match((await complete(expired)).headers.get('location')!, /failed$/)
  assert.equal(boundary.tokenCalls, 1)
})

test('buyer-delegated accounts remain isolated and never fall back to seller tokens', async () => {
  const row = seed('oauth_pkce', 'buyer')
  boundary.response = tokens('seller-own-buyer-token', 'seller-refresh')
  const sellerFlow = await consent(alice)
  await complete(sellerFlow)
  await assert.rejects(accessTokenForListing(row, buyer))
  boundary.response = tokens('buyer-own-token', 'buyer-refresh')
  const buyerFlow = await consent(bob)
  await complete(buyerFlow)
  assert.equal((await accessTokenForListing(row, buyer)).access_token, 'buyer-own-token')
  assert.equal((await accessTokenForListing(row, seller)).access_token, 'seller-own-buyer-token')
  assert.equal(state.tables.provider_oauth_accounts.length, 2)
  await oauth.DELETE(request('/api/provider-oauth/oauth-listing', 'DELETE', buyerFlow.headers), context)
  await assert.rejects(accessTokenForListing(row, buyer))
  assert.equal((await accessTokenForListing(row, seller)).access_token, 'seller-own-buyer-token')
  assert.equal(row.is_active, true)
})

test('rotating refresh tokens serialize across requests and preserve replacements encrypted', async () => {
  const row = seed('oauth_pkce')
  boundary.response = tokens('initial-access', 'refresh-initial')
  const flow = await consent(); await complete(flow)
  state.tables.provider_oauth_accounts[0].expires_at = new Date(0).toISOString()
  boundary.requests = []; boundary.tokenCalls = 0
  boundary.respond = async call => {
    assert.equal(new URLSearchParams(call.init.body).get('grant_type'), 'refresh_token')
    assert.equal(new URLSearchParams(call.init.body).get('refresh_token'), 'refresh-initial')
    assert.equal(new URLSearchParams(call.init.body).get('redirect_uri'), flow.url.searchParams.get('redirect_uri'))
    await new Promise(resolve => setTimeout(resolve, 20))
    return tokens('refreshed-access', 'refresh-rotated')
  }
  const results = await Promise.all(Array.from({ length: 20 }, () => accessTokenForListing(row, buyer)))
  assert.equal(boundary.tokenCalls, 1)
  assert.ok(results.every(result => result.access_token === 'refreshed-access'))
  assert.equal(JSON.parse(decryptKey(state.tables.provider_oauth_accounts[0].encrypted_tokens)).refresh_token, 'refresh-rotated')
})

test('invalid/uncertain token responses fail closed without retrying rotating refresh tokens', async () => {
  for (const tokenResponse of [Response.json({ error: 'invalid_grant' }, { status: 400 }),
    Response.json({ access_token: 'unsafe\r\n', token_type: 'Bearer', expires_in: 3600 }),
    Response.json({ access_token: 'okay', token_type: 'MAC', expires_in: 3600 }),
    Response.json({ access_token: 'okay', token_type: 'Bearer', expires_in: 1 }),
    Response.json({ access_token: 'okay', token_type: 'Bearer', expires_in: 3600, scope: 'admin' }),
    new Response(null, { status: 302, headers: { location: 'https://evil.example' } })]) {
    reset(); resetBoundary(); const row = seed()
    boundary.response = tokenResponse
    await assert.rejects(accessTokenForListing(row, buyer))
    await assert.rejects(accessTokenForListing(row, buyer))
    assert.equal(boundary.tokenCalls, 1)
    assert.equal(state.tables.provider_oauth_accounts[0].status, 'reauthorization_required')
  }
})

test('disconnect fences in-flight refresh and callback completion; no token resurrection', async () => {
  const row = seed('oauth_pkce')
  boundary.response = tokens()
  const flow = await consent(); await complete(flow)
  state.tables.provider_oauth_accounts[0].expires_at = new Date(0).toISOString()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  boundary.respond = async call => {
    if (call.url === profile.token_endpoint) { await gate; return tokens('new-token', 'new-refresh') }
    return new Response(null, { status: 200 })
  }
  const pendingRefresh = accessTokenForListing(row, buyer)
  await new Promise(resolve => setTimeout(resolve, 5))
  const disconnected = await oauth.DELETE(request('/api/provider-oauth/oauth-listing', 'DELETE', flow.headers), context)
  assert.equal((await disconnected.json()).disconnected, true)
  release(); await assert.rejects(pendingRefresh)
  assert.equal(state.tables.provider_oauth_accounts[0].encrypted_tokens, null)
  assert.equal(row.is_active, false)
  const next = await consent()
  boundary.respond = async call => {
    if (call.url === profile.token_endpoint) {
      await oauth.DELETE(request('/api/provider-oauth/oauth-listing', 'DELETE', next.headers), context)
      return tokens('cancelled-access', 'cancelled-refresh')
    }
    return new Response(null, { status: 200 })
  }
  assert.match((await complete(next)).headers.get('location')!, /failed$/)
  assert.equal(state.tables.provider_oauth_accounts[0].encrypted_tokens, null)
})

for (const type of ['oauth_client_credentials', 'oauth_pkce']) test(`OAuth Verify/Score/Proxy server-side tokens: ${type}`, async () => {
  const row = seed(type)
  boundary.respond = async call => call.url === profile.token_endpoint ? tokens() : Response.json({ data: 'safe-data' })
  if (type === 'oauth_pkce') { const flow = await consent(); await complete(flow) }
  row.verified_at = null as any
  assert.equal((await (await verify(request('/api/apis/oauth-listing/verify', 'POST'), context)).json()).verified, true)
  assert.equal((await (await score(request('/api/ai/score', 'POST', sessionHeaders(), { api_id: row.id }))).json()).endpoint_verified, true)
  row.is_active = true // Equivalent to the existing explicit activation after verification.
  const result = await proxyRequest({ apiId: row.id, buyerWallet: buyer, paymentType: 'pay-per-call', method: 'GET',
    incomingHeaders: { authorization: 'attacker' }, canonicalTarget: row.endpoint_url, purchaseId: 'purchase-id', deliveryAttemptId: 'delivery-id' })
  assert.equal(result.deliveryOutcome, 'succeeded')
  assert.equal(result.responsePersisted, true)
  const resourceCalls = boundary.requests.filter(call => call.url === row.endpoint_url)
  assert.ok(resourceCalls.every(call => call.init.headers.authorization === 'Bearer access-fixture'))
  assert.ok(!JSON.stringify(boundary.aiInput).includes('access-fixture'))
  assert.ok(!JSON.stringify(state.tables.api_calls).includes('access-fixture'))
  const status = await oauth.GET(request('/api/provider-oauth/oauth-listing', 'GET'), context)
  assert.ok(!(await status.text()).includes('access-fixture'))
})

test('configuration or approved profile changes invalidate existing tokens and pending consent', async () => {
  const row = seed('oauth_pkce')
  boundary.response = tokens()
  const flow = await consent(); await complete(flow)
  const hash = listingOAuth(row).hash
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ ...profile, scopes: ['other.read'] }])
  assert.notEqual(listingOAuth(row).hash, hash)
  await assert.rejects(accessTokenForListing(row, buyer))
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([profile])
  const pending = await consent()
  row.encrypted_key = encryptKey(decryptKey(row.encrypted_key))
  assert.match((await complete(pending)).headers.get('location')!, /failed$/)
})

test('disconnect still erases local credentials when an approved provider profile has been removed', async () => {
  const row = seed()
  boundary.response = tokens()
  await accessTokenForListing(row, buyer)
  delete process.env.PROVIDER_OAUTH_PROFILES
  const response = await oauth.DELETE(request('/api/provider-oauth/oauth-listing', 'DELETE'), context)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { disconnected: true, provider_revoked: false })
  assert.equal(state.tables.provider_oauth_accounts[0].encrypted_tokens, null)
  assert.equal(row.is_active, false)
})

test('client_secret_post and public PKCE profiles use the approved authentication style', async () => {
  for (const clientAuth of ['client_secret_post', 'none']) {
    reset(); resetBoundary()
    process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([{ ...profile, client_auth: clientAuth }])
    const row = seed(clientAuth === 'none' ? 'oauth_pkce' : 'oauth_client_credentials')
    if (clientAuth === 'none') {
      const config = JSON.parse(decryptKey(row.encrypted_key)); delete config.client_secret
      row.encrypted_key = encryptKey(JSON.stringify(config))
    }
    boundary.response = tokens()
    if (clientAuth === 'none') { const flow = await consent(); await complete(flow) }
    else await accessTokenForListing(row, buyer)
    const tokenRequest = boundary.requests.find(call => call.url === profile.token_endpoint)!
    const form = new URLSearchParams(tokenRequest.init.body)
    assert.equal(form.get('client_id'), 'client-id')
    assert.equal(form.get('client_secret'), clientAuth === 'none' ? null : 'client-secret')
    assert.equal(tokenRequest.init.headers.authorization, undefined)
  }
})

test('refresh keeps the existing refresh token when the provider does not rotate it', async () => {
  const row = seed('oauth_pkce')
  boundary.response = tokens('first-access', 'retained-refresh')
  const flow = await consent(); await complete(flow)
  state.tables.provider_oauth_accounts[0].expires_at = new Date(0).toISOString()
  boundary.response = tokens('second-access', undefined)
  // Explicitly omit the field (the helper defaults an undefined argument).
  boundary.response = Response.json({ access_token: 'second-access', token_type: 'Bearer', expires_in: 3600 })
  await accessTokenForListing(row, buyer)
  assert.equal(JSON.parse(decryptKey(state.tables.provider_oauth_accounts[0].encrypted_tokens)).refresh_token, 'retained-refresh')
})

test('token cache is isolated by listing, owner, mode and exact encrypted configuration', async () => {
  const one = seed(), two = seed('oauth_client_credentials', 'seller', 'other-listing')
  boundary.respond = async () => tokens(`access-${boundary.tokenCalls}`)
  const [first, second] = await Promise.all([accessTokenForListing(one, buyer), accessTokenForListing(two, seller)])
  assert.notEqual(first.access_token, second.access_token)
  assert.equal(boundary.tokenCalls, 2)
  assert.equal(state.tables.provider_oauth_accounts.length, 2)
  assert.equal((await accessTokenForListing(one, seller)).access_token, first.access_token)
})

test('callback rejects concurrent replay and account status reveals no other owner connection details', async () => {
  seed('oauth_pkce')
  boundary.response = tokens()
  const flow = await consent()
  const results = await Promise.all([complete(flow), complete(flow), complete(flow)])
  assert.equal(results.filter(result => result.headers.get('location')!.endsWith('connected')).length, 1)
  assert.equal(boundary.tokenCalls, 1)
  const response = await oauth.GET(request('/api/provider-oauth/oauth-listing', 'GET', sessionHeaders(bob)), context)
  assert.deepEqual(await response.json(), { account_mode: 'seller', status: 'managed_by_seller', expires_at: null })
})

test('buyers can disconnect their account after the seller deactivates the listing', async () => {
  const row = seed('oauth_pkce', 'buyer')
  boundary.response = tokens()
  const flow = await consent(bob); await complete(flow)
  row.is_active = false
  const response = await oauth.DELETE(request('/api/provider-oauth/oauth-listing', 'DELETE', flow.headers), context)
  assert.equal(response.status, 200)
  assert.equal(state.tables.provider_oauth_accounts[0].encrypted_tokens, null)
})

test('connecting requires a fresh wallet operation proof and seller reconnection invalidates verification', async () => {
  const row = seed('oauth_pkce')
  const unsigned = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST'), context)
  assert.equal(unsigned.status, 401)
  assert.equal(state.tables.provider_oauth_states.length, 0)
  boundary.response = tokens()
  const flow = await consent(); await complete(flow)
  assert.equal(row.is_active, false)
  assert.equal(row.verified_at, null)
  const replay = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', flow.headers), context)
  assert.equal(replay.status, 409)
  assert.equal(state.tables.provider_oauth_states.length, 0)
})

test('Client Credentials reconnect requires the owner proof, clears cached tokens and requires verification again', async () => {
  const row = seed()
  boundary.response = tokens()
  await accessTokenForListing(row, buyer)
  assert.equal(state.tables.provider_oauth_accounts.length, 1)
  const headers = { ...sessionHeaders(), ...await operationHeaders('/api/provider-oauth/oauth-listing', 'POST') }
  const response = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', headers), context)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(state.tables.provider_oauth_accounts.length, 0)
  assert.equal(row.is_active, false)
  assert.equal(row.verified_at, null)
  await accessTokenForListing(row, buyer)
  assert.equal(boundary.tokenCalls, 2)
})

test('consent and listing edits bound input before proof verification and reject arbitrary OAuth parameters', async () => {
  seed('oauth_pkce')
  const oversized = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', sessionHeaders(), 'x'.repeat(2048)), context)
  assert.equal(oversized.status, 413)
  const injected = await oauth.POST(request('/api/provider-oauth/oauth-listing', 'POST', sessionHeaders(), { token_endpoint: 'https://evil.example' }), context)
  assert.equal(injected.status, 400)
  const edit = await editListing(request('/api/apis/oauth-listing', 'PATCH', sessionHeaders(), { auth_key: 'x'.repeat(65536) }), context)
  assert.equal(edit.status, 413)
  assert.equal(boundary.requests.length, 0)
  assert.equal(state.tables.withdraw_used_nonces.length, 0)
})

for (const action of ['verify', 'score']) test(`seller reconnect fences an in-flight ${action} from the former account`, async () => {
  const row = seed('oauth_pkce')
  boundary.response = tokens()
  const first = await consent(); await complete(first)
  const oldCiphertext = row.encrypted_key
  boundary.respond = async call => {
    if (call.url === row.endpoint_url) {
      const next = await consent()
      assert.ok(next.stateValue)
      assert.notEqual(row.encrypted_key, oldCiphertext)
      return Response.json({ result: 'old-account-response' })
    }
    return tokens()
  }
  const response = action === 'verify'
    ? await verify(request('/api/apis/oauth-listing/verify', 'POST'), context)
    : await score(request('/api/ai/score', 'POST', sessionHeaders(), { api_id: row.id }))
  assert.equal(response.status, 409, await response.clone().text())
  assert.equal(row.verified_at, null)
  assert.equal(row.is_active, false)
})

for (const type of ['oauth_client_credentials', 'oauth_pkce']) test(`OAuth Edit requires the owner proof and invalidates verification: ${type}`, async () => {
  const row = seed(type)
  const patch = { auth_key: JSON.stringify({ provider: 'fixture', client_id: 'replacement-id',
    client_secret: 'replacement-secret', account_mode: 'seller' }) }
  assert.equal((await editListing(request('/api/apis/oauth-listing', 'PATCH', sessionHeaders(), patch), context)).status, 401)
  assert.equal((await editListing(request('/api/apis/oauth-listing', 'PATCH', sessionHeaders(bob), patch), context)).status, 403)
  const headers = { ...sessionHeaders(), ...await operationHeaders('/api/apis/oauth-listing', 'PATCH', patch) }
  assert.equal((await editListing(request('/api/apis/oauth-listing', 'PATCH', headers, patch), context)).status, 200)
  assert.equal(row.is_active, false)
  assert.equal(row.verified_at, null)
  assert.equal(JSON.parse(decryptKey(row.encrypted_key)).client_id, 'replacement-id')
  assert.equal(boundary.tokenCalls, 0)
})

// Documentation-derived contracts only. Outbound HTTP remains fully mocked;
// these tests neither authorize accounts nor certify real provider responses.
const testProfiles = JSON.parse(readFileSync('docs/security/provider-oauth-test-profiles.json', 'utf8'))
test('documented Bitbucket CC profile uses Basic client auth and a seller-owned Bearer resource token', async () => {
  const selected = testProfiles.find((value: { id: string }) => value.id === 'bitbucket-test-cc')
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([selected])
  const row = seed()
  row.endpoint_url = 'https://api.bitbucket.org/2.0/repositories/fixture-workspace/p2-auth-probe'
  row.encrypted_key = encryptKey(JSON.stringify({ provider: selected.id, client_id: 'fixture-consumer',
    client_secret: 'fixture-consumer-secret', account_mode: 'seller' }))
  boundary.respond = call => {
    assert.equal(call.url, selected.token_endpoint)
    assert.equal(call.init.headers.authorization, 'Basic ' + Buffer.from('fixture-consumer:fixture-consumer-secret').toString('base64'))
    const form = new URLSearchParams(call.init.body)
    assert.equal(form.get('grant_type'), 'client_credentials')
    assert.equal(form.get('scope'), 'repository')
    assert.equal(form.has('client_secret'), false)
    return Response.json({ access_token: 'bitbucket-fixture-access', token_type: 'bearer', expires_in: 7200,
      scopes: 'repository' })
  }
  assert.equal((await accessTokenForListing(row, buyer)).access_token, 'bitbucket-fixture-access')
  assert.equal(state.tables.provider_oauth_accounts[0].owner_wallet, seller)
})

test('documented GitLab public PKCE profile exchanges and rotates with the original callback URI', async () => {
  const selected = testProfiles.find((value: { id: string }) => value.id === 'gitlab-test-pkce')
  process.env.PROVIDER_OAUTH_PROFILES = JSON.stringify([selected])
  const row = seed('oauth_pkce')
  row.endpoint_url = 'https://gitlab.com/api/v4/user'
  row.encrypted_key = encryptKey(JSON.stringify({ provider: selected.id, client_id: 'fixture-gitlab-id', account_mode: 'seller' }))
  const flow = await consent()
  assert.equal(flow.url.origin + flow.url.pathname, selected.authorization_endpoint)
  assert.equal(flow.url.searchParams.get('scope'), 'read_user')
  let calls = 0
  boundary.respond = call => {
    assert.equal(call.url, selected.token_endpoint)
    assert.equal(call.init.headers.authorization, undefined)
    const form = new URLSearchParams(call.init.body)
    assert.equal(form.get('client_id'), 'fixture-gitlab-id')
    assert.equal(form.has('client_secret'), false)
    assert.equal(form.get('redirect_uri'), flow.url.searchParams.get('redirect_uri'))
    if (++calls === 1) {
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert.equal(pkceChallenge(form.get('code_verifier')!), flow.url.searchParams.get('code_challenge'))
    } else {
      assert.equal(form.get('grant_type'), 'refresh_token')
      assert.equal(form.get('refresh_token'), 'gitlab-fixture-refresh-1')
    }
    return Response.json({ access_token: `gitlab-fixture-access-${calls}`, token_type: 'bearer', expires_in: 7200,
      refresh_token: `gitlab-fixture-refresh-${calls}`, scope: 'read_user' })
  }
  assert.match((await complete(flow)).headers.get('location')!, /provider_oauth=connected/)
  state.tables.provider_oauth_accounts[0].expires_at = new Date(0).toISOString()
  assert.equal((await accessTokenForListing(row, seller)).access_token, 'gitlab-fixture-access-2')
  assert.equal(calls, 2)
  assert.equal(JSON.parse(decryptKey(state.tables.provider_oauth_accounts[0].encrypted_tokens)).refresh_token, 'gitlab-fixture-refresh-2')
})
