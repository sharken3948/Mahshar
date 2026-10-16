import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { GET } from '../../src/app/api/calls/last-response/route'
import { createPaidClient } from '../../src/lib/mcp/paid-client'
import { issuePurchaseAccess, PURCHASE_ACCESS_HEADER } from '../../src/lib/marketplace/purchase-access'
import { alice, bob, reset, sessionHeaders, state } from './fixtures'

const apiId = '11111111-1111-4111-8111-111111111111'
const buyerWallet = alice.address.toLowerCase()
const url = `https://mahshar.xyz/api/calls/last-response?api_id=${apiId}&buyer_wallet=${buyerWallet}`
const capability = issuePurchaseAccess({ purchaseId: 'historical-purchase', apiId, buyerWallet })
const input = { api_id: apiId, buyer_wallet: buyerWallet, purchase_access_token: capability }
const retained = { result: 'complete historical response', nested: [false, 0, ''] }
function request(token = capability, requestUrl = url) {
  return new Request(requestUrl, { headers: { [PURCHASE_ACCESS_HEADER]: token } }) as never
}
function client() {
  return createPaidClient({ origin: 'https://mahshar.xyz', fetcher: async (target, init) => {
    assert.equal(new URL(String(target)).pathname, '/api/calls/last-response')
    assert.equal(init?.method, 'GET')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get(PURCHASE_ACCESS_HEADER), capability)
    assert.equal(headers.has('payment-signature'), false)
    assert.equal(headers.has('cookie'), false)
    return GET(new Request(target, init) as never)
  } })
}
beforeEach(() => {
  reset()
  state.tables.purchases.push({ id: 'historical-purchase', api_id: apiId, buyer_wallet: buyerWallet, created_at: '2025-01-01T00:00:00Z' })
  state.tables.api_calls.push({ api_id: apiId, purchase_id: 'historical-purchase', buyer_wallet: buyerWallet,
    success: true, response_body: retained, response_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString() })
})

test('storage failure is a private 503, not successful empty recovery; recovery-only retry returns the original body', async () => {
  const tables = structuredClone(state.tables)
  state.failApiCallRead = true
  const unavailable = await GET(request())
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.headers.get('cache-control'), 'no-store')
  const body = await unavailable.json()
  assert.equal(body.error, 'response_storage_unavailable')
  assert.match(body.warning, /Do not make another payment/)
  assert.equal(JSON.stringify(body).includes('sensitive storage detail'), false)
  assert.equal('response_body' in body, false)
  assert.equal('retryable' in body, false)
  assert.equal((await client().recover(input)).status, 'request_rejected')
  state.failApiCallRead = false
  const recovered = await client().recover(input)
  assert.equal(recovered.status, 'paid_result')
  assert.deepEqual((recovered as { recovery_result: unknown }).recovery_result, { response_body: retained, purchase_access_token: capability })
  assert.deepEqual(state.tables, tables)
  assert.equal(state.upstream, 0); assert.equal(state.settled, 0)
})

test('missing, expired, pruned and unsuccessful response rows preserve the legacy 200/null contract', async () => {
  const original = structuredClone(state.tables.api_calls[0])
  for (const rows of [[], [{ ...original, response_expires_at: '2020-01-01T00:00:00Z' }],
    [{ ...original, response_body: null }], [{ ...original, success: false }]]) {
    state.tables.api_calls = rows
    const response = await GET(request())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { response_body: null, purchase_access_token: capability })
  }
  assert.equal(state.upstream, 0); assert.equal(state.settled, 0)
})

test('legacy successful JSON values remain unchanged and capability selects its exact purchase', async () => {
  state.tables.purchases.push({ id: 'newer-purchase', api_id: apiId, buyer_wallet: buyerWallet, created_at: '2026-10-16T00:00:00Z' })
  state.tables.api_calls.push({ ...state.tables.api_calls[0], purchase_id: 'newer-purchase', response_body: 'wrong purchase' })
  for (const value of [retained, false, 0, '', [], 'text']) {
    state.tables.api_calls[0].response_body = value
    assert.deepEqual(await (await GET(request())).json(), { response_body: value, purchase_access_token: capability })
  }
})

test('legacy owner-session exchange still works; invalid capabilities never fall back to that session', async () => {
  const headers = sessionHeaders()
  const response = await GET(new NextRequest(url, { headers }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { response_body: retained, purchase_access_token: capability })
  assert.equal((await GET(new NextRequest(url, { headers: { ...headers, [PURCHASE_ACCESS_HEADER]: `${capability}x` } }))).status, 401)
})

test('cross-wallet, cross-API and deleted purchase authorization remain denied even during a response-store outage', async () => {
  state.failApiCallRead = true
  assert.equal((await GET(request(capability, url.replace(buyerWallet, bob.address.toLowerCase())))).status, 403)
  assert.equal((await GET(request(capability, url.replace(apiId, '22222222-2222-4222-8222-222222222222')))).status, 401)
  state.tables.purchases[0].buyer_wallet = bob.address.toLowerCase()
  assert.equal((await GET(request())).status, 403)
  state.tables.purchases = []
  assert.equal((await GET(request())).status, 403)
  assert.equal(state.upstream, 0); assert.equal(state.settled, 0)
})

test('lost delivery followed by concurrent recovery on fresh clients performs only reads', async () => {
  const before = structuredClone(state.tables)
  // The first complete route result is lost at the transport boundary.
  await GET(request())
  const results = await Promise.all(Array.from({ length: 8 }, () => client().recover(input)))
  for (const result of results) {
    assert.equal(result.status, 'paid_result')
    assert.deepEqual((result as { recovery_result: unknown }).recovery_result, { response_body: retained, purchase_access_token: capability })
  }
  assert.deepEqual(state.tables, before)
  assert.equal(state.upstream, 0); assert.equal(state.settled, 0)
})

test('a separate restarted process recovers from persisted fixture rows and the original capability alone', () => {
  const script = `
    globalThis.fetch = async () => { throw Error('Network forbidden') };
    const { state, reset } = require('./tests/marketplace/fixtures.ts');
    reset(); state.tables = JSON.parse(process.env.RECOVERY_FIXTURE_TABLES);
    const { GET } = require('./src/app/api/calls/last-response/route.ts');
    GET(new Request(process.env.RECOVERY_FIXTURE_URL, { headers: { '${PURCHASE_ACCESS_HEADER}': process.env.RECOVERY_FIXTURE_CAPABILITY } }))
      .then(async response => console.log(JSON.stringify({ status: response.status, body: await response.json(), upstream: state.upstream, settled: state.settled })))
      .catch(() => { process.exitCode = 1 });
  `
  const child = spawnSync(process.execPath, ['--import', './tests/marketplace/register.mjs', '--import', 'tsx', '--eval', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, RECOVERY_FIXTURE_TABLES: JSON.stringify(state.tables), RECOVERY_FIXTURE_URL: url, RECOVERY_FIXTURE_CAPABILITY: capability },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { status: 200, body: { response_body: retained, purchase_access_token: capability }, upstream: 0, settled: 0 })
})
