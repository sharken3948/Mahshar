import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorker, extractIdentifiers, htmlToPlainText, normalizeParsedEmail, type ForwardableEmailMessage,
  type NormalizedInboundPayload, type WorkerEnv } from './index.js'

const env: WorkerEnv = {
  OUTREACH_FORWARD_TO: 'human-mailbox@example.net',
  OUTREACH_INBOUND_ENDPOINT: 'https://mahshar.xyz/api/internal/outreach/inbound',
  OUTREACH_INBOUND_WEBHOOK_SECRET: 's'.repeat(64),
}

function rawMessage(body: string, headers: string[] = []): string {
  return [
    'From: Provider Person <provider@example.com>',
    'To: support@mahshar.xyz',
    'Subject: Re: Example API on Mahshar',
    'Message-ID: <inbound-123@example.com>',
    'In-Reply-To: <outbound-456@mahshar.xyz>',
    'References: <older@mahshar.xyz> <outbound-456@mahshar.xyz>',
    'Date: Thu, 8 Oct 2026 10:00:00 +0000',
    ...headers,
    '',
    body,
  ].join('\r\n')
}

function message(raw: string, options: { forwardError?: boolean } = {}) {
  const forwarded: string[] = []
  const bytes = new TextEncoder().encode(raw)
  const value: ForwardableEmailMessage = {
    from: 'provider@example.com',
    to: 'support@mahshar.xyz',
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    async forward(recipient) {
      if (options.forwardError) throw new Error('private destination leaked')
      forwarded.push(recipient)
    },
  }
  return { value, forwarded }
}

function harness(response = new Response('{}', { status: 202 })) {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  const logs: Array<{ event: string, details?: Record<string, string | number> }> = []
  const waits: Promise<unknown>[] = []
  const worker = createWorker({
    now: () => new Date('2026-10-08T11:00:00.000Z'),
    fetch: async (input, init) => { requests.push({ url: String(input), init }); return response },
    logger: { error: (event, details) => logs.push({ event, details }) },
  })
  return { worker, requests, logs, waits, context: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } }
}

async function payloadFrom(requests: Array<{ init?: RequestInit }>): Promise<NormalizedInboundPayload> {
  assert.equal(requests.length, 1)
  return JSON.parse(String(requests[0].init?.body)) as NormalizedInboundPayload
}

test('forwards and posts the exact normalized plain-text payload', async () => {
  const input = message(rawMessage('Thanks, we are interested.\r\n\r\nOn Wed, someone wrote:\r\n> Old text'))
  const run = harness()
  await run.worker.email(input.value, env, run.context)
  await Promise.all(run.waits)
  assert.deepEqual(input.forwarded, ['human-mailbox@example.net'])
  assert.equal(run.requests[0].url, 'https://mahshar.xyz/api/internal/outreach/inbound')
  assert.deepEqual(Object.fromEntries(new Headers(run.requests[0].init?.headers).entries()), {
    authorization: `Bearer ${'s'.repeat(64)}`,
    'content-type': 'application/json',
  })
  assert.deepEqual(await payloadFrom(run.requests), {
    message_id: '<inbound-123@example.com>',
    in_reply_to: '<outbound-456@mahshar.xyz>',
    references: ['<older@mahshar.xyz>', '<outbound-456@mahshar.xyz>'],
    sender_email: 'provider@example.com',
    recipient_email: 'support@mahshar.xyz',
    subject: 'Re: Example API on Mahshar',
    text: 'Thanks, we are interested.',
    received_at: '2026-10-08T10:00:00.000Z',
  })
})

test('uses sanitized plain text for an HTML-only message', async () => {
  const html = '<p>Hello &amp; thanks.</p><script>steal()</script><style>.x{}</style>'
    + '<div hidden>tracking text</div><span style="display:none">preview text</span><div>Can we talk?</div>'
  const input = message(rawMessage(html, ['Content-Type: text/html; charset=utf-8']))
  const run = harness()
  await run.worker.email(input.value, env, run.context)
  await Promise.all(run.waits)
  const payload = await payloadFrom(run.requests)
  assert.equal(payload.text, 'Hello & thanks.\n Can we talk?')
  assert.doesNotMatch(payload.text, /script|style|steal|tracking|preview|<[^>]+>/)
})

test('uses the deployed Mahshar email-address validation contract', () => {
  const parsed = {
    messageId: '<inbound-123@example.com>', from: { address: 'bad,alias@example.com', name: '' },
    subject: 'Re: Example API on Mahshar', text: 'Reply body', attachments: [], headers: [], headerLines: [],
  }
  assert.equal(normalizeParsedEmail(parsed, new Date('2026-10-08T11:00:00.000Z')), null)
  assert.equal(htmlToPlainText('<p aria-hidden="true">hidden</p><p>visible</p>').includes('hidden'), false)
})

test('treats nested RFC 822 messages as ignored attachments', async () => {
  const nested = [
    '--outer',
    'Content-Type: text/plain; charset=utf-8', '', 'Visible provider reply', '--outer',
    'Content-Type: message/rfc822', '',
    'From: other@example.com', 'To: support@mahshar.xyz', 'Subject: Attached history', '',
    'HIDDEN ATTACHED MESSAGE', '--outer--', '',
  ].join('\r\n')
  const input = message(rawMessage(nested, ['Content-Type: multipart/mixed; boundary="outer"']))
  const run = harness()
  await run.worker.email(input.value, env, run.context)
  await Promise.all(run.waits)
  assert.equal((await payloadFrom(run.requests)).text, 'Visible provider reply')
})

test('extracts and bounds identifiers', () => {
  const ids = Array.from({ length: 15 }, (_, index) => `<id-${index}@example.com>`).join(' ')
  assert.deepEqual(extractIdentifiers(ids), Array.from({ length: 12 }, (_, index) => `<id-${index}@example.com>`))
  assert.deepEqual(extractIdentifiers('<one@example.com>\r\n <two@example.com>'), ['<one@example.com>', '<two@example.com>'])
})

test('truncates oversized body to the Mahshar limit', async () => {
  const input = message(rawMessage('x'.repeat(7000)))
  const run = harness()
  await run.worker.email(input.value, env, run.context)
  await Promise.all(run.waits)
  assert.equal((await payloadFrom(run.requests)).text.length, 5000)
})

test('malformed messages still forward and are not posted', async () => {
  const malformed = rawMessage('Reply body').replace('Message-ID: <inbound-123@example.com>\r\n', '')
  const input = message(malformed)
  const run = harness()
  await run.worker.email(input.value, env, run.context)
  assert.deepEqual(input.forwarded, ['human-mailbox@example.net'])
  assert.equal(run.requests.length, 0)
  assert.deepEqual(run.logs, [{ event: 'message_not_ingested', details: { code: 'invalid_or_oversized' } }])
})

test('MIME parser failure cannot suppress forwarding', async () => {
  const input = message(rawMessage('Reply body', [`X-Oversized: ${'x'.repeat(70_000)}`]))
  const run = harness()
  await run.worker.email(input.value, env, run.context)
  assert.deepEqual(input.forwarded, ['human-mailbox@example.net'])
  assert.equal(run.requests.length, 0)
  assert.deepEqual(run.logs, [{ event: 'message_not_ingested', details: { code: 'parse_failed' } }])
})

test('webhook failure does not suppress successful forwarding', async () => {
  const input = message(rawMessage('Reply body'))
  const run = harness(new Response('{}', { status: 503 }))
  await run.worker.email(input.value, env, run.context)
  await Promise.all(run.waits)
  assert.deepEqual(input.forwarded, ['human-mailbox@example.net'])
  assert.deepEqual(run.logs, [{ event: 'webhook_failed', details: { status: 503 } }])
})

test('forwards exactly once before starting the webhook', async () => {
  const events: string[] = []
  const input = message(rawMessage('Reply body'))
  input.value.forward = async () => { events.push('forward') }
  const waits: Promise<unknown>[] = []
  const worker = createWorker({
    now: () => new Date('2026-10-08T11:00:00.000Z'),
    fetch: async () => { events.push('webhook'); return new Response('{}', { status: 202 }) },
    logger: { error: () => undefined },
  })
  await worker.email(input.value, env, { waitUntil: promise => waits.push(promise) })
  await Promise.all(waits)
  assert.deepEqual(events, ['forward', 'webhook'])
})

test('duplicate delivery retains the stable provider message ID', async () => {
  const run = harness()
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const input = message(rawMessage('Same reply'))
    await run.worker.email(input.value, env, run.context)
  }
  await Promise.all(run.waits)
  assert.equal(run.requests.length, 2)
  assert.deepEqual(run.requests.map(request => JSON.parse(String(request.init?.body)).message_id),
    ['<inbound-123@example.com>', '<inbound-123@example.com>'])
})

test('logs contain neither the body, secret, nor private destination', async () => {
  const sensitiveBody = 'PRIVATE BODY CONTENT'
  const input = message(rawMessage(sensitiveBody))
  const run = harness(new Response('{}', { status: 500 }))
  await run.worker.email(input.value, env, run.context)
  await Promise.all(run.waits)
  const serialized = JSON.stringify(run.logs)
  assert.doesNotMatch(serialized, /PRIVATE BODY CONTENT/)
  assert.doesNotMatch(serialized, new RegExp('s{32}'))
  assert.doesNotMatch(serialized, /human-mailbox/)
})

test('a missing webhook secret fails closed after forwarding', async () => {
  const input = message(rawMessage('Reply body'))
  const run = harness()
  await run.worker.email(input.value, {
    OUTREACH_FORWARD_TO: env.OUTREACH_FORWARD_TO,
    OUTREACH_INBOUND_ENDPOINT: env.OUTREACH_INBOUND_ENDPOINT,
  }, run.context)
  assert.deepEqual(input.forwarded, ['human-mailbox@example.net'])
  assert.equal(run.requests.length, 0)
  assert.deepEqual(run.logs, [{ event: 'webhook_not_configured', details: undefined }])
})

test('a short webhook secret cannot authorize a post', async () => {
  const input = message(rawMessage('Reply body'))
  const run = harness()
  await run.worker.email(input.value, { ...env, OUTREACH_INBOUND_WEBHOOK_SECRET: 'too-short' }, run.context)
  assert.deepEqual(input.forwarded, ['human-mailbox@example.net'])
  assert.equal(run.requests.length, 0)
  assert.deepEqual(run.logs, [{ event: 'webhook_not_configured', details: undefined }])
})

test('a missing forwarding destination fails clearly without posting', async () => {
  const input = message(rawMessage('Reply body'))
  const run = harness()
  await assert.rejects(run.worker.email(input.value, {
    OUTREACH_INBOUND_ENDPOINT: env.OUTREACH_INBOUND_ENDPOINT,
    OUTREACH_INBOUND_WEBHOOK_SECRET: env.OUTREACH_INBOUND_WEBHOOK_SECRET,
  }, run.context), /forward_destination_not_configured/)
  assert.deepEqual(input.forwarded, [])
  assert.equal(run.requests.length, 0)
})

test('forwarding failure is surfaced and does not start the webhook', async () => {
  const input = message(rawMessage('Reply body'), { forwardError: true })
  const run = harness()
  await assert.rejects(run.worker.email(input.value, env, run.context), /forward_failed/)
  assert.equal(run.requests.length, 0)
  assert.deepEqual(run.logs, [{ event: 'forward_failed', details: undefined }])
})
