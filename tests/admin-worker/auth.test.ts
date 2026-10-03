import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import * as status from '../../src/app/api/admin/worker/status/route'
import * as runs from '../../src/app/api/admin/worker/runs/route'
import * as leads from '../../src/app/api/admin/worker/leads/route'
import * as start from '../../src/app/api/admin/worker/start/route'
import * as stop from '../../src/app/api/admin/worker/stop/route'
import * as resume from '../../src/app/api/admin/worker/resume/route'

function request(path: string, method: 'GET' | 'POST', account?: typeof alice) {
  return new NextRequest(origin + path, { method, headers: account ? sessionHeaders(account) : undefined })
}

beforeEach(() => {
  reset()
  boundary.actions = 0
  boundary.unavailable = false
  boundary.unavailableTable = null
  boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
})

test('every Worker endpoint enforces the existing wallet-session Admin allowlist', async () => {
  const endpoints = [
    { route: status.GET, path: '/api/admin/worker/status', method: 'GET' as const },
    { route: runs.GET, path: '/api/admin/worker/runs', method: 'GET' as const },
    { route: leads.GET, path: '/api/admin/worker/leads', method: 'GET' as const },
    { route: start.POST, path: '/api/admin/worker/start', method: 'POST' as const },
    { route: stop.POST, path: '/api/admin/worker/stop', method: 'POST' as const },
    { route: resume.POST, path: '/api/admin/worker/resume', method: 'POST' as const },
  ]
  for (const endpoint of endpoints) {
    assert.equal((await endpoint.route(request(endpoint.path, endpoint.method))).status, endpoint.method === 'POST' ? 403 : 401)
    assert.equal((await endpoint.route(request(endpoint.path, endpoint.method, bob))).status, 403)
  }
  assert.equal(boundary.external, 0)
})

test('Worker routes expose only their intended HTTP method', () => {
  for (const route of [status, runs, leads]) {
    assert.equal('GET' in route, true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(method in route, false)
  }
  for (const route of [start, stop, resume]) {
    assert.equal('POST' in route, true)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal(method in route, false)
  }
})
