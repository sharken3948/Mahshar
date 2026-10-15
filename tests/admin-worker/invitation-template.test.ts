import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderInvitationTemplate, INVITATION_SUBJECT, INVITATION_TEMPLATE_VERSION } from '../../src/lib/admin-worker/invitation-template'
import { validAcquisitionDraft, type AcquisitionCandidate } from '../../src/lib/admin-worker/acquisition'

test('approved English template is exact, deterministic and substitutes only the two saved variables', () => {
  const variables = { company: "Acme & O'Reilly", product: 'Weather API', companyVerified: true, productVerified: true }
  const result = renderInvitationTemplate(variables); assert.ok(result.ok)
  assert.deepEqual(renderInvitationTemplate(variables), result)
  assert.equal(result.draft.subject, 'Invitation to list your API on Mahshar')
  assert.equal(result.draft.templateVersion, 'mahshar-provider-invitation-v1')
  assert.equal(result.draft.generator, 'template')
  assert.equal(result.draft.body, `Hello Acme & O'Reilly team,

I'm reaching out from Mahshar, an API marketplace built on Arc Mainnet.

Mahshar enables developers, individual users, and autonomous AI agents to discover and access APIs through pay-per-call USDC payments.

We'd like to invite Acme & O'Reilly to explore listing Weather API on Mahshar.

You can choose which APIs or endpoints to make available, with no need to migrate your existing infrastructure.

You can learn more at https://mahshar.xyz/providers.

Best regards,
Mahshar Team
support@mahshar.xyz`)
  const candidate = { templateVariables: variables } as AcquisitionCandidate
  assert.ok(validAcquisitionDraft(candidate, result.draft))
  for (const changed of [{ ...result.draft, body: result.draft.body + '\nExtra text' }, { ...result.draft, templateVersion: 'unknown' },
    { ...result.draft, subject: INVITATION_SUBJECT + '!' }]) assert.equal(validAcquisitionDraft(candidate, changed), false)
})

test('missing, unverified and malicious names have explicit skip reasons; no variables are inferred', () => {
  const good = { company: 'Acme', product: 'Maps API', companyVerified: true, productVerified: true }
  for (const field of ['company', 'product'] as const) {
    for (const missing of [null, '', '   ']) {
      assert.deepEqual(renderInvitationTemplate({ ...good, [field]: missing }), { ok: false, reason: `template_${field}_missing` })
    }
    for (const invalid of ['Unknown', '[Company]', '[API Product]', 'Fake [Company]', 'https://evil.test/', 'team@evil.test',
      'Acme\r\nBcc: victim', '<script>attack</script>', 'Acme\u202e', 'Acme\u200b', 'a'.repeat(201), ' padded ']) {
      assert.deepEqual(renderInvitationTemplate({ ...good, [field]: invalid }), { ok: false, reason: `template_${field}_invalid` })
    }
    assert.deepEqual(renderInvitationTemplate({ ...good, [`${field}Verified`]: false }), { ok: false, reason: `template_${field}_unverified` })
  }
  const domain = renderInvitationTemplate({ ...good, company: 'supplier.example' }); assert.ok(domain.ok)
  assert.match(domain.draft.body, /^Hello supplier\.example team,/)
  assert.ok(!domain.draft.body.includes('Supplier Example'))
  assert.ok(renderInvitationTemplate({ ...good, company: '株式会社 Acme', product: 'Données API' }).ok)
  assert.equal(INVITATION_TEMPLATE_VERSION, 'mahshar-provider-invitation-v1')
})
