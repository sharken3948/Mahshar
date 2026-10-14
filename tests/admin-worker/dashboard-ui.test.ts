import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { DashboardContent, InvitationRecord, dashboardStatus } from '../../src/app/admin/worker/dashboard-content'
import { WorkerClient } from '../../src/app/admin/worker/worker-client'
import type { WorkerDashboard } from '../../src/lib/admin-worker/dashboard-types'
import type { WorkerStatusDto } from '../../src/lib/admin-worker/types'

test('dashboard renders accurate counters, simulations and actionable provider rows without performing requests', () => {
  const dashboard: WorkerDashboard = { metrics: { found: 10, qualified: 4, prepared: 3, sent: 1, replies: null, inbound_received: 2 },
    providers: [{ id: 'p1', name: '<malicious provider>', domain: 'fixture.example', qualification: 'Qualified', reason: 'No eligible recipient', invitation: 'Prepared · simulated', delivery: 'Simulated · no email sent', has_invitation: true }], recent: [], page: 0, total: 10, as_of: '2026-10-14' }
  const html = renderToStaticMarkup(createElement(DashboardContent, { dashboard, status: null, page: 0, onPage: () => {}, unavailable: false }))
  for (const name of ['APIs Found', 'Qualified APIs', 'Invitations Prepared', 'Invitations Sent', 'Replies Received', 'Provider activity', 'Recent activity']) assert.ok(html.includes(name))
  assert.match(html, /Recorded Groq invitations/)
  assert.match(html, /excludes mock and unknown-origin drafts/)
  assert.match(html, /2 inbound messages/)
  assert.match(html, /no email sent/)
  assert.match(html, /No eligible recipient/)
  assert.match(html, /&lt;malicious provider&gt;/)
  assert.doesNotMatch(html, /<malicious provider>/)
  assert.match(html, /aria-label="View/)
})

test('saved invitation view escapes full exact historical content and distinguishes reservation, sent and delivery times', () => {
  const html = renderToStaticMarkup(createElement(InvitationRecord, { invitation: { id: 'm', source: 'outreach', generator: null, recipient: 'sales@fixture.example', subject: 'Saved <subject>', body: '<script>alert(1)</script>\nHistorical message', status: 'Delivered', prepared_at: '2026-10-07', reserved_at: null, sent_at: '2026-10-08', delivery: 'Delivered', events: [{ label: 'Opened / proxy event · engagement unverified', at: '2026-10-09' }] } }))
  assert.match(html, /Saved &lt;subject&gt;/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /Historical message/)
  assert.match(html, /engagement unverified/)
  assert.match(html, /Unknown · origin not recorded/)
  assert.doesNotMatch(html, /<script>|Approve|Send invitation/)
})

test('invitation details display recorded Groq checkpoint separately from simulated dispatch', () => {
  const html = renderToStaticMarkup(createElement(InvitationRecord, { invitation: { id: 'a', source: 'acquisition', generator: 'groq', recipient: 'sales@fixture.example', subject: 'Saved subject', body: 'Saved body', status: 'Simulated', prepared_at: '2026-10-15T01:00:00Z', reserved_at: null, sent_at: '2026-10-15T01:01:00Z', delivery: 'Simulated · no email sent', events: [] } }))
  assert.match(html, /Groq · recorded provenance/)
  assert.match(html, /draft checkpoint/)
  assert.match(html, /Simulated dispatch/)
  assert.doesNotMatch(html, /preparation time unavailable/)
})

test('legacy diagnostics stay collapsed, initial controls are disabled and Resume is conditional', () => {
  const html = renderToStaticMarkup(createElement(WorkerClient))
  assert.match(html, /Technical Details/)
  assert.match(html, /<details class="technical">/)
  assert.doesNotMatch(html, /<details[^>]* open/)
  assert.match(html, /disabled="">Start/)
  assert.match(html, /disabled="">Stop/)
  assert.doesNotMatch(html, />Resume</)
  assert.match(html, /Recent runs/)
  assert.match(html, /Contact-ready Discovery leads/)
})

test('status distinguishes durable wait, running intent, errors and stopped state', () => {
  const status = { status: 'stopped', acquisition: { running: true, waiting: true } } as WorkerStatusDto
  assert.equal(dashboardStatus(status), 'Waiting')
  assert.equal(dashboardStatus({ ...status, acquisition: { ...status.acquisition!, waiting: false } }), 'Running')
  assert.equal(dashboardStatus({ ...status, acquisition: undefined, status: 'failed' }), 'Error')
  assert.equal(dashboardStatus({ ...status, acquisition: undefined }), 'Stopped')
  assert.equal(dashboardStatus(null), 'Unavailable')
})
