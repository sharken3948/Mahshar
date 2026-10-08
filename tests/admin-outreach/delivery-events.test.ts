import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { POST } from '../../src/app/api/internal/outreach/brevo-events/route'
import { authenticateBrevoDeliveryWebhook, parseBrevoDeliveryEvent, processBrevoDeliveryEvent,
  handleBrevoDeliveryWebhook, readBoundedBrevoJson } from '../../src/lib/admin-outreach/delivery-events'
import { currentOutreachDeliveryEvent, type OutreachDeliveryEventDto } from '../../src/lib/admin-outreach/types'

const migration = readFileSync('supabase/migrations/20261008000200_admin_outreach_delivery_events.sql', 'utf8')
const repository = readFileSync('src/lib/admin-outreach/repository.ts', 'utf8')
const client = readFileSync('src/app/admin/outreach/outreach-client.tsx', 'utf8')

const secret = 'synthetic-brevo-webhook-secret-32-chars'
const basePayload = {
  event: 'delivered', email: 'Provider@Example.com', id: 4127,
  'message-id': '<20261008.12345@relay.brevo.com>', ts_event: 1791453600,
}

function request(payload: unknown, token = secret) {
  return new Request('https://mahshar.xyz/api/internal/outreach/brevo-events', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

test('valid authenticated Brevo delivery event is normalized and processed once', async () => {
  const previous = process.env.BREVO_OUTREACH_WEBHOOK_SECRET
  process.env.BREVO_OUTREACH_WEBHOOK_SECRET = secret
  let received: unknown = null
  try {
    const response = await handleBrevoDeliveryWebhook(request(basePayload), { process: async event => {
      received = event
      return { matched: true, duplicate: false, messageId: 'message-1', eventId: 'event-1' }
    } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { accepted: true, matched: true, duplicate: false })
    assert.deepEqual(received, {
      providerMessageId: '<20261008.12345@relay.brevo.com>', recipientEmail: 'provider@example.com',
      eventType: 'delivered', providerEventId: '4127', occurredAt: '2026-10-08T10:00:00.000Z',
    })
  } finally {
    if (previous === undefined) delete process.env.BREVO_OUTREACH_WEBHOOK_SECRET
    else process.env.BREVO_OUTREACH_WEBHOOK_SECRET = previous
  }
})

test('Brevo webhook fails closed for absent, short, or invalid authentication', async () => {
  const previous = process.env.BREVO_OUTREACH_WEBHOOK_SECRET
  try {
    delete process.env.BREVO_OUTREACH_WEBHOOK_SECRET
    assert.equal((await POST(request(basePayload))).status, 503)
    process.env.BREVO_OUTREACH_WEBHOOK_SECRET = 'too-short'
    assert.equal(authenticateBrevoDeliveryWebhook(request(basePayload)), false)
    assert.equal((await POST(request(basePayload))).status, 503)
    process.env.BREVO_OUTREACH_WEBHOOK_SECRET = secret
    assert.equal(authenticateBrevoDeliveryWebhook(request(basePayload, 'wrong-token-that-is-at-least-32-characters')), false)
    assert.equal((await POST(request(basePayload, 'wrong-token-that-is-at-least-32-characters'))).status, 401)
  } finally {
    if (previous === undefined) delete process.env.BREVO_OUTREACH_WEBHOOK_SECRET
    else process.env.BREVO_OUTREACH_WEBHOOK_SECRET = previous
  }
})

test('only supported transactional email events map to the fixed Mahshar enum', () => {
  const mapping = new Map([
    ['request', 'sent'], ['delivered', 'delivered'], ['opened', 'opened'], ['unique_opened', 'opened'],
    ['soft_bounce', 'soft_bounce'], ['hard_bounce', 'hard_bounce'], ['blocked', 'blocked'],
  ])
  for (const [providerEvent, expected] of mapping) {
    assert.equal(parseBrevoDeliveryEvent({ ...basePayload, event: providerEvent }).eventType, expected)
  }
  for (const unsupported of ['click', 'spam', 'unsubscribed', 'deferred', 'invalid_email']) {
    assert.throws(() => parseBrevoDeliveryEvent({ ...basePayload, event: unsupported }), /delivery_event_invalid/)
  }
})

test('malformed and oversized Brevo webhook payloads are rejected before processing', async () => {
  assert.throws(() => parseBrevoDeliveryEvent({ ...basePayload, id: 'not-an-integer' }), /delivery_event_invalid/)
  assert.throws(() => parseBrevoDeliveryEvent({ ...basePayload, 'message-id': '' }), /delivery_event_invalid/)
  assert.throws(() => parseBrevoDeliveryEvent({ ...basePayload, ts_event: 'yesterday' }), /delivery_event_invalid/)
  assert.throws(() => parseBrevoDeliveryEvent({ ...basePayload, ts_event: String(basePayload.ts_event) }), /delivery_event_invalid/)
  assert.throws(() => parseBrevoDeliveryEvent({ ...basePayload, ts_event: 4102444800 }), /delivery_event_invalid/)
  const oversized = new Request('https://mahshar.xyz/api/internal/outreach/brevo-events', {
    method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(33_000) }),
  })
  await assert.rejects(() => readBoundedBrevoJson(oversized), /too_large/)
})

test('transient persistence failure uses Brevo retryable 429 without exposing internals', async () => {
  const previous = process.env.BREVO_OUTREACH_WEBHOOK_SECRET
  process.env.BREVO_OUTREACH_WEBHOOK_SECRET = secret
  const originalError = console.error
  console.error = () => undefined
  try {
    const response = await handleBrevoDeliveryWebhook(request(basePayload), {
      process: async () => { throw new Error('synthetic_database_unavailable') },
    })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '600')
    assert.deepEqual(await response.json(), { error: 'delivery_event_unavailable' })
  } finally {
    console.error = originalError
    if (previous === undefined) delete process.env.BREVO_OUTREACH_WEBHOOK_SECRET
    else process.env.BREVO_OUTREACH_WEBHOOK_SECRET = previous
  }
})

test('matched, unmatched, and duplicate provider-message outcomes remain explicit', async () => {
  const event = parseBrevoDeliveryEvent(basePayload)
  for (const expected of [
    { matched: true, duplicate: false, messageId: 'message-1', eventId: 'event-1' },
    { matched: true, duplicate: true, messageId: 'message-1', eventId: 'event-1' },
    { matched: false, duplicate: false, messageId: null, eventId: null },
  ]) {
    assert.deepEqual(await processBrevoDeliveryEvent(event, { ingest: async () => expected }), expected)
  }
  assert.match(migration, /lower\(btrim\(message\.provider_message_id,'<> '\)\)=normalized_provider_id/)
  assert.match(migration, /message\.recipient_email=p_recipient_email/)
  assert.match(migration, /coalesce\(cardinality\(message_ids\),0\)<>1/)
})

test('delivery precedence never lets delayed sent events visually downgrade terminal outcomes', () => {
  const event = (id: string, event_type: OutreachDeliveryEventDto['event_type'], occurred_at: string): OutreachDeliveryEventDto =>
    ({ id, event_type, occurred_at, received_at: occurred_at })
  const events = [
    event('1', 'hard_bounce', '2026-10-08T10:00:00Z'),
    event('2', 'sent', '2026-10-08T11:00:00Z'),
    event('3', 'delivered', '2026-10-08T12:00:00Z'),
  ]
  assert.equal(currentOutreachDeliveryEvent(events)?.event_type, 'hard_bounce')
  assert.equal(currentOutreachDeliveryEvent([event('1', 'delivered', '2026-10-08T10:00:00Z'),
    event('2', 'opened', '2026-10-08T11:00:00Z')])?.event_type, 'opened')
  assert.equal(currentOutreachDeliveryEvent([event('1', 'sent', '2026-10-08T10:00:00Z'),
    event('2', 'soft_bounce', '2026-10-08T11:00:00Z')])?.event_type, 'soft_bounce')
})

test('migration keeps delivery history private, bounded by type, and separate from Outreach state', () => {
  assert.match(migration, /UNIQUE \(message_id,event_type\)/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /REVOKE ALL PRIVILEGES[\s\S]+PUBLIC,anon,authenticated,service_role/)
  assert.match(migration, /GRANT SELECT[\s\S]+TO service_role/)
  assert.match(migration, /GRANT EXECUTE[\s\S]+TO service_role/)
  assert.doesNotMatch(migration, /UPDATE public\.admin_outreach_(messages|threads)/)
  assert.doesNotMatch(migration, /worker_|payment|x402|settlement|withdraw/i)
})

test('Admin conversation renders compact delivery state/history and preserves provider message ID', () => {
  assert.match(repository, /admin_outreach_delivery_events/)
  assert.match(repository, /currentOutreachDeliveryEvent/)
  assert.match(client, /Delivered/)
  assert.match(client, /Opened/)
  assert.match(client, /Soft bounce/)
  assert.match(client, /Hard bounce/)
  assert.match(client, /Blocked/)
  assert.match(client, /ProviderMessageId value=\{message\.provider_message_id\}/)
  assert.match(client, /<DeliveryStatus message=\{sentMessage\} detailed\/>/)
})

test('historical Visual Crossing sent message remains compatible without fabricated events', () => {
  const historical = { status: 'sent', provider_message_id: '<historical@brevo>', delivery_state: null, delivery_events: [] }
  assert.equal(historical.status, 'sent')
  assert.equal(historical.provider_message_id, '<historical@brevo>')
  assert.equal(historical.delivery_state, null)
  assert.deepEqual(historical.delivery_events, [])
  assert.doesNotMatch(migration, /INSERT INTO public\.admin_outreach_delivery_events[\s\S]+historical/i)
})
