import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import * as dashboard from '../../src/app/api/admin/outreach/route'
import * as drafts from '../../src/app/api/admin/outreach/drafts/route'
import * as edit from '../../src/app/api/admin/outreach/drafts/[id]/route'
import * as approve from '../../src/app/api/admin/outreach/drafts/[id]/approve/route'
import * as send from '../../src/app/api/admin/outreach/drafts/[id]/send/route'
import * as status from '../../src/app/api/admin/outreach/status/route'
import * as brevoEvents from '../../src/app/api/internal/outreach/brevo-events/route'

function request(path: string, method: 'GET' | 'POST' | 'PATCH', account?: typeof alice) {
  return new NextRequest(origin + path, { method, headers: account ? sessionHeaders(account) : undefined })
}

beforeEach(() => {
  reset(); boundary.actions = 0; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
})

test('every Outreach endpoint uses the existing wallet-session Admin allowlist', async () => {
  const context = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never
  const endpoints = [
    { route: () => dashboard.GET(request('/api/admin/outreach', 'GET')), expected: 401 },
    { route: () => dashboard.GET(request('/api/admin/outreach', 'GET', bob)), expected: 403 },
    { route: () => drafts.POST(request('/api/admin/outreach/drafts', 'POST')), expected: 403 },
    { route: () => drafts.POST(request('/api/admin/outreach/drafts', 'POST', bob)), expected: 403 },
    { route: () => edit.PATCH(request('/api/admin/outreach/drafts/x', 'PATCH'), context), expected: 403 },
    { route: () => approve.POST(request('/api/admin/outreach/drafts/x/approve', 'POST'), context), expected: 403 },
    { route: () => send.POST(request('/api/admin/outreach/drafts/x/send', 'POST'), context), expected: 403 },
    { route: () => status.PATCH(request('/api/admin/outreach/status', 'PATCH')), expected: 403 },
  ]
  for (const endpoint of endpoints) assert.equal((await endpoint.route()).status, endpoint.expected)
  assert.equal(boundary.external, 0)
})

test('Outreach routes expose only intended methods', () => {
  assert.deepEqual(['GET'].filter(method => method in dashboard), ['GET'])
  assert.deepEqual(['POST'].filter(method => method in drafts), ['POST'])
  assert.deepEqual(['PATCH'].filter(method => method in edit), ['PATCH'])
  assert.deepEqual(['POST'].filter(method => method in approve), ['POST'])
  assert.deepEqual(['POST'].filter(method => method in send), ['POST'])
  assert.deepEqual(['PATCH'].filter(method => method in status), ['PATCH'])
  assert.deepEqual(['POST'].filter(method => method in brevoEvents), ['POST'])
})

test('Brevo provider webhook uses dedicated provider authentication rather than an Admin wallet session', async () => {
  const previous = process.env.BREVO_OUTREACH_WEBHOOK_SECRET
  try {
    delete process.env.BREVO_OUTREACH_WEBHOOK_SECRET
    const response = await brevoEvents.POST(new Request(origin + '/api/internal/outreach/brevo-events', { method: 'POST' }))
    assert.equal(response.status, 503)
    assert.equal(boundary.actions, 0)
    assert.equal(boundary.external, 0)
  } finally {
    if (previous === undefined) delete process.env.BREVO_OUTREACH_WEBHOOK_SECRET
    else process.env.BREVO_OUTREACH_WEBHOOK_SECRET = previous
  }
})
