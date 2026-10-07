import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { generateGroundedOutreachDraft, isEmailOutreachEligible } from '../../src/lib/admin-outreach/draft'
import { sendOutreachEmail } from '../../src/lib/admin-outreach/transport'

const migration = readFileSync('supabase/migrations/20261007000200_admin_outreach_v1.sql', 'utf8')
const client = readFileSync('src/app/admin/outreach/outreach-client.tsx', 'utf8')
const repository = readFileSync('src/lib/admin-outreach/repository.ts', 'utf8')
const approvalRoute = readFileSync('src/app/api/admin/outreach/drafts/[id]/approve/route.ts', 'utf8')
const legacyOutreachRoute = readFileSync('src/app/api/discovery/outreach/route.ts', 'utf8')

const lead = {
  provider: 'Example Provider', product: 'Weather API', preferred_email: 'team@example.com',
  email_ready: true, contactability: 'verified_email' as const,
}

test('email outreach admits only verified preferred email leads', () => {
  assert.equal(isEmailOutreachEligible(lead), true)
  assert.equal(isEmailOutreachEligible({ ...lead, email_ready: false }), false)
  assert.equal(isEmailOutreachEligible({ ...lead, contactability: 'official_contact_page' }), false)
  assert.equal(isEmailOutreachEligible({ ...lead, preferred_email: '//www.tiktok.com/@example' }), false)
  assert.match(repository, /contact_form_only/)
  assert.match(repository, /!lead\.email_ready && Boolean\(lead\.official_contact_url\)/)
})

test('grounded draft uses only supplied names and makes no performance promise', () => {
  const draft = generateGroundedOutreachDraft(lead)
  assert.match(draft.subject, /Weather API/)
  assert.match(draft.body, /Example Provider/)
  assert.match(draft.body, /pay-per-call distribution channel/)
  assert.match(draft.body, /single endpoint/)
  assert.match(draft.body, /support@mahshar\.xyz/)
  assert.doesNotMatch(draft.body, /guarantee|revenue|customers|traffic|we love|amazing/i)
  assert.doesNotMatch(draft.body, /undefined|null/)
})

test('manual approval is durable and the only first-send path is the approval action', () => {
  assert.match(migration, /status='ready_to_send'/)
  assert.match(migration, /approved_by=p_admin_wallet/)
  assert.doesNotMatch(migration, /http|smtp|sendgrid|resend|postmark|mailgun/i)
  assert.match(client, /Approve &amp; Send|Approve & Send/)
  assert.match(client, /transport required/)
  assert.match(approvalRoute, /approveOutreachDraft[\s\S]+sendOutreachEmail[\s\S]+markOutreachSent/)
  assert.doesNotMatch(repository, /setInterval|setTimeout|cron|schedule/i)
})

test('Brevo transport sends one plain-text message with a stable idempotency key', async () => {
  const previousMode = process.env.MAINNET_MODE
  const previousKey = process.env.BREVO_API_KEY
  process.env.MAINNET_MODE = 'true'; process.env.BREVO_API_KEY = 'synthetic-test-key'
  const calls: Array<{ url: string; init: RequestInit }> = []
  try {
    const result = await sendOutreachEmail({ id: '4a3b3b55-327d-4674-9587-d1d88fc3dd53', recipient: 'team@example.com',
      subject: 'Example API on Mahshar', body: 'Grounded plain text.' }, async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ messageId: 'provider-message-1' }), { status: 201 })
    })
    assert.equal(result.providerMessageId, 'provider-message-1')
    assert.equal(calls[0]?.url, 'https://api.brevo.com/v3/smtp/email')
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers['api-key'], 'synthetic-test-key')
    assert.equal(headers.Authorization, undefined)
    const payload = JSON.parse(String(calls[0]?.init.body))
    assert.deepEqual(payload.to, [{ email: 'team@example.com' }])
    assert.deepEqual(payload.sender, { name: 'Mahshar', email: 'support@mahshar.xyz' })
    assert.equal(payload.textContent, 'Grounded plain text.')
    assert.deepEqual(payload.headers, { idempotencyKey: '4a3b3b55-327d-4674-9587-d1d88fc3dd53' })
    assert.equal('htmlContent' in payload, false)
  } finally {
    if (previousMode === undefined) delete process.env.MAINNET_MODE; else process.env.MAINNET_MODE = previousMode
    if (previousKey === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = previousKey
  }
})

test('legacy discovery outreach no longer contains a Resend transport path', () => {
  assert.match(legacyOutreachRoute, /https:\/\/api\.brevo\.com\/v3\/smtp\/email/)
  assert.match(legacyOutreachRoute, /process\.env\.BREVO_API_KEY/)
  assert.match(legacyOutreachRoute, /support@mahshar\.xyz/)
  assert.doesNotMatch(legacyOutreachRoute, /api\.resend\.com|RESEND_API_KEY/)
})

test('DNC and human-terminal state are rechecked by every draft boundary', () => {
  assert.match(migration, /decision IN \('rejected','do_not_contact'\)/)
  assert.match(migration, /lead\.status IN \('rejected','do_not_contact','closed'\)/)
  assert.match(migration, /thread\.status IN \('sent','needs_reply','interested','rejected','do_not_contact','closed'\)/)
  assert.match(migration, /admin_outreach_transition_invalid/)
  assert.match(client, /Do Not Contact/)
})

test('Outreach tables are private and mutations are service-role RPC only', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g)
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]+PUBLIC, anon, authenticated, service_role/)
  assert.match(migration, /GRANT SELECT ON TABLE[\s\S]+TO service_role/)
  assert.match(migration, /SECURITY DEFINER SET search_path=''/g)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]+TO service_role/g)
})
