import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { ContactChannels, DashboardContent, InvitationRecord, LiveActivity, confirmedActivityLabel, dashboardStatus } from '../../src/app/admin/worker/dashboard-content'
import { WorkerClient } from '../../src/app/admin/worker/worker-client'
import type { WorkerDashboard } from '../../src/lib/admin-worker/dashboard-types'
import type { WorkerStatusDto } from '../../src/lib/admin-worker/types'
import type { WorkerActivity } from '../../src/lib/admin-worker/dashboard-types'

test('saved forms show manual status, safe read-only links and escaped complete text', () => {
  const html = renderToStaticMarkup(createElement(ContactChannels, { contacts: [
    { id: 'form', type: 'official_contact', value: 'https://fixture.example/contact', purpose: '<Sales>',
      source_url: 'https://fixture.example/', form_state: 'manual_required', verified_at: '2026-10-15' },
    { id: 'bad', type: 'official_contact', value: 'javascript:alert(1)', purpose: 'Contact',
      source_url: 'https://fixture.example/', form_state: null, verified_at: '2026-10-15' },
  ] }))
  assert.match(html, /CAPTCHA \/ manual review required/)
  assert.match(html, /href="https:\/\/fixture.example\/contact"/)
  assert.match(html, /&lt;Sales&gt;/)
  assert.match(html, /do not grant permission to send/)
  assert.doesNotMatch(html, /href="javascript:|<form|type="submit"/)
})
import { CompactRecords } from '../../src/app/admin/worker/compact-records'

test('dashboard renders accurate counters, simulations and actionable provider rows without performing requests', () => {
  const dashboard: WorkerDashboard = { metrics: { found: 10, qualified: 4, prepared: 3, sent: 1, replies: null, inbound_received: 2 },
    activity_next_cursor: null, providers: [{ discovered_at: '2026-10-01', latest_activity_at: '2026-10-15', contact: 'Email ready', id: 'p1', name: '<malicious provider>', domain: 'fixture.example', qualification: 'Qualified', reason: 'No eligible recipient', invitation: 'Prepared · simulated', delivery: 'Simulated · no email sent', has_invitation: true }], recent: [], page: 0, total: 10, as_of: '2026-10-14' }
  const html = renderToStaticMarkup(createElement(DashboardContent, { dashboard, status: null, page: 0, onPage: () => {}, unavailable: false }))
  for (const name of ['APIs Found', 'Qualified APIs', 'Invitations Prepared', 'Invitations Sent', 'Replies Received', 'Provider Activity', 'Live Activity']) assert.ok(html.includes(name))
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

test('current Email ready is separate from timestamped historical No email skip', () => {
  const dashboard: WorkerDashboard = { metrics: { found: 1, qualified: 1, prepared: 1, sent: 0, replies: null, inbound_received: 0 },
    providers: [{ id: 'provider', name: 'Deep Art Effects', domain: 'deeparteffects.com', qualification: 'Qualified', reason: null,
      contact: 'Email ready', historical_skip: { reason: 'No email', at: '2026-10-15T09:13:12Z' },
      invitation: 'Prepared', delivery: 'Not sent', has_invitation: true, discovered_at: null, latest_activity_at: null }],
    recent: [], activity_next_cursor: null, page: 0, total: 1, as_of: '2026-10-15' }
  const html = renderToStaticMarkup(createElement(DashboardContent, { dashboard, status: null, page: 0, onPage: () => {}, unavailable: false }))
  assert.match(html, /Email ready/)
  assert.match(html, /Historical acquisition skip:.*No email/)
  assert.match(html, /Not sent/)
  assert.doesNotMatch(html, /<form|type="submit"/)
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

const savedEvent: WorkerActivity = { id: 'found:p1', provider: 'Saved API', provider_id: 'p1', stage: 'Research', label: '<saved evidence>', at: '2026-10-15T10:00:00Z' }

test('live stage is explicitly last confirmed; Waiting, Stopped and unknown stages are never invented', () => {
  const status = { status: 'running', acquisition: { running: true, waiting: false } } as WorkerStatusDto
  assert.equal(confirmedActivityLabel(status, savedEvent), 'Last confirmed: Research')
  assert.equal(confirmedActivityLabel(status, { ...savedEvent, stage: null }), 'Waiting for update')
  assert.equal(confirmedActivityLabel(status), 'Waiting for update')
  assert.equal(confirmedActivityLabel({ ...status, acquisition: { ...status.acquisition!, waiting: true } }, savedEvent), 'Waiting')
  assert.equal(confirmedActivityLabel({ ...status, status: 'stopped', acquisition: undefined }, savedEvent), 'Stopped')
})

test('live history defaults to three, preserves failure and Stop notices, and offers read-only details', () => {
  const events = Array.from({ length: 8 }, (_, i) => ({ ...savedEvent, id: `event:${i}`, provider: `Saved API ${i}` }))
  const dashboard = { recent: events, activity_next_cursor: { id: events[2].id, at: events[2].at } } as WorkerDashboard
  const status = { status: 'stop_requested', acquisition: { running: true, waiting: false } } as WorkerStatusDto
  const html = renderToStaticMarkup(createElement(LiveActivity, { dashboard, status, unavailable: true, onView: () => {} }))
  assert.match(html, /Live Activity/)
  assert.match(html, /Stop requested/)
  assert.match(html, /Activity refresh failed/)
  assert.match(html, /View All/)
  assert.match(html, /&lt;saved evidence&gt;/)
  assert.equal((html.match(/aria-label="View activity for/g) ?? []).length, 3)
  assert.doesNotMatch(html, /Saved API 3/)
  const failed = renderToStaticMarkup(createElement(LiveActivity, { dashboard: null, status: { status: 'failed', latest_run: { error_code: 'fixture_error' } } as WorkerStatusDto, unavailable: false, onView: () => {} }))
  assert.match(failed, /role="alert">Worker error: fixture_error/)
})

test('compact lists show only the latest three and keep their expansion accessible', () => {
  const html = renderToStaticMarkup(createElement(CompactRecords<number>, {
    records: [1, 2, 3, 4, 5], label: 'Fixture records', children: visible => createElement('ul', null, visible.map(id => createElement('li', { key: id }, `Record ${id}`))),
  }))
  assert.match(html, /Record 3/)
  assert.doesNotMatch(html, /Record 4/)
  assert.match(html, /aria-expanded="false" aria-controls=/)
  assert.match(html, /3 of 5 available records/)
})

test('one provider card replaces recent activity and Live Activity follows the controls', () => {
  const html = renderToStaticMarkup(createElement(WorkerClient))
  assert.equal((html.match(/<h2>Provider Activity<\/h2>/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Recent activity/)
  assert.ok(html.indexOf('Run the Worker') < html.indexOf('<h2>Live Activity</h2>'))
  assert.ok(html.indexOf('<h2>Live Activity</h2>') < html.indexOf('Acquisition results'))
})
