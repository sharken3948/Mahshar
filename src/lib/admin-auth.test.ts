import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, sessionHeaders, reset, state, origin } from '../../tests/marketplace/fixtures'
import { boundary } from '../../tests/admin/fixture'
import * as crawl from '../app/api/discovery/crawl/route'
import * as scan from '../app/api/discovery/scan/route'
import * as outreach from '../app/api/discovery/outreach/route'
import * as activate from '../app/api/discovery/activate/route'
import * as retest from '../app/api/discovery/retest/route'
import * as listings from '../app/api/discovery/listings/route'
import * as edit from '../app/api/discovery/listings/[id]/route'

const admin = alice.address.toLowerCase(), other = bob.address.toLowerCase()
const id = 'fixture-listing'
const context = { params: Promise.resolve({ id }) }
function unsigned(path: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}) {
  return new NextRequest(origin + path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) })
}
async function request(path: string, method = 'GET', body?: unknown, account = alice) {
  return unsigned(path, method, body, sessionHeaders(account))
}
const legacyMutations = [
  { path: '/api/discovery/crawl', method: 'POST', invoke: (req: NextRequest) => crawl.POST(req) },
  { path: '/api/discovery/scan', method: 'POST', invoke: (req: NextRequest) => scan.POST(req) },
  { path: '/api/discovery/outreach', method: 'POST', invoke: (req: NextRequest) => outreach.POST(req) },
  { path: '/api/discovery/activate', method: 'POST', invoke: (req: NextRequest) => activate.POST(req) },
  { path: '/api/discovery/retest', method: 'POST', invoke: (req: NextRequest) => retest.POST(req) },
  { path: `/api/discovery/listings/${id}`, method: 'PATCH', invoke: (req: NextRequest) => edit.PATCH(req, context) },
  { path: `/api/discovery/listings/${id}`, method: 'DELETE', invoke: (req: NextRequest) => edit.DELETE(req, context) },
]
beforeEach(() => {
  reset(); boundary.actions = 0; boundary.unavailable = false; boundary.unavailableTable = null; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
  process.env.DISCOVERY_SELLER_WALLET = other
  delete process.env.MAINNET_MODE
  state.tables.api_listings.push({ id, source: 'discovery', seller_wallet: other, name: 'Fixture',
    description: 'Fixture', category: 'Data', auth_type: 'public', encrypted_key: null,
    verified_at: null, price_per_call: 0.001, is_active: false })
})

test('retired legacy mutations preserve the existing 401 and 403 authorization boundary', async () => {
  for (const mutation of legacyMutations) {
    assert.equal((await mutation.invoke(unsigned(mutation.path, mutation.method, {}, { origin }))).status, 401)
    assert.equal((await mutation.invoke(await request(mutation.path, mutation.method, {}, bob))).status, 403)
  }
  assert.equal(boundary.external, 0)
  assert.equal(boundary.actions, legacyMutations.length) // one wallet-session read per non-Admin request
})

test('admin allowlist is checked on every session request', async () => {
  assert.equal((await scan.GET(await request('/api/discovery/scan'))).status, 200)
  process.env.ADMIN_WALLETS = other
  assert.equal((await scan.GET(await request('/api/discovery/scan'))).status, 403)
})

test('missing or malformed admin configuration fails closed', async () => {
  for (const value of [undefined, '', ' ', 'invalid', `${admin},`, `${admin},0x${'0'.repeat(40)}`]) {
    if (value === undefined) delete process.env.ADMIN_WALLETS; else process.env.ADMIN_WALLETS = value
    assert.equal((await scan.GET(await request('/api/discovery/scan'))).status, 503)
  }
})

test('legacy discovery GET handlers remain available to an Admin session', async () => {
  assert.equal((await crawl.GET(await request('/api/discovery/crawl'))).status, 200)
  assert.equal((await scan.GET(await request('/api/discovery/scan'))).status, 200)
  assert.equal((await listings.GET(await request('/api/discovery/listings'))).status, 200)
  assert.equal((await activate.GET(await request('/api/discovery/activate'))).status, 200)
  assert.equal((await retest.GET(await request('/api/discovery/retest'))).status, 200)
})

test('authorized legacy mutations return fixed no-store 410 responses with no privileged side effects', async () => {
  const before = JSON.stringify(state.tables.api_listings)
  boundary.actions = 0
  boundary.external = 0
  for (const mutation of legacyMutations) {
    const response = await mutation.invoke(await request(mutation.path, mutation.method, { name: 'Ignored' }))
    assert.equal(response.status, 410)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: 'legacy_discovery_disabled' })
  }
  assert.equal(boundary.actions, legacyMutations.length) // authorization only; handlers never access storage
  assert.equal(boundary.external, 0)
  assert.equal(JSON.stringify(state.tables.api_listings), before)
})

test('cross-origin admin mutation is denied before the admin action', async () => {
  const body = {}
  const headers = sessionHeaders()
  headers.origin = 'https://evil.example'
  assert.equal((await scan.POST(unsigned('/api/discovery/scan', 'POST', body, headers))).status, 403)
  assert.equal(boundary.external, 0)
})
