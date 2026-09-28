import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { encryptKey } from '../../src/lib/crypto'
import { alice, bob, state, reset, operationHeaders, origin } from './fixtures'
import * as listings from '../../src/app/api/apis/route'
import * as listing from '../../src/app/api/apis/[id]/route'
import * as verify from '../../src/app/api/apis/[id]/verify/route'
import * as calls from '../../src/app/api/calls/route'
import * as last from '../../src/app/api/calls/last-response/route'
import * as purchases from '../../src/app/api/purchases/route'
import * as sellerCalls from '../../src/app/api/seller/calls/route'
import * as earnings from '../../src/app/api/seller/earnings/route'
import * as sellerStatistics from '../../src/app/api/seller/statistics/[wallet]/route'
import * as gatewayBalance from '../../src/app/api/gateway/balance/route'
import { issuePurchaseAccess, PURCHASE_ACCESS_HEADER } from '../../src/lib/marketplace/purchase-access'

const originalFetch = globalThis.fetch
beforeEach(() => {
  reset()
  globalThis.fetch = async () => { state.upstream++; return Response.json({ result: 'ok' }) }
})
after(() => { globalThis.fetch = originalFetch })

const a = alice.address.toLowerCase(), b = bob.address.toLowerCase()
const context = (id: string) => ({ params: Promise.resolve({ id }) })
const createBody = { name: 'API', description: 'Description', category: 'Data', payment_model: 'pay-per-call',
  price_per_call: 0.1, auth_type: 'public', endpoint_url: 'https://seller.example/' }

function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, { method, headers: { origin, ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) })
}
async function authorized(path: string, method = 'GET', body?: unknown, account = alice, signedBody = body,
  options: Parameters<typeof operationHeaders>[4] = {}) {
  return request(path, method, body, await operationHeaders(path, method, signedBody, account, options))
}
function seed(owner = b) {
  const row = { id: 'victim', seller_wallet: owner, name: 'API', description: 'description', category: 'Data',
    endpoint_url: 'https://seller.example/data', auth_type: 'apikey', auth_param_name: null,
    encrypted_key: encryptKey('fixture-key'), method: 'GET', is_active: true, verified_at: new Date().toISOString(),
    price_per_call: 0.1, example_request: '', example_response: '{}' }
  state.tables.api_listings.push(row)
  return row
}

test('create requires a fresh operation-specific wallet signature', async () => {
  assert.equal((await listings.POST(request('/api/apis', 'POST', createBody))).status, 401)
  const response = await listings.POST(await authorized('/api/apis', 'POST', createBody))
  assert.equal(response.status, 201)
  assert.equal(state.tables.api_listings[0].seller_wallet, a)
})

test('create signature is bound to the exact body and signer wallet', async () => {
  assert.equal((await listings.POST(await authorized('/api/apis', 'POST',
    { ...createBody, price_per_call: 50 }, alice, createBody))).status, 401)
  assert.equal((await listings.POST(await authorized('/api/apis', 'POST',
    { ...createBody, seller_wallet: b }, alice))).status, 403)
  assert.equal(state.tables.api_listings.length, 0)
})

test('the same signed authorization cannot be replayed', async () => {
  const headers = await operationHeaders('/api/apis', 'POST', createBody)
  assert.equal((await listings.POST(request('/api/apis', 'POST', createBody, headers))).status, 201)
  assert.equal((await listings.POST(request('/api/apis', 'POST', createBody, headers))).status, 409)
  assert.equal(state.tables.api_listings.length, 1)
})

test('expired authorization and cross-origin mutation fail before data changes', async () => {
  const expired = await authorized('/api/apis', 'POST', createBody, alice, createBody,
    { issuedAt: Math.floor(Date.now() / 1000) - 600 })
  assert.equal((await listings.POST(expired)).status, 401)
  const headers = await operationHeaders('/api/apis', 'POST', createBody)
  headers.origin = 'https://evil.example'
  assert.equal((await listings.POST(request('/api/apis', 'POST', createBody, headers))).status, 403)
  assert.equal(state.tables.api_listings.length, 0)
})

test('wallet B cannot edit or delete wallet A listing', async () => {
  const row = seed(a); const before = structuredClone(row)
  const patch = { seller_wallet: a, name: 'Taken' }
  assert.equal((await listing.PATCH(await authorized('/api/apis/victim', 'PATCH', patch, bob), context('victim'))).status, 403)
  assert.equal((await listing.DELETE(await authorized('/api/apis/victim', 'DELETE', { seller_wallet: a }, bob), context('victim'))).status, 403)
  assert.deepEqual(row, before)
})

test('edit authorization is bound to the exact submitted patch', async () => {
  const row = seed(a)
  const signedPatch = { seller_wallet: a, name: 'Signed name' }
  const sentPatch = { seller_wallet: a, name: 'Different name' }
  const response = await listing.PATCH(
    await authorized('/api/apis/victim', 'PATCH', sentPatch, alice, signedPatch),
    context('victim'),
  )
  assert.equal(response.status, 401)
  assert.equal(row.name, 'API')
})

test('edit, verification and delete each require their own exact authorization', async () => {
  const row = seed(a)
  const patch = { seller_wallet: a, price_per_call: 0.2 }
  assert.equal((await listing.PATCH(await authorized('/api/apis/victim', 'PATCH', patch), context('victim'))).status, 200)
  assert.equal(row.price_per_call, 0.2)
  const verification = await verify.POST(await authorized('/api/apis/victim/verify', 'POST'), context('victim'))
  assert.equal(verification.status, 200)
  assert.equal((await verification.json()).already_verified, true)
  assert.equal((await listing.DELETE(await authorized('/api/apis/victim', 'DELETE', {}), context('victim'))).status, 200)
  assert.equal(state.tables.api_listings.length, 0)
})

test('private buyer, seller, listing and statistics reads require owner proof and reject replay', async () => {
  seed(a)
  state.tables.api_calls.push({ id: 'call-a', api_id: 'victim', buyer_wallet: a, success: true, created_at: '2026-01-01', latency_ms: 10 })
  state.tables.purchases.push({ id: 'purchase-a', api_id: 'victim', buyer_wallet: a, amount_usdc: 1, seller_share_usdc: 0.9 })
  const cases = [
    { path: '/api/calls?buyer_wallet=' + a, run: (req: NextRequest) => calls.GET(req) },
    { path: '/api/seller/calls?seller_wallet=' + a, run: (req: NextRequest) => sellerCalls.GET(req) },
    { path: '/api/apis?seller_wallet=' + a, run: (req: NextRequest) => listings.GET(req) },
    { path: `/api/seller/statistics/${a}`, run: (req: NextRequest) => sellerStatistics.GET(req, { params: Promise.resolve({ wallet: a }) }) },
  ]
  for (const item of cases) {
    assert.equal((await item.run(request(item.path))).status, 401)
    assert.equal((await item.run(await authorized(item.path, 'GET', undefined, bob))).status, 403)
    const headers = await operationHeaders(item.path)
    assert.equal((await item.run(request(item.path, 'GET', undefined, headers))).status, 200)
    assert.equal((await item.run(request(item.path, 'GET', undefined, headers))).status, 409)
  }
})

test('public marketplace excludes inactive seller inventory and credentials', async () => {
  seed(a)
  const catalog = await listings.GET(request('/api/apis'))
  const catalogText = JSON.stringify(await catalog.json())
  assert.doesNotMatch(catalogText, /seller\.example|fixture-key|encrypted_key|endpoint_url|auth_param_name/)
})

test('private listing configuration requires owner proof and never returns encrypted credentials', async () => {
  seed(a)
  assert.equal((await listing.GET(request('/api/apis/victim'), context('victim'))).status, 401)
  assert.equal((await listing.GET(await authorized('/api/apis/victim', 'GET', undefined, bob), context('victim'))).status, 403)
  const response = await listing.GET(await authorized('/api/apis/victim'), context('victim'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.api.endpoint_url, 'https://seller.example/data')
  assert.equal(payload.api.auth_param_name, null)
  assert.equal('encrypted_key' in payload.api, false)
})

test('repository RLS revokes direct public listing-table reads', () => {
  const migration = readFileSync('supabase/migrations/20260926000100_private_listing_configuration.sql', 'utf8')
  assert.match(migration, /DROP POLICY IF EXISTS "public read active listings"/)
  assert.match(migration, /REVOKE SELECT ON public\.api_listings FROM anon, authenticated/)
})

test('sensitive purchase and detailed earnings history use one-use wallet proof', async () => {
  seed(a)
  state.tables.purchases.push({ id: 'purchase-a', api_id: 'victim', buyer_wallet: a, amount_usdc: 1, seller_share_usdc: 0.9 })
  const purchasePath = '/api/purchases?buyer_wallet=' + a
  const earningsPath = '/api/seller/earnings?seller_wallet=' + a
  assert.equal((await purchases.GET(request(purchasePath))).status, 401)
  assert.equal((await earnings.GET(request(earningsPath))).status, 401)
  assert.equal((await purchases.GET(await authorized(purchasePath, 'GET', undefined, bob))).status, 403)
  assert.equal((await earnings.GET(await authorized(earningsPath, 'GET', undefined, bob))).status, 403)
  assert.equal((await purchases.GET(await authorized(purchasePath))).status, 200)
  assert.equal((await earnings.GET(await authorized(earningsPath))).status, 200)
})

test('Gateway balance distinguishes zero from timeout, non-2xx, and invalid JSON', async () => {
  const path = '/api/gateway/balance?wallet=' + a
  assert.equal((await gatewayBalance.GET(request(path))).status, 401)
  assert.equal((await gatewayBalance.GET(await authorized(path, 'GET', undefined, bob))).status, 403)

  globalThis.fetch = async () => Response.json({ balances: [{ balance: '0' }] })
  const headers = await operationHeaders(path)
  const zero = await gatewayBalance.GET(request(path, 'GET', undefined, headers))
  assert.equal(zero.status, 200)
  assert.equal((await zero.json()).gatewayAvailable, '0')
  assert.equal((await gatewayBalance.GET(request(path, 'GET', undefined, headers))).status, 409)

  globalThis.fetch = async () => Response.json({ error: 'bad gateway' }, { status: 502 })
  assert.equal((await gatewayBalance.GET(await authorized(path))).status, 502)
  globalThis.fetch = async () => new Response('{invalid', { status: 200, headers: { 'content-type': 'application/json' } })
  assert.equal((await gatewayBalance.GET(await authorized(path))).status, 502)
  globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError') }
  assert.equal((await gatewayBalance.GET(await authorized(path))).status, 503)
})

test('wallet proof exchanges one exact purchase response for repeat signature-free access', async () => {
  seed(a)
  state.tables.purchases.push({ id: 'purchase-a', api_id: 'victim', buyer_wallet: a })
  state.tables.api_calls.push({ id: 'call-a', api_id: 'victim', buyer_wallet: a, purchase_id: 'purchase-a', success: true,
    response_body: 'private A', response_expires_at: '2099-01-01T00:00:00Z' })
  const path = '/api/calls/last-response?api_id=victim&buyer_wallet=' + a
  assert.equal((await last.GET(request(path))).status, 401)
  const exchange = await last.GET(await authorized(path))
  assert.equal(exchange.status, 200)
  assert.equal(state.tables.withdraw_used_nonces.length, 1)
  const first = await exchange.json() as { response_body: unknown; purchase_access_token: string }
  assert.equal(first.response_body, 'private A')
  assert.ok(first.purchase_access_token)

  const reopened = await last.GET(request(path, 'GET', undefined, {
    [PURCHASE_ACCESS_HEADER]: first.purchase_access_token,
  }))
  assert.equal(reopened.status, 200)
  assert.equal((await reopened.json()).response_body, 'private A')
  assert.equal(state.tables.withdraw_used_nonces.length, 1)
})

test('purchase capabilities return only their exact purchase and never a later purchase or another wallet', async () => {
  seed(a)
  state.tables.purchases.push({ id: 'purchase-a', api_id: 'victim', buyer_wallet: a },
    { id: 'purchase-b', api_id: 'victim', buyer_wallet: a })
  state.tables.api_calls.push(
    { id: 'call-a', api_id: 'victim', buyer_wallet: a, purchase_id: 'purchase-a', success: true,
      response_body: 'private A', response_expires_at: '2099-01-01T00:00:00Z' },
    { id: 'call-b', api_id: 'victim', buyer_wallet: a, purchase_id: 'purchase-b', success: true,
      response_body: 'private B', response_expires_at: '2099-01-01T00:00:00Z' },
  )
  const alicePath = '/api/calls/last-response?api_id=victim&buyer_wallet=' + a
  assert.equal((await last.GET(await authorized(alicePath, 'GET', undefined, bob))).status, 403)
  const path = '/api/calls/last-response?api_id=victim&buyer_wallet=' + b
  const bobAccess = issuePurchaseAccess({ purchaseId: 'purchase-a', apiId: 'victim', buyerWallet: b })
  const response = await last.GET(request(path, 'GET', undefined, { [PURCHASE_ACCESS_HEADER]: bobAccess }))
  assert.equal(response.status, 403)
  assert.notEqual((await response.json()).response_body, 'private A')

  const aliceAccess = issuePurchaseAccess({ purchaseId: 'purchase-a', apiId: 'victim', buyerWallet: a })
  assert.equal((await last.GET(request(path, 'GET', undefined, { [PURCHASE_ACCESS_HEADER]: aliceAccess }))).status, 403)
  const first = await last.GET(request(alicePath, 'GET', undefined, { [PURCHASE_ACCESS_HEADER]: aliceAccess }))
  assert.equal((await first.json()).response_body, 'private A')
  const secondAccess = issuePurchaseAccess({ purchaseId: 'purchase-b', apiId: 'victim', buyerWallet: a })
  const second = await last.GET(request(alicePath, 'GET', undefined, { [PURCHASE_ACCESS_HEADER]: secondAccess }))
  assert.equal((await second.json()).response_body, 'private B')
})

test('purchase read capability cannot authorize a state-changing action', async () => {
  const access = issuePurchaseAccess({ purchaseId: 'purchase-a', apiId: 'victim', buyerWallet: a })
  const response = await listings.POST(request('/api/apis', 'POST', createBody, { [PURCHASE_ACCESS_HEADER]: access }))
  assert.equal(response.status, 401)
  assert.equal(state.tables.api_listings.length, 0)
})

test('SIWE session architecture and login UI are absent', () => {
  for (const path of ['src/components/MarketplaceAuthProvider.tsx', 'src/lib/marketplace/client-session.ts',
    'src/app/api/marketplace/auth/[action]/route.ts']) assert.equal(existsSync(path), false, path)
  const sources = ['src/app/providers.tsx', 'src/components/OnboardingForm.tsx',
    'src/app/dashboard/dashboard-workspace.tsx', 'src/components/AdminAccess.tsx']
    .map(path => readFileSync(path, 'utf8')).join('\n')
  assert.doesNotMatch(sources, /SIWE|Sign in|Verify wallet|24 hours|requireWalletAuth|requestProtected/)
  assert.match(sources, /useWalletAuthorization/)
})
