import assert from 'node:assert/strict'
import { test } from 'node:test'
import { documentationFact, documentationLinks, hasDraftDocumentation, invitationEvidence, ownsDocumentationUrl, type DraftEvidenceContext } from '../../src/lib/admin-worker/acquisition-evidence'
import { ensureAcquisitionDocumentation } from '../../src/lib/admin-worker/acquisition-research'
import { AcquisitionBudgetPause } from '../../src/lib/admin-worker/acquisition'

const context = (): DraftEvidenceContext => ({ key: 'key', domain: 'supplier.example', allowed: true, identityVerified: true,
  contactVerified: true, docsUrls: [], facts: [{ sourceType: 'website', sourceRole: 'official_site',
    url: 'https://supplier.example/', factualSummary: 'Verified identity', checkedAt: '2026-10-15T00:00:00Z' }] })
const body = '<h1>API documentation</h1><code>GET https://api.supplier.example/v1/weather</code>'

test('official evidence rejects unsafe/lookalike URLs, marketing-only pages, script-only examples and directory relabeling', () => {
  for (const url of ['http://supplier.example/docs', 'https://supplier.example.evil.test/docs', 'https://supplier.example@evil.test/',
    'https://evil.test@supplier.example/docs', 'https://supplier.example:444/docs', 'javascript:alert(1)']) {
    assert.equal(ownsDocumentationUrl(url, 'supplier.example'), false)
    assert.equal(documentationFact(url, body, 'supplier.example', 'now'), null)
  }
  assert.equal(documentationFact('https://supplier.example/', 'Welcome to our API company', 'supplier.example', 'now'), null)
  assert.equal(documentationFact('https://supplier.example/docs', `<script>${body}</script>Welcome`, 'supplier.example', 'now'), null)
  assert.equal(documentationFact('https://supplier.example/docs', body.replace('api.supplier.example', 'evil.test'), 'supplier.example', 'now'), null)
  const contract = { openapi: '3.0.0', servers: [{ url: 'https://api.supplier.example/v1' }], paths: { '/weather': { get: {} } } }
  assert.equal(documentationFact('https://supplier.example/openapi.json', JSON.stringify(contract), 'supplier.example', 'now')?.sourceRole, 'official_docs')
  const c = context()
  c.facts.push({ sourceType: 'api_directory', sourceRole: 'official_docs', url: 'https://api.apis.guru/spec.json', factualSummary: body, checkedAt: 'now' })
  assert.equal(hasDraftDocumentation(c), false)
  const doc = documentationFact('https://supplier.example/docs', body, c.domain, 'now')!
  c.facts = [...Array.from({ length: 8 }, () => ({ ...doc, sourceType: 'api_directory' as const,
    sourceRole: 'directory_assertion' as const, factualSummary: 'Structured OpenAPI contract verified' })), doc]
  c.facts.unshift({ ...doc, sourceType: 'api_directory', url: 'https://api.apis.guru/untrusted.json' })
  assert.equal(JSON.parse(invitationEvidence(c)[0]).role, 'official_docs', 'supporting directory evidence cannot crowd out official documentation')
  assert.ok(!invitationEvidence(c).some(value => value.includes('untrusted.json')), 'incorrectly labeled third-party docs never enter the prompt')
  assert.match(doc.factualSummary!, /https:\/\/api.supplier.example\/v1\/weather/)
  assert.deepEqual(documentationLinks('<a href="https://evil.test/docs">Docs</a><form action="/submit"></form><a href="/docs#intro">Docs</a><a href=/docs>Docs</a>', 'https://supplier.example/', 'supplier.example'), ['https://supplier.example/docs'])
})

test('missing documentation uses at most three budgeted deduplicated GET fetches and saves only actual official docs', async () => {
  const c = context(); c.docsUrls = ['https://supplier.example/', 'https://supplier.example/']
  const fetched: string[] = [], claims: string[] = [], persisted: unknown[] = []
  await ensureAcquisitionDocumentation('run', 'provider', 'lead', c, {
    running: async () => true,
    claim: async (_run, kind, key) => { assert.equal(kind, 'research'); claims.push(key); return 'claimed' },
    fetcher: async url => {
      fetched.push(url)
      return { url, status: 200, contentType: 'text/html', body: url.endsWith('/docs') ? body
        : '<a href="/docs">Docs</a><a href="https://evil.test/docs">Docs</a>' }
    },
    save: async (_lead, facts) => { persisted.push(...facts) },
  })
  assert.deepEqual(fetched, ['https://supplier.example/', 'https://supplier.example/docs'])
  assert.equal(claims.length, 2); assert.equal(persisted.length, 1)
  assert.equal((persisted[0] as { sourceRole: string }).sourceRole, 'official_docs')
  const empty: string[] = []
  c.docsUrls = Array.from({ length: 8 }, (_, i) => `https://supplier.example/docs/${i}`)
  await ensureAcquisitionDocumentation('run', 'provider', 'lead', c, {
    running: async () => true, claim: async () => 'claimed', save: async () => assert.fail('no documentation to save'),
    fetcher: async url => { empty.push(url); return { url: 'https://evil.test/docs', status: 200, contentType: 'text/html', body } },
  })
  assert.equal(empty.length, 3, 'redirected unrelated pages cannot supply documentation or extend the bound')
})

test('existing saved official docs reuse no budget, network or writes; Stop/budget denial prevents fetch', async () => {
  const c = context(); c.facts.unshift(documentationFact('https://supplier.example/docs', body, c.domain, 'now')!)
  const forbidden = async (): Promise<never> => assert.fail('unexpected side effect')
  await ensureAcquisitionDocumentation('run', 'provider', 'lead', c, { running: forbidden, claim: forbidden, save: forbidden, fetcher: forbidden })
  c.facts.shift()
  for (const running of [false, true]) {
    await assert.rejects(ensureAcquisitionDocumentation('run', 'provider', 'lead', c, {
      running: async () => running, claim: async () => 'exhausted', save: forbidden, fetcher: forbidden,
    }), AcquisitionBudgetPause)
  }
})
