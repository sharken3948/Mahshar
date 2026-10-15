import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { renderInvitationTemplate, INVITATION_TEMPLATE_VERSION, type InvitationVariables } from '../../src/lib/admin-worker/invitation-template'
import { officialNamesFromPage, resolveOfficialNames, type OfficialNameEvidence, type OfficialNameProof } from '../../src/lib/admin-worker/invitation-names'
import { validAcquisitionDraft, type AcquisitionCandidate } from '../../src/lib/admin-worker/acquisition'

const domain = 'acme.example'
const generic = "We'd like to invite your team to explore listing one of your APIs on Mahshar."
const evidence = (name: string, kind: OfficialNameProof['kind'] = 'product', basis: OfficialNameProof['basis'] = 'provider_statement'): OfficialNameEvidence => ({
  kind, name, basis, quote: `Our ${kind === 'company' ? 'company' : 'API'} is called ${name}.`,
  sourceId: 'proof', sourceType: 'website', sourceRole: 'official_docs', url: `https://${domain}/products`, checkedAt: new Date().toISOString(),
})
const variables = (namingEvidence: OfficialNameEvidence[] = []): InvitationVariables => ({ company: null, product: null, companyVerified: false, productVerified: false, domain, namingEvidence })
function draft(v = variables()) { const result = renderInvitationTemplate(v); assert.ok(result.ok); return result.draft }

test('official body evidence yields exact grounded v2 text; final content and version must validate', () => {
  const v = variables([evidence("Acme & O'Reilly", 'company'), evidence('Acme Developer API')])
  const rendered = draft(v)
  assert.equal(rendered.templateVersion, 'mahshar-provider-invitation-v2')
  assert.equal(rendered.subject, 'Invitation to list your API on Mahshar')
  assert.equal(rendered.body, `Hello Acme & O'Reilly team,

I'm reaching out from Mahshar, an API marketplace built on Arc Mainnet.

Mahshar enables developers, individual users, and autonomous AI agents to discover and access APIs through pay-per-call USDC payments.

We'd like to invite Acme & O'Reilly to explore listing Acme Developer API on Mahshar.

You can choose which APIs or endpoints to make available, with no need to migrate your existing infrastructure.

You can learn more at https://mahshar.xyz/providers.

Best regards,
Mahshar Team
support@mahshar.xyz`)
  const candidate = { templateVariables: v } as AcquisitionCandidate
  assert.ok(validAcquisitionDraft(candidate, rendered))
  for (const changed of [{ ...rendered, body: rendered.body + '\nExtra claim' }, { ...rendered, templateVersion: 'mahshar-provider-invitation-v1' }, { ...rendered, subject: 'Other' }]) assert.equal(validAcquisitionDraft(candidate, changed), false)
  assert.deepEqual(draft(v), rendered)
})

test('all 18 saved directory-title drafts fall back without guessing domains, brands or commercial names', () => {
  const saved = JSON.parse(readFileSync(new URL('./fixtures/invitation-name-saved.json', import.meta.url), 'utf8'))
  assert.equal(saved.providers.length, 18)
  for (const item of saved.providers) {
    // Even forged legacy verification booleans and a title-matching source cannot promote directory evidence.
    const dir = { ...evidence(item.product), sourceType: item.directory.source_type, sourceRole: item.directory.source_role, url: item.directory.url }
    const rendered = draft({ ...variables([dir]), domain: item.domain, company: item.company, product: item.product, companyVerified: true, productVerified: true })
    assert.match(rendered.body, /^Hello team,/)
    assert.ok(rendered.body.includes(generic), item.domain)
    assert.ok(!rendered.body.includes(item.company) && !rendered.body.includes(item.product), item.domain)
    assert.deepEqual(officialNamesFromPage(item.official.url, `<title>${item.product}</title><h1>${item.product}</h1>`, item.domain), [])
  }
})

test('documentation, environment and malicious labels never become product names; API and Developer are legitimate words', () => {
  for (const name of ['Hubhopper Partner Integration API(s) - Production', 'Labs64 NetLicensing RESTful API Test Center', 'Swagger UI', 'OpenAPI Documentation', 'API Reference', 'Developer Portal', 'Acme Sandbox', 'Demo API', 'Unknown', '[Company]', 'Fake [API Product]', 'https://evil.test', 'email@evil.test', 'Acme\r\nBcc: victim', '<script>x</script>', 'Acme\u202e', 'Acme\u200b', ' padded ', 'x'.repeat(201)]) {
    assert.ok(draft(variables([evidence(name)])).body.includes(generic), name)
  }
  for (const name of ['Developer Tools API', 'Acme API', 'Données API']) assert.ok(draft(variables([evidence(name)])).body.includes(`listing ${name} on Mahshar.`))
  assert.match(draft(variables([evidence('acme.example', 'company')])).body, /^Hello team,/)
})

test('page titles, Swagger/OpenAPI contracts and unsupported metadata prove nothing; explicit official body/schema evidence is captured', () => {
  const url = `https://${domain}/products`
  assert.deepEqual(officialNamesFromPage(url, '<title>Real API</title><h1>Real API</h1>', domain), [])
  for (const hidden of ['<!--<p>Our API is called Fake API.</p>-->', '<!--<p>Our API is called Fake API.</p>', '<p hidden>Our API is called Fake API.</p>', '<pre><p>Our API is called Fake API.</p></pre>', '<template><p>Our API is called Fake API.</p></template>', '<div aria-hidden="true"><p>Our API is called Fake API.</p></div>']) assert.deepEqual(officialNamesFromPage(url, hidden, domain), [])
  assert.deepEqual(officialNamesFromPage(url, JSON.stringify({ openapi: '3.0.0', info: { title: 'Real API' } }), domain), [])
  assert.deepEqual(officialNamesFromPage(url, '<script type="application/ld+json">{"@type":"WebPage","name":"Real API","url":"https://acme.example/"}</script>', domain), [])
  const html = `<script type="application/ld+json">${JSON.stringify([{ '@type': 'Organization', name: 'Acme', url }, { '@type': 'SoftwareApplication', name: 'Developer API', url, description: 'A commercial API for developers.' }])}</script>`
  const captured = officialNamesFromPage(url, html, domain)
  assert.equal(captured.length, 2)
  assert.deepEqual(resolveOfficialNames(domain, captured.map(p => ({ ...evidence(p.name, p.kind), ...p }))), { company: 'Acme', product: 'Developer API' })
  assert.equal(officialNamesFromPage(url, '<p>Our API is called Real API.</p>', domain)[0].name, 'Real API')
  const nonApi = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Ordinary Product', url, description: 'A software product for developers.' })}</script>`
  assert.deepEqual(officialNamesFromPage(url, nonApi, domain), [])
  const docOnly = `<script type="application/ld+json">${JSON.stringify({ '@type': 'SoftwareApplication', name: 'Acme API', url, description: 'API documentation for the service.' })}</script>`
  assert.deepEqual(officialNamesFromPage(url, docOnly, domain), [])
  assert.deepEqual(officialNamesFromPage('https://evil.test/', html, domain), [])
  assert.deepEqual(officialNamesFromPage(url, '<script type="application/ld+json">broken</script>', domain), [])
  assert.deepEqual(officialNamesFromPage(url, '<p>Our API is called Real API.</p>'.repeat(65), domain), [])
})

test('conflicting, stale, lookalike, invalid, heading-only and oversized proof falls back; independent brand/product fallback is deterministic', () => {
  assert.ok(draft(variables([evidence('First API'), evidence('Second API')])).body.includes(generic))
  assert.ok(draft(variables([evidence('Same API'), evidence('Same API')])).body.includes('listing Same API'))
  for (const change of [{ sourceRole: 'directory_assertion' }, { sourceType: 'api_directory' }, { url: 'https://acme.example.evil.test/' }, { checkedAt: '2000-01-01' }, { basis: 'heading' }, { quote: 'Real API documentation' }]) assert.ok(draft(variables([{ ...evidence('Real API'), ...change } as OfficialNameEvidence])).body.includes(generic))
  assert.ok(draft(variables(Array.from({ length: 65 }, () => evidence('Real API')))).body.includes(generic))
  assert.match(draft(variables([evidence('Acme', 'company')])).body, /^Hello Acme team,/)
  assert.ok(draft(variables([evidence('Acme', 'company')])).body.includes(generic))
  assert.ok(draft(variables([evidence('Real API')])).body.includes('invite your team to explore listing Real API'))
  assert.match(draft().body, /^Hello team,/)
  assert.ok(draft().body.includes(generic))
  assert.equal(INVITATION_TEMPLATE_VERSION, 'mahshar-provider-invitation-v2')
})
