import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import * as maintenance from '../../src/app/api/admin/maintenance/route'

function request(method: 'GET' | 'POST', account?: typeof alice) {
  return new NextRequest(origin + '/api/admin/maintenance', { method, headers: account ? sessionHeaders(account) : undefined })
}

beforeEach(() => {
  reset(); boundary.actions = 0; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
})

test('Maintenance inventory and manual checks require the existing Admin allowlist', async () => {
  assert.equal((await maintenance.GET(request('GET'))).status, 401)
  assert.equal((await maintenance.GET(request('GET', bob))).status, 403)
  assert.equal((await maintenance.POST(request('POST', bob))).status, 403)
  assert.equal(boundary.external, 0)
})

test('Maintenance route exposes only inventory GET and manual-check POST', () => {
  assert.deepEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].filter(method => method in maintenance), ['GET', 'POST'])
})
