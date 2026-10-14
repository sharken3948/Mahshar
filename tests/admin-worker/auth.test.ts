import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import * as status from '../../src/app/api/admin/worker/status/route'
import * as runs from '../../src/app/api/admin/worker/runs/route'
import * as leads from '../../src/app/api/admin/worker/leads/route'
import * as dashboard from '../../src/app/api/admin/worker/dashboard/route'
import * as provider from '../../src/app/api/admin/worker/providers/[id]/route'
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
    { route: dashboard.GET, path: '/api/admin/worker/dashboard', method: 'GET' as const },
    { route: provider.GET, path: '/api/admin/worker/providers/00000000-0000-0000-0000-000000000001', method: 'GET' as const },
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
  for (const route of [status, runs, leads, dashboard, provider]) {
    assert.equal('GET' in route, true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(method in route, false)
  }
  for (const route of [start, stop, resume]) {
    assert.equal('POST' in route, true)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal(method in route, false)
  }
})

test('read-only dashboard validates pagination and provider IDs after authorization', async () => {
  assert.equal((await dashboard.GET(request('/api/admin/worker/dashboard?page=-1', 'GET', alice))).status, 400)
  assert.equal((await provider.GET(request('/api/admin/worker/providers/not-a-uuid', 'GET', alice))).status, 400)
  assert.equal((await provider.GET(request('/api/admin/worker/providers/00000000-0000-0000-0000-000000000001', 'GET', alice))).status, 404)
  boundary.unavailableTable = 'worker_providers'
  const response = await dashboard.GET(request('/api/admin/worker/dashboard', 'GET', alice))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'worker_dashboard_unavailable' })
  assert.equal(boundary.external, 0)
})

test('authorized provider View preserves historical content and cannot mutate or dispatch', async () => {
  const id = '00000000-0000-0000-0000-000000000001'
  state.tables.worker_providers = [{ id, canonical_name: 'Fixture API', canonical_domain: 'fixture.example', status: 'active', worker_leads: [{ qualification_status: 'qualified' }] }]
  state.tables.admin_acquisition_attempts = [{ id: 'a1', provider_id: id, status: 'simulated_sent', subject: 'Exact simulation subject', body: 'Exact simulation body', recipient_email: 'sales@fixture.example' }]
  state.tables.admin_outreach_threads = [{ id: 't1', provider_id: id }]
  state.tables.admin_outreach_messages = [{ id: 'm1', thread_id: 't1', direction: 'outbound', reply_to_message_id: null, status: 'sent', subject: 'Historical subject', body: 'Historical body', recipient_email: 'sales@fixture.example', provider_message_id: 'historical-provider-id', sent_at: '2026-10-08', admin_outreach_delivery_events: [{ event_type: 'delivered', provider_occurred_at: '2026-10-08' }] }]
  const authorizedRequest = request(`/api/admin/worker/providers/${id}`, 'GET', alice)
  const before = JSON.stringify(state.tables)
  const response = await provider.GET(authorizedRequest)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.invitations[0].body, 'Exact simulation body')
  assert.equal(body.invitations[1].body, 'Historical body')
  assert.equal(body.invitations[1].status, 'Delivered')
  assert.equal(JSON.stringify(state.tables), before)
  assert.equal(boundary.external, 0)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('Production acquisition Start requires the explicit mock-only canary gate', async () => {
  const previousMode = process.env.ADMIN_ACQUISITION_MODE
  const previousCanary = process.env.ADMIN_ACQUISITION_CANARY
  const previousVercel = process.env.VERCEL_ENV
  process.env.ADMIN_ACQUISITION_MODE = 'true'
  process.env.ADMIN_ACQUISITION_CANARY = 'false'
  process.env.VERCEL_ENV = 'production'
  try {
    const response = await start.POST(request('/api/admin/worker/start', 'POST', alice))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'acquisition_canary_required' })
    assert.equal(boundary.external, 0)
  } finally {
    if (previousMode === undefined) delete process.env.ADMIN_ACQUISITION_MODE; else process.env.ADMIN_ACQUISITION_MODE = previousMode
    if (previousCanary === undefined) delete process.env.ADMIN_ACQUISITION_CANARY; else process.env.ADMIN_ACQUISITION_CANARY = previousCanary
    if (previousVercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousVercel
  }
})
