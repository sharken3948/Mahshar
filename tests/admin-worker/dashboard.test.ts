import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { acquisitionInvitation, outreachInvitation, providerActivity, parseDashboardPage, getWorkerDashboard, getWorkerProviderDetail } from '../../src/lib/admin-worker/dashboard-repository'

const provider = { id: 'p1', canonical_name: 'Weather API', canonical_domain: 'weather.example', status: 'active', created_at: '2026-10-01T00:00:00Z', worker_leads: [{ id: 'l1', qualification_status: 'qualified' }, { id: 'l2', qualification_status: 'qualified' }] }
const attempt = { id: 'a1', provider_id: 'p1', status: 'simulated_sent', subject: 'Exact saved subject', body: '<script>malicious</script>\nExact saved body', recipient_email: 'team@weather.example', dispatched_at: '2026-10-14T10:00:00Z', updated_at: '2026-10-14T10:00:00Z' }
const sent = { id: 'm1', status: 'sent', subject: 'Historical subject', body: 'Historical body', recipient_email: 'team@weather.example', provider_message_id: 'real-provider-id', sent_at: '2026-10-08T00:54:00Z', created_at: '2026-10-07T20:00:00Z', admin_outreach_delivery_events: [{ event_type: 'delivered', provider_occurred_at: '2026-10-08T00:54:01Z' }, { event_type: 'opened', provider_occurred_at: '2026-10-09T00:00:00Z' }] }

test('simulated and uncertain attempts remain distinct from real historical invitations', () => {
  const draft = acquisitionInvitation(attempt)!
  assert.equal(draft.status, 'Simulated')
  assert.equal(draft.prepared_at, null)
  assert.equal(draft.generator, null)
  const generated = acquisitionInvitation({ ...attempt, draft_generator: 'groq', draft_prepared_at: '2026-10-14T09:59:00Z' })!
  assert.equal(generated.generator, 'groq')
  assert.equal(generated.prepared_at, '2026-10-14T09:59:00Z')
  assert.equal(generated.status, 'Simulated', 'Groq preparation and mock delivery are separate facts')
  assert.equal(draft.body, attempt.body)
  assert.match(draft.delivery, /no email sent/)
  assert.equal(providerActivity(provider, attempt).invitation, 'Prepared · simulated')
  assert.match(acquisitionInvitation({ ...attempt, status: 'uncertain' })!.delivery, /do not resend/)
  assert.equal(acquisitionInvitation({ ...attempt, body: null }), null)
  const history = outreachInvitation(sent)
  assert.equal(history.status, 'Delivered')
  assert.equal(history.subject, sent.subject)
  assert.equal(history.body, sent.body)
  assert.match(history.events[1].label, /engagement unverified/)
  assert.equal(outreachInvitation({ ...sent, admin_outreach_delivery_events: [{ event_type: 'opened' }] }).delivery, 'Accepted · delivery unconfirmed')
  assert.equal(outreachInvitation({ ...sent, provider_message_id: '<SIMULATED:fake>' }).sent_at, null)
  assert.equal(outreachInvitation({ ...sent, provider_message_id: '<SIMULATED:fake>' }).status, 'Simulated')
  assert.equal(outreachInvitation({ ...sent, provider_message_id: null }).status, 'Unconfirmed')
  assert.equal(outreachInvitation({ ...sent, provider_message_id: null }).delivery, 'Delivery unconfirmed')
  assert.equal(providerActivity(provider, undefined, [{ ...sent, provider_message_id: 'simulated:fake' }]).invitation, 'Simulated')
  assert.equal(outreachInvitation({ ...sent, status: 'ready_to_send', sent_at: null, send_uncertain_at: '2026-10-14' }).delivery, 'Uncertain · do not resend')
})

test('provider summary preserves rejection, no-contact and eligibility outcomes', () => {
  assert.equal(providerActivity(provider).qualification, 'Qualified')
  assert.equal(providerActivity({ ...provider, worker_leads: [{ qualification_status: 'review_candidate' }] }).qualification, 'Review required')
  assert.equal(providerActivity({ ...provider, worker_leads: [{ qualification_status: 'rejected', fit_reason: 'No API evidence' }] }).reason, 'No API evidence')
  assert.equal(providerActivity(provider, { ...attempt, body: null, reason_code: 'no_verified_contact' }).reason, 'No verified contact')
  assert.equal(providerActivity({ ...provider, status: 'do_not_contact' }, attempt).reason, 'Do Not Contact')
  assert.equal(providerActivity(provider, { ...attempt, body: null, reason_code: 'recipient_ineligible' }).has_invitation, false)
})

test('read pagination rejects unbounded and malformed inputs', () => {
  for (const value of ['-1', '1.5', '100000', '1e3', ' 1', '01']) assert.equal(parseDashboardPage(new URL(`https://fixture/?page=${value}`)), null)
  assert.equal(parseDashboardPage(new URL('https://fixture/?page=2')), 2)
})

function offlineClient(fail = false, preparedCount = 1) {
  const queries: URL[] = []
  const client = createClient('https://fixture.supabase.co', 'fixture-only', {
    realtime: { transport: class ForbiddenRealtime { constructor() { throw new Error('Realtime forbidden in offline tests') } } as unknown as typeof WebSocket },
    global: { fetch: async (input, init) => {
    const url = new URL(String(input)); queries.push(url)
    assert.ok(['GET', 'HEAD'].includes(init?.method ?? 'GET'), 'read-only query contract')
    if (fail) return new Response(JSON.stringify({ message: 'private DB error', code: 'XX000' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    const table = url.pathname.split('/').pop()
    const select = url.searchParams.get('select') ?? ''
    let data: unknown[] = []
    let total = 0
    if (table === 'worker_providers') {
      data = [{ ...provider, updated_at: '2026-10-14', created_at: '2026-10-01' }]; total = 1
      if (url.searchParams.has('worker_leads.qualification_status')) {
        assert.match(select, /worker_leads!inner/)
        assert.equal(url.searchParams.get('worker_leads.qualification_status'), 'eq.qualified')
      }
    }
    if (table === 'admin_acquisition_attempts') {
      data = [attempt]
      if (init?.method === 'HEAD') {
        assert.equal(url.searchParams.get('draft_generator'), 'eq.groq')
        for (const field of ['draft_prepared_at', 'subject', 'body']) assert.equal(url.searchParams.get(field), 'not.is.null')
        total = preparedCount
      }
    }
    if (table === 'admin_outreach_threads') data = [{ id: 't1', provider_id: 'p1', admin_outreach_messages: [sent] }]
    if (table === 'admin_outreach_messages') {
      if (init?.method === 'HEAD') {
        if (url.searchParams.get('direction') === 'eq.outbound') {
          assert.equal(url.searchParams.get('reply_to_message_id'), 'is.null')
          assert.ok(url.searchParams.getAll('provider_message_id').includes('not.imatch.^[[:space:]]*<?simulated:')) // Multiple filters survive serialization.
          assert.ok(url.searchParams.getAll('provider_message_id').includes('not.is.null'))
          assert.ok(url.searchParams.getAll('provider_message_id').includes('not.match.^[[:space:]]*$'))
          assert.equal(url.searchParams.get('sent_at'), 'not.is.null')
          total = 1
        } else total = 2
      } else if (url.searchParams.has('thread_id')) data = [sent]
    }
    return new Response(init?.method === 'HEAD' ? null : JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(total - 1, 0)}/${total}` } })
  } } })
  return { client, queries }
}

test('dashboard uses exact parent counts and explicit Groq provenance, and keeps trusted replies unavailable', async () => {
  const { client, queries } = offlineClient()
  const result = await getWorkerDashboard(0, client)
  assert.equal(result.metrics.found, 1)
  assert.equal(result.metrics.qualified, 1, 'one provider, two qualified products')
  assert.equal(result.metrics.sent, 1)
  assert.equal(result.metrics.prepared, 1)
  assert.equal((await getWorkerDashboard(0, offlineClient(false, 0).client)).metrics.prepared, 0, 'unmarked historical/mock drafts are excluded, not inferred from their text')
  assert.equal(result.metrics.replies, null)
  assert.equal(result.metrics.inbound_received, 2)
  assert.equal(result.providers[0].delivery, 'Delivered')
  assert.ok(queries.length > 0)
  assert.ok(!JSON.stringify(result).includes(attempt.body), 'no full draft body in summary')
})

test('detail returns exact stored initial messages and simulation with no mutation or inference', async () => {
  const { client, queries } = offlineClient()
  const result = await getWorkerProviderDetail('p1', 0, client)
  assert.equal(result!.invitations[0].body, attempt.body)
  assert.equal(result!.invitations[1].body, sent.body)
  assert.equal(result!.invitations[1].status, 'Delivered')
  assert.ok(queries.filter(url => url.pathname.endsWith('admin_outreach_messages') && url.searchParams.has('thread_id')).every(url => url.searchParams.get('reply_to_message_id') === 'is.null'))
  assert.ok(!JSON.stringify(result).includes('real-provider-id'), 'transport identifier not exposed')
  await assert.rejects(getWorkerDashboard(0, offlineClient(true).client), /worker_dashboard/)
})
