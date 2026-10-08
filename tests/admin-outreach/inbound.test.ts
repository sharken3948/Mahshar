import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { POST } from '../../src/app/api/internal/outreach/inbound/route'
import { classifyOutreachReply, deterministicDncClassification, suggestOutreachReply,
  validateReplyClassification, validateSuggestedReply } from '../../src/lib/admin-outreach/intelligence'
import { authenticateInboundBridge, parseNormalizedInboundReply, processInboundReply,
  readBoundedInboundJson, type NormalizedInboundReply } from '../../src/lib/admin-outreach/inbound'

const migration = readFileSync('supabase/migrations/20261008000100_admin_outreach_v2_inbound.sql', 'utf8')
const approvalRoute = readFileSync('src/app/api/admin/outreach/drafts/[id]/approve/route.ts', 'utf8')
const transport = readFileSync('src/lib/admin-outreach/transport.ts', 'utf8')

const payload = {
  message_id: '<reply-1@example.com>', in_reply_to: '<outbound-1@brevo>', references: ['<outbound-1@brevo>'],
  sender_email: 'Provider@Example.com', recipient_email: 'support@mahshar.xyz', subject: 'Re: Weather API on Mahshar',
  text: 'Thanks.\r\n\u0000Could you explain the technical setup?', received_at: '2026-10-08T10:00:00Z',
}
const reply = parseNormalizedInboundReply(payload)

test('normalized mailbox bridge payload is bounded, sanitized, and exact-recipient only', async () => {
  assert.deepEqual(reply, {
    providerMessageId: '<reply-1@example.com>', inReplyTo: '<outbound-1@brevo>', references: ['<outbound-1@brevo>'],
    senderEmail: 'provider@example.com', recipientEmail: 'support@mahshar.xyz',
    subject: 'Re: Weather API on Mahshar', body: 'Thanks.\nCould you explain the technical setup?',
    receivedAt: '2026-10-08T10:00:00.000Z',
  })
  assert.throws(() => parseNormalizedInboundReply({ ...payload, recipient_email: 'other@mahshar.xyz' }), /inbound_invalid/)
  const oversized = new Request('https://mahshar.xyz/api/internal/outreach/inbound', {
    method: 'POST', body: JSON.stringify({ text: 'x'.repeat(70_000) }),
  })
  await assert.rejects(() => readBoundedInboundJson(oversized), /too_large/)
})

test('mailbox bridge requires the configured bearer secret and rejects injection', async () => {
  const previous = process.env.OUTREACH_INBOUND_WEBHOOK_SECRET
  process.env.OUTREACH_INBOUND_WEBHOOK_SECRET = 'synthetic-inbound-secret-32-chars'
  try {
    assert.equal(authenticateInboundBridge(new Request('https://mahshar.xyz', { headers: { authorization: 'Bearer wrong' } })), false)
    assert.equal(authenticateInboundBridge(new Request('https://mahshar.xyz', { headers: { authorization: 'Bearer synthetic-inbound-secret-32-chars' } })), true)
    const response = await POST(new Request('https://mahshar.xyz/api/internal/outreach/inbound', {
      method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }))
    assert.equal(response.status, 401)
  } finally {
    if (previous === undefined) delete process.env.OUTREACH_INBOUND_WEBHOOK_SECRET
    else process.env.OUTREACH_INBOUND_WEBHOOK_SECRET = previous
  }
})

test('explicit DNC language has deterministic precedence without a Groq call', async () => {
  const body = 'Please unsubscribe me and do not contact us again.'
  assert.equal(deterministicDncClassification(body)?.classification, 'do_not_contact')
  const result = await classifyOutreachReply(body, async () => { throw new Error('Groq must not be called') })
  assert.deepEqual(result, { classification: 'do_not_contact', confidence: 1,
    reason: 'The reply contains an explicit request to stop contact.' })
  assert.equal(deterministicDncClassification('STOP')?.classification, 'do_not_contact')
  assert.equal(deterministicDncClassification('Please send no more emails.')?.classification, 'do_not_contact')
})

test('Groq classification accepts only the fixed schema and fails safely to other', async () => {
  assert.deepEqual(validateReplyClassification({ classification: 'technical_question', confidence: 0.8, reason: 'Asks about setup.' }),
    { classification: 'technical_question', confidence: 0.8, reason: 'Asks about setup.' })
  assert.throws(() => validateReplyClassification({ classification: 'invented_status', confidence: 1, reason: 'No.' }))
  const previous = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'synthetic-groq-key'
  try {
    const result = await classifyOutreachReply('Can you share more?', async () => ({
      choices: [{ message: { content: '{"classification":"made_up"}' } }],
    }))
    assert.equal(result.classification, 'other')
    assert.equal(result.confidence, 0)
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous
  }
})

test('suggested reply output is bounded and rejects unsupported guarantees', async () => {
  assert.throws(() => validateSuggestedReply({ subject: 'Re: API', body: 'We guarantee revenue.' }), /suggestion_invalid/)
  const previous = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'synthetic-groq-key'
  try {
    const suggestion = await suggestOutreachReply({ provider: 'Example', product: 'Weather API',
      inboundSubject: 'Re: Weather API', inboundBody: 'How does payment work?', history: [] }, async () => ({
      choices: [{ message: { content: '{"subject":"Re: Weather API","body":"Thanks for the question. USDC is handled per request on Arc."}' } }],
    }))
    assert.deepEqual(suggestion, { subject: 'Re: Weather API',
      body: 'Thanks for the question. USDC is handled per request on Arc.' })
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous
  }
})

test('matched inbound processing creates only a draft suggestion and never sends it', async () => {
  let finalized: unknown = null
  let classifyCalls = 0
  const result = await processInboundReply(reply, {
    ingest: async () => ({ id: 'inbound-1', threadId: 'thread-1', matchedBy: 'in_reply_to', processingState: 'received', duplicate: false }),
    context: async () => ({ provider: 'Example', product: 'Weather API', inboundSubject: reply.subject,
      inboundBody: reply.body, threadStatus: 'sent', history: [] }),
    classify: async () => { classifyCalls++; return { classification: 'technical_question', confidence: 0.9, reason: 'Setup question.' } },
    suggest: async () => ({ subject: 'Re: Weather API', body: 'Suggested response.' }),
    finalize: async (...args) => { finalized = args },
  })
  assert.equal(result.processingState, 'suggested')
  assert.equal(classifyCalls, 1)
  assert.deepEqual(finalized, ['inbound-1', { classification: 'technical_question', confidence: 0.9, reason: 'Setup question.' },
    'suggested', { subject: 'Re: Weather API', body: 'Suggested response.' }])
  assert.doesNotMatch(String(processInboundReply), /sendOutreachEmail|fetch\(/)
})

test('unmatched and completed duplicate replies do not classify or draft', async () => {
  let calls = 0
  const dependencies = (result: { id: string; threadId: string | null; matchedBy: null; processingState: 'unmatched' | 'suggested'; duplicate: boolean }) => ({
    ingest: async () => result,
    context: async () => { calls++; throw new Error('unexpected') },
    classify: async () => { calls++; throw new Error('unexpected') },
    suggest: async () => { calls++; throw new Error('unexpected') },
    finalize: async () => { calls++ },
  })
  assert.equal((await processInboundReply(reply, dependencies({ id: 'u', threadId: null, matchedBy: null,
    processingState: 'unmatched', duplicate: false }) as never)).processingState, 'unmatched')
  assert.equal((await processInboundReply(reply, dependencies({ id: 'd', threadId: 't', matchedBy: null,
    processingState: 'suggested', duplicate: true }) as never)).processingState, 'suggested')
  assert.equal(calls, 0)
})

test('migration preserves manual approval and uses existing Brevo transport for reply drafts', () => {
  assert.match(migration, /mahshar_admin_outreach_approve_reply_draft/)
  assert.match(migration, /status='ready_to_send'/)
  assert.match(migration, /mahshar_admin_outreach_assert_reply_sendable/)
  assert.match(migration, /mahshar_admin_outreach_mark_reply_sent/)
  const repository = readFileSync('src/lib/admin-outreach/repository.ts', 'utf8')
  assert.match(repository, /message\.reply_to_message_id[\s\S]+mahshar_admin_outreach_assert_reply_sendable/)
  assert.match(approvalRoute, /approveOutreachDraft[\s\S]+sendOutreachEmail[\s\S]+markOutreachSent/)
  assert.match(transport, /headers: \{ idempotencyKey: message\.id \}/)
  assert.doesNotMatch(migration, /http|smtp|sendgrid|cron|schedule/i)
})

test('V2 migration retains V1 sent records and private service-role-only boundaries', () => {
  assert.match(migration, /ALTER COLUMN thread_id DROP NOT NULL/)
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM|UPDATE public\.worker_/i)
  assert.match(migration, /SECURITY DEFINER SET search_path=''/g)
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC,anon,authenticated,service_role/g)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]+TO service_role/g)
})
