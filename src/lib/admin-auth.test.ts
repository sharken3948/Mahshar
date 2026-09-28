import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, sessionHeaders, reset, state, origin } from '../../tests/marketplace/fixtures'
import { boundary } from '../../tests/admin/fixture'
import * as scan from '../app/api/discovery/scan/route'
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
beforeEach(() => {
  reset(); boundary.actions = 0; boundary.unavailable = false; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
  process.env.DISCOVERY_SELLER_WALLET = other
  delete process.env.MAINNET_MODE
  state.tables.api_listings.push({ id, source: 'discovery', seller_wallet: other, name: 'Fixture',
    description: 'Fixture', category: 'Data', auth_type: 'public', encrypted_key: null,
    verified_at: null, price_per_call: 0.001, is_active: false })
})

test('admin endpoints require an allowlisted wallet session', async () => {
  assert.equal((await scan.GET(unsigned('/api/discovery/scan'))).status, 401)
  assert.equal((await scan.GET(await request('/api/discovery/scan', 'GET', undefined, bob))).status, 403)
  assert.equal(boundary.external, 0)
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

test('admin reads and permitted mutations work with a reusable session', async () => {
  assert.equal((await listings.GET(await request('/api/discovery/listings'))).status, 200)
  const patch = { name: 'New name', price_per_call: 0.002 }
  assert.equal((await edit.PATCH(await request(`/api/discovery/listings/${id}`, 'PATCH', patch), context)).status, 200)
  assert.equal(state.tables.api_listings[0].name, 'New name')
  assert.equal((await edit.DELETE(await request(`/api/discovery/listings/${id}`, 'DELETE'), context)).status, 200)
  assert.equal(state.tables.api_listings.length, 0)
})

test('admin mutation cannot change ownership, credentials, or non-discovery rows', async () => {
  for (const patch of [{ seller_wallet: admin }, { endpoint_url: 'https://evil.example' }, { auth_key: 'secret' }, { verified_at: 'now' }]) {
    assert.equal((await edit.PATCH(await request(`/api/discovery/listings/${id}`, 'PATCH', patch), context)).status, 400)
  }
  state.tables.api_listings[0].source = 'seller'
  assert.equal((await edit.DELETE(await request(`/api/discovery/listings/${id}`, 'DELETE'), context)).status, 404)
})

test('cross-origin admin mutation is denied before the admin action', async () => {
  const body = {}
  const headers = sessionHeaders()
  headers.origin = 'https://evil.example'
  assert.equal((await scan.POST(unsigned('/api/discovery/scan', 'POST', body, headers))).status, 403)
  assert.equal(boundary.external, 0)
})
