import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { discoverProviderContacts } from './contact'
import {
  buildContactClaimKey, canonicalContactClaimValue, contactClaimKeySegment, CONTACT_CLAIM_FINGERPRINT_LENGTH,
  type ContactClaimDescriptor, type ContactClaimOperation,
} from './contact-claim-key'
import { contactSearchQueries, createPublicContactSearchAdapter, type ContactSearchAdapter } from './contact-search'
import type { DiscoveryFetcher } from './fetch'
import type { RawCandidate } from './types'

const candidate: RawCandidate = {
  sourceType: 'api_directory', sourceUrl: 'https://api.apis.guru/v2/opencage.example.json',
  discoveredName: 'OpenCage Fixture', discoveredDomain: 'opencage.example', discoveredProduct: 'Geocoding API',
}

function fixture(pages: Record<string, string | Error>): DiscoveryFetcher {
  return async url => {
    const value = pages[url]
    if (value instanceof Error) throw value
    return { url, status: value === undefined ? 404 : 200, contentType: 'text/html', body: value ?? '' }
  }
}

const claim = async () => 'claimed' as const
const now = () => '2026-10-05T12:00:00.000Z'
const noSearch: ContactSearchAdapter = { search: async () => [] }

const CLAIM_KEY_PATTERN = /^[a-z0-9:_-]{1,120}$/
const CANDIDATE_ID = '131f8b3d-82e0-4f6f-b137-3f53e6f7c950'
const FAILED_LEAD_ID = '7b00f795-46db-4bac-b8fe-6c8e99619d1e'

test('contact claim keys always fingerprint the canonical dynamic value across the edge matrix', () => {
  const longHost = Array.from({ length: 4 }, (_, index) => `${'h'.repeat(50)}${index}`).join('.')
  const cases: Array<{ operation: ContactClaimOperation; value: string }> = [
    { operation: 'search', value: '' },
    { operation: 'search', value: '!@#$%^&*()[]{}' },
    { operation: 'search', value: 'PROVIDER CONTACT' },
    { operation: 'search', value: 'İstanbul sağlayıcı iletişim' },
    { operation: 'search', value: 'Cafe\u0301 contact' },
    { operation: 'search', value: 'provider 😀 contact' },
    { operation: 'page', value: `https://${longHost}.example/contact` },
    { operation: 'page', value: `https://api.example.com/${'long-path/'.repeat(40)}contact` },
    { operation: 'verify', value: `https://github.com/example-org/api/blob/main/${'nested/'.repeat(30)}SUPPORT.md` },
    { operation: 'search', value: `"${'Long Provider '.repeat(40)}" contact` },
    { operation: 'search', value: 'provider---___...contact' },
    { operation: 'page', value: 'https://api.example.com/contact?team=API&source=worker' },
    { operation: 'verify', value: 'https://github.com/example-org/a%2Fb/SUPPORT.md?ref=Main%2FNext' },
  ]
  const keys = cases.map(({ operation, value }) => {
    const canonical = canonicalContactClaimValue(operation, value)
    const expectedFingerprint = createHash('sha256').update(canonical).digest('hex')
      .slice(0, CONTACT_CLAIM_FINGERPRINT_LENGTH)
    const key = buildContactClaimKey({ scope: 'candidate', scopeId: CANDIDATE_ID, operation, value })
    assert.ok(key.length > 0 && key.length <= 120)
    assert.match(key, CLAIM_KEY_PATTERN)
    assert.ok(key.endsWith(`-${expectedFingerprint}`))
    return key
  })
  assert.equal(new Set(keys).size, keys.length)
})

test('exact rendered-form collision remains distinct because every value has its own fingerprint', () => {
  const unsafe = contactClaimKeySegment('provider.name', 48)
  const safeLiteral = contactClaimKeySegment('provider-name-174b5661fbd14a44f7d009ed', 48)
  assert.equal(unsafe, 'provider-name-174b5661fbd14a44f7d009ed')
  assert.notEqual(unsafe, safeLiteral)
})

test('URL and query canonicalization is stable without merging meaningful paths, queries, or encodings', () => {
  const key = (operation: ContactClaimOperation, value: string) => buildContactClaimKey({
    scope: 'candidate', scopeId: CANDIDATE_ID, operation, value,
  })
  assert.equal(key('page', 'HTTPS://API.EXAMPLE.COM/Contact?Team=API#top'),
    key('page', 'https://api.example.com/Contact?Team=API#other'))
  assert.notEqual(key('page', 'https://api.example.com/Contact'), key('page', 'https://api.example.com/contact'))
  assert.notEqual(key('page', 'https://api.example.com/contact?a=1&b=2'),
    key('page', 'https://api.example.com/contact?b=2&a=1'))
  assert.notEqual(key('verify', 'https://github.com/org/repo/blob/main/SUPPORT.md'),
    key('verify', 'https://github.com/org/repo/blob/dev/SUPPORT.md'))
  assert.notEqual(key('verify', 'https://github.com/org/a%2Fb/SUPPORT.md'),
    key('verify', 'https://github.com/org/a/b/SUPPORT.md'))
  assert.equal(key('search', 'Café contact'), key('search', 'Cafe\u0301 contact'))
})

test('reordered navigation URLs, search-result URLs, and queries keep one persisted replay identity', () => {
  const urlAt = (operation: 'page' | 'verify', ordinal: number) => {
    const runtimeInput = { scope: 'candidate' as const, scopeId: CANDIDATE_ID, operation,
      value: 'https://api.example.com/contact?team=sales', ordinal }
    return buildContactClaimKey(runtimeInput)
  }
  const queryAt = (index: number) => {
    const runtimeInput = { scope: 'candidate' as const, scopeId: CANDIDATE_ID, operation: 'search' as const,
      value: '"Provider" contact', index }
    return buildContactClaimKey(runtimeInput)
  }
  assert.equal(new Set([0, 1, 5].map(ordinal => urlAt('page', ordinal))).size, 1)
  assert.equal(new Set([0, 1, 5].map(ordinal => urlAt('verify', ordinal))).size, 1)
  assert.equal(new Set([0, 1, 5].map(queryAt)).size, 1)
})

test('runtime structural validation rejects injection and malformed scope IDs before the RPC boundary', () => {
  let rpcCalls = 0
  const runtimeBuild = (overrides: Record<string, unknown>) => buildContactClaimKey({
    scope: 'candidate', scopeId: CANDIDATE_ID, operation: 'page', value: 'https://api.example.com/',
    ...overrides,
  } as Parameters<typeof buildContactClaimKey>[0])
  const runtimeClaim = (overrides: Record<string, unknown>) => {
    const key = runtimeBuild(overrides)
    rpcCalls += 1
    return key
  }
  assert.throws(() => runtimeClaim({ scope: 'candidate:extra' }), /worker_contact_claim_scope_invalid/)
  assert.throws(() => runtimeClaim({ scope: 'unknown' }), /worker_contact_claim_scope_invalid/)
  assert.throws(() => runtimeClaim({ operation: 'page:extra' }), /worker_contact_claim_operation_invalid/)
  assert.throws(() => runtimeClaim({ operation: 'unknown' }), /worker_contact_claim_operation_invalid/)
  assert.throws(() => runtimeClaim({ scopeId: 'not-a-worker-uuid' }), /worker_contact_claim_scope_id_invalid/)
  assert.equal(rpcCalls, 0)
})

test('failed production enrichment page key conforms to the existing RPC contract', () => {
  const key = buildContactClaimKey({
    scope: 'enrich', scopeId: FAILED_LEAD_ID, operation: 'page', value: 'https://fraudlabspro.com/',
  })
  assert.equal(key,
    `enrich:${FAILED_LEAD_ID}:page:https-fraudlabspro-com-9c94107c75d53767b6742dea`)
  assert.match(key, CLAIM_KEY_PATTERN)
  assert.ok(!key.includes('.'))
})

test('OpenCage-style source without contact discovers an official Contact route', async () => {
  let searchCalls = 0
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: { search: async () => { searchCalls += 1; return [] } },
    fetcher: fixture({
      'https://opencage.example/': '<title>OpenCage Fixture</title><a href="/contact">Contact</a>',
      'https://opencage.example/contact': '<h1>OpenCage Fixture contact</h1><p>Talk to our team.</p>',
    }) })
  assert.equal(result.status, 'official_contact_page')
  assert.equal(result.preferredContactUrl, 'https://opencage.example/contact')
  assert.equal(result.emailReady, false)
  assert.equal(searchCalls, 0)
})

test('official mailto and visible email are verified, deduplicated, and ordered for outreach', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    fetcher: fixture({ 'https://opencage.example/': `<h1>OpenCage Fixture</h1>
      <a href="mailto:security@opencage.example">Security</a>
      <a href="mailto:support@opencage.example">Support</a>
      <a href="mailto:partnerships@opencage.example">API partnerships</a>
      partnerships@opencage.example <a href="/sales">Sales</a>`,
      'https://opencage.example/sales': '<h1>OpenCage Fixture sales</h1>',
    }) })
  assert.equal(result.status, 'verified_email')
  assert.equal(result.emailReady, true)
  assert.equal(result.preferredEmail, 'partnerships@opencage.example')
  assert.equal(result.evidence.filter(item => item.value === 'partnerships@opencage.example').length, 1)
  assert.equal(result.evidence.find(item => item.purpose === 'security')?.preferred, false)
  assert.equal(result.evidence.find(item => item.purpose === 'security')?.emailReady, false)
})

test('HTML attribute fragments cannot be persisted as verified email values', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [],
    claimContactBudget: claim, now, searchAdapter: noSearch,
    fetcher: fixture({ 'https://opencage.example/': `<h1>OpenCage Fixture</h1>
      <meta content='feedback@opencage.example'><p>content='feedback@opencage.example</p>` }) })
  assert.ok(!result.evidence.some(item => item.value.startsWith("content='")))
  assert.ok(result.evidence.every(item => item.type !== 'email' || item.value === 'feedback@opencage.example'))
})

test('info, support, and team addresses from verified official docs remain email-ready', async () => {
  const docs = 'https://docs.opencage.example/contact'
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example',
    facts: [{ sourceType: 'website', sourceRole: 'official_docs', url: docs, checkedAt: now() }],
    claimContactBudget: claim, now, fetcher: fixture({
      'https://opencage.example/': '<h1>OpenCage Fixture</h1>',
      [docs]: '<h1>Developer support</h1> info@opencage.example support@opencage.example team@opencage.example',
    }) })
  assert.equal(result.status, 'verified_email')
  for (const email of ['info@opencage.example', 'support@opencage.example', 'team@opencage.example']) {
    const evidence = result.evidence.find(item => item.value === email)
    assert.deepEqual([evidence?.sourceType, evidence?.emailReady], ['official_docs', true])
  }
})

test('Contact, Support, and Sales pages remain official non-email channels', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    fetcher: fixture({ 'https://opencage.example/': `<h1>OpenCage Fixture</h1>
      <a href="/support">Support</a><a href="/sales">Sales</a><a href="/company/contact">Contact</a>`,
      'https://opencage.example/support': '<h1>OpenCage Fixture support</h1>',
      'https://opencage.example/sales': '<h1>OpenCage Fixture sales</h1>',
      'https://opencage.example/company/contact': '<h1>OpenCage Fixture contact</h1>',
    }) })
  assert.equal(result.status, 'official_sales_channel')
  assert.equal(result.emailReady, false)
  assert.ok(result.evidence.some(item => item.purpose === 'support'))
})

test('contact-sales paths and explicit contact forms remain valid outreach routes', async () => {
  for (const [path, body, expected] of [
    ['/contact-sales', '<h1>Talk to sales</h1>', 'official_sales_channel'],
    ['/reach', '<h1>Send a message</h1><form><input type="email" name="email"><textarea name="message"></textarea></form>',
      'official_contact_page'],
  ] as const) {
    const result = await discoverProviderContacts({ candidate: { ...candidate, discoveredContactUrl: `https://opencage.example${path}` },
      normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
      fetcher: fixture({ 'https://opencage.example/': '<h1>OpenCage Fixture</h1>', [`https://opencage.example${path}`]: body }) })
    assert.equal(result.status, expected)
    assert.equal(result.preferredContactUrl, `https://opencage.example${path}`)
  }
})

test('provider homepage may verify an external official support form without trusting directories', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    fetcher: fixture({ 'https://opencage.example/': '<h1>OpenCage Fixture</h1><a href="https://support.vendor.example/opencage">Official support</a>' }) })
  assert.equal(result.status, 'official_contact_page')
  assert.equal(result.preferredContactUrl, 'https://support.vendor.example/opencage')
  assert.equal(result.evidence[0]?.sourceUrl, 'https://opencage.example/')
})

test('ordinary About, Pricing, and Developer navigation is researched but is not itself a contact channel', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch, fetcher: fixture({
      'https://opencage.example/': '<h1>OpenCage Fixture</h1><a href="/about">About</a><a href="/pricing">Pricing</a><a href="/developers">Developers</a>',
      'https://opencage.example/about': '<h1>About OpenCage Fixture</h1>',
      'https://opencage.example/pricing': '<h1>OpenCage Fixture pricing</h1>',
      'https://opencage.example/developers': '<h1>OpenCage Fixture developers</h1>',
    }) })
  assert.equal(result.status, 'contact_unavailable')
  assert.equal(result.evidence.length, 0)
})

test('official GitHub linked by the provider may supply profile and SUPPORT contact evidence', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    fetcher: fixture({
      'https://opencage.example/': '<h1>OpenCage Fixture</h1><a href="https://github.com/opencage-fixture">GitHub</a>',
      'https://github.com/opencage-fixture': '<h1>OpenCage Fixture</h1><a href="https://github.com/opencage-fixture/api/blob/main/SUPPORT.md">SUPPORT.md</a>',
      'https://github.com/opencage-fixture/api/blob/main/SUPPORT.md': '<h1>OpenCage Fixture support</h1><a href="mailto:api-team@example.net">API team</a>',
    }) })
  assert.equal(result.preferredEmail, 'api-team@example.net')
  assert.equal(result.evidence[0]?.sourceType, 'official_github')
})

test('third-party contacts, guessed emails, and identity mismatches are rejected', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch,
    fetcher: fixture({ 'https://opencage.example/': `<h1>Unrelated Company</h1>
      <a href="https://directory.example/opencage">Contact database</a><a href="mailto:hello@other.example">Email</a>`,
    }) })
  assert.equal(result.status, 'unknown')
  assert.equal(result.evidence.length, 0)
  assert.equal(result.preferredEmail, null)
  assert.ok(!result.evidence.some(item => item.value === 'contact@opencage.example'))
})

test('successful bounded no-result is unavailable while fetch failure remains temporary unknown', async () => {
  const unavailable = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch,
    fetcher: fixture({ 'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Documentation only.</p>' }) })
  assert.deepEqual([unavailable.status, unavailable.completed, unavailable.failureCode], ['contact_unavailable', true, null])
  const temporary = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch,
    fetcher: fixture({ 'https://opencage.example/': new Error('timeout') }) })
  assert.deepEqual([temporary.status, temporary.completed, temporary.failureCode], ['unknown', false, 'contact_research_temporary_failure'])
})

test('bounded search queries are deterministic and the production adapter parses only bounded URL leads', async () => {
  assert.deepEqual(contactSearchQueries('OpenCage Fixture', 'opencage.example'), [
    '"OpenCage Fixture" contact', '"OpenCage Fixture" support', '"OpenCage Fixture" sales',
    'site:opencage.example contact', 'site:opencage.example support', '"OpenCage Fixture" GitHub',
  ])
  const adapter = createPublicContactSearchAdapter(async () => ({ url: 'https://www.bing.com/search', status: 200,
    contentType: 'application/rss+xml', body: '<rss><channel><item><title>Official</title><link>https://opencage.example/contact</link></item><item><title>Directory</title><link>https://directory.example/item</link></item></channel></rss>' }))
  assert.deepEqual(await adapter.search('fixture', 1), [{ title: 'Official', url: 'https://opencage.example/contact' }])
  const blocked = createPublicContactSearchAdapter(async () => ({ url: 'https://www.bing.com/search', status: 200,
    contentType: 'text/html', body: '<html>challenge</html>' }))
  await assert.rejects(blocked.search('fixture', 1), /contact_search_malformed/)
})

test('production search adapter distinguishes valid empty RSS from malformed or truncated responses', async () => {
  const adapter = (body: string, contentType = 'application/rss+xml') => createPublicContactSearchAdapter(async () => ({
    url: 'https://www.bing.com/search', status: 200, contentType, body,
  }))
  assert.deepEqual(await adapter('<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>').search('fixture', 3), [])
  for (const body of [
    '<rss><channel><item><title>broken</title>',
    '<rss><channel><item><title>broken</title></channel></item></rss>',
    '<rss><channel><item><title>broken</item></channel></rss>',
    '<rss><channel><item><title>broken</title></item></rss',
    'garbage<rss><channel></channel></rss>',
    '<rss><channel></channel></rss><extra></extra>',
  ]) await assert.rejects(adapter(body).search('fixture', 3), /contact_search_malformed/)
  await assert.rejects(adapter('<html><title>Challenge</title></html>', 'text/html').search('fixture', 3), /contact_search_malformed/)
})

test('production search adapter preserves HTTP and transport failures as temporary failures', async () => {
  for (const status of [403, 429, 500]) {
    const adapter = createPublicContactSearchAdapter(async () => ({
      url: 'https://www.bing.com/search', status, contentType: 'application/rss+xml',
      body: '<rss><channel></channel></rss>',
    }))
    await assert.rejects(adapter.search('fixture', 3), /contact_search_unavailable/)
  }
  const timeout = createPublicContactSearchAdapter(async () => { throw new Error('discovery_timeout') })
  await assert.rejects(timeout.search('fixture', 3), /discovery_timeout/)
})

test('malformed search RSS keeps completed official research retryable instead of unavailable', async () => {
  for (const body of [
    '<rss><channel><item><title>broken</title>',
    '<rss><channel><item><title>broken</title></channel></item></rss>',
  ]) {
    const searchAdapter = createPublicContactSearchAdapter(async () => ({
      url: 'https://www.bing.com/search', status: 200, contentType: 'application/rss+xml', body,
    }))
    const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [],
      claimContactBudget: claim, now, searchAdapter,
      fetcher: fixture({ 'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>' }) })
    assert.deepEqual([result.status, result.completed, result.failureCode],
      ['unknown', false, 'contact_research_temporary_failure'])
  }
})

test('search fallback verifies an official Contact page instead of trusting the result', async () => {
  const queries: string[] = []
  const claims: ContactClaimDescriptor[] = []
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [],
    claimContactBudget: async key => { claims.push(key); return 'claimed' }, now,
    searchAdapter: { search: async query => { queries.push(query); return query.endsWith(' contact')
      ? [{ url: 'https://opencage.example/contact', title: 'Contact' }] : [] } },
    fetcher: fixture({
      'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>',
      'https://opencage.example/contact': '<h1>OpenCage Fixture contact</h1><a href="mailto:business@opencage.example">Business</a>',
    }) })
  assert.equal(queries.length, 1)
  assert.deepEqual(claims.map(item => item.operation), ['page', 'search', 'verify'])
  assert.deepEqual(claims.map(item => item.value), [
    'https://opencage.example/', '"OpenCage Fixture" contact', 'https://opencage.example/contact',
  ])
  assert.equal(result.status, 'verified_email')
  assert.equal(result.preferredEmail, 'business@opencage.example')
  assert.equal(result.evidence[0]?.sourceUrl, 'https://opencage.example/contact')
})

test('search rejects third-party directories and same-name GitHub identities without continuity', async () => {
  for (const url of ['https://directory.example/opencage', 'https://github.com/opencage-lookalike']) {
    const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
      searchAdapter: { search: async query => query.endsWith(' contact') ? [{ url, title: 'OpenCage contact' }] : [] },
      fetcher: fixture({
        'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>',
        'https://github.com/opencage-lookalike': '<h1>OpenCage Fixture</h1><a href="mailto:sales@lookalike.example">Sales</a>',
      }) })
    assert.equal(result.status, 'contact_unavailable')
    assert.equal(result.evidence.length, 0)
  }
})

test('search-discovered GitHub requires exact provider-domain continuity before accepting contact', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: { search: async query => query.endsWith(' GitHub')
      ? [{ url: 'https://github.com/opencage-official', title: 'OpenCage GitHub' }] : [] },
    fetcher: fixture({
      'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>',
      'https://github.com/opencage-official': '<h1>OpenCage Fixture</h1><a href="https://opencage.example/">Website</a><a href="mailto:api-team@example.net">API team</a>',
    }) })
  assert.equal(result.status, 'verified_email')
  assert.equal(result.preferredEmail, 'api-team@example.net')
  assert.equal(result.evidence[0]?.sourceType, 'official_github')
})

test('search failure, timeout, ambiguity, and budget exhaustion remain retryable unknown', async () => {
  const basePages = { 'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>' }
  for (const error of [new Error('search unavailable'), new Error('discovery_timeout')]) {
    const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
      searchAdapter: { search: async () => { throw error } }, fetcher: fixture(basePages) })
    assert.deepEqual([result.status, result.completed], ['unknown', false])
  }
  const ambiguous = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch, fetcher: fixture({ 'https://opencage.example/': '<h1>Unrelated parked domain</h1>' }) })
  assert.deepEqual([ambiguous.status, ambiguous.failureCode], ['unknown', 'contact_identity_ambiguous'])
  let claims = 0
  const exhausted = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], now,
    claimContactBudget: async () => ++claims === 1 ? 'claimed' : 'exhausted', searchAdapter: noSearch,
    fetcher: fixture(basePages) })
  assert.deepEqual([exhausted.status, exhausted.failureCode], ['unknown', 'contact_budget_exhausted'])
})

test('successful search with no usable results is unavailable', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch, fetcher: fixture({ 'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>' }) })
  assert.deepEqual([result.status, result.completed, result.failureCode], ['contact_unavailable', true, null])
})

test('security, privacy, abuse, legal, DMCA, and compliance addresses never become outreach-ready', async () => {
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], claimContactBudget: claim, now,
    searchAdapter: noSearch, fetcher: fixture({ 'https://opencage.example/': `<h1>OpenCage Fixture</h1>
      <a href="mailto:security@opencage.example">Security</a><a href="mailto:privacy@opencage.example">Privacy</a>
      <a href="mailto:abuse@opencage.example">Report abuse</a><a href="mailto:legal@opencage.example">Legal</a>
      <a href="mailto:dmca@opencage.example">DMCA</a><a href="mailto:compliance@opencage.example">Compliance</a>` }) })
  assert.equal(result.status, 'contact_unavailable')
  assert.equal(result.emailReady, false)
  assert.equal(result.preferredEmail, null)
  assert.ok(result.evidence.every(item => ['security', 'privacy', 'legal'].includes(item.purpose)))
  assert.ok(result.evidence.every(item => !item.preferred))
  assert.ok(result.evidence.every(item => !item.emailReady))
})

test('remove.bg-style social URL text cannot become an email or contact channel', async () => {
  const socialLinks = [
    '//www.tiktok.com/@remove.bg', 'https://instagram.com/remove', 'https://x.com/remove',
    'https://twitter.com/remove', 'https://facebook.com/remove', 'https://youtube.com/@remove',
    'https://linkedin.com/company/remove',
  ]
  const result = await discoverProviderContacts({ candidate: { ...candidate, discoveredName: 'Remove Fixture' },
    normalizedDomain: 'remove.example', facts: [], claimContactBudget: claim, now, searchAdapter: noSearch,
    fetcher: fixture({ 'https://remove.example/': `<h1>Remove Fixture</h1>
      ${socialLinks.map(url => `<a href="${url}">Contact us</a>`).join('')}<p>//www.tiktok.com/@remove.bg</p>` }) })
  assert.equal(result.status, 'contact_unavailable')
  assert.equal(result.emailReady, false)
  assert.equal(result.preferredEmail, null)
  assert.equal(result.evidence.length, 0)
})

test('production false-positive pages do not satisfy contact intent without an outreach route', async () => {
  for (const [domain, name, path, body] of [
    ['selectpdf.example', 'SelectPDF Fixture', '/html-to-pdf-api/', '<title>HTML to PDF API</title><h1>HTML to PDF API</h1>'],
    ['spectrocoin.example', 'SpectroCoin Fixture', '/accept-bitcoin-payments.html', '<title>Accept Bitcoin Payments</title><h1>Business payments product</h1>'],
    ['spinitron.example', 'Spinitron Fixture', '/about/for-music-industry', '<title>For Music Industry</title><h1>Industry information</h1>'],
    ['sales.example', 'Sales Fixture', '/sales-automation', '<title>Sales Automation Platform</title><h1>Sales feature</h1>'],
  ] as const) {
    const url = `https://${domain}${path}`
    const result = await discoverProviderContacts({ candidate: { ...candidate, discoveredName: name, discoveredContactUrl: url },
      normalizedDomain: domain, facts: [], claimContactBudget: claim, now, searchAdapter: noSearch,
      fetcher: fixture({ [`https://${domain}/`]: `<h1>${name}</h1>`, [url]: body }) })
    assert.equal(result.status, 'contact_unavailable', url)
    assert.equal(result.evidence.length, 0, url)
  }
})

test('provider pages cannot promote third-party directories or articles as official contacts', async () => {
  for (const [domain, name, external, label] of [
    ['scideas.example', 'SCI Fixture', 'https://www.uksmallbusinessdirectory.co.uk/', 'UK Small Business Directory'],
    ['stoplight.example', 'Stoplight Fixture', 'https://biz.crast.net/low-code-and-no-code-pitfalls/', 'API Business Transformation'],
  ] as const) {
    let thirdPartyFetches = 0
    const result = await discoverProviderContacts({ candidate: { ...candidate, discoveredName: name }, normalizedDomain: domain,
      facts: [], claimContactBudget: claim, now, searchAdapter: noSearch, fetcher: async url => {
        if (url === external) thirdPartyFetches += 1
        return { url, status: 200, contentType: 'text/html',
          body: url === `https://${domain}/` ? `<h1>${name}</h1><a href="${external}">${label}</a>` : '<h1>Third party</h1>' }
      } })
    assert.equal(result.status, 'contact_unavailable', external)
    assert.equal(result.evidence.length, 0, external)
    assert.equal(thirdPartyFetches, 0, external)
  }
})

test('shorten.rest-style security-only email remains evidence but is never email-ready', async () => {
  const result = await discoverProviderContacts({ candidate: { ...candidate, discoveredName: 'Shorten Fixture' },
    normalizedDomain: 'shorten.example', facts: [], claimContactBudget: claim, now, searchAdapter: noSearch,
    fetcher: fixture({ 'https://shorten.example/': '<h1>Shorten Fixture</h1><a href="mailto:security@shorten.example">Security</a>' }) })
  assert.equal(result.status, 'contact_unavailable')
  assert.equal(result.emailReady, false)
  assert.equal(result.preferredEmail, null)
  assert.deepEqual(result.evidence.map(item => [item.value, item.purpose, item.preferred, item.emailReady]),
    [['security@shorten.example', 'security', false, false]])
})

test('search skips unrelated and generic results before spending verification claims', async () => {
  const claims: ContactClaimDescriptor[] = []
  let thirdPartyFetches = 0
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], now,
    claimContactBudget: async descriptor => { claims.push(descriptor); return 'claimed' },
    searchAdapter: { search: async query => query.endsWith(' contact') ? [
      { url: 'https://directory.example/opencage', title: 'OpenCage contact directory' },
      { url: 'https://opencage.example/blog/business-api', title: 'Business API article' },
      { url: 'https://opencage.example/contact', title: 'Contact OpenCage' },
    ] : [] }, fetcher: async url => {
      if (url.includes('directory.example')) thirdPartyFetches += 1
      return { url, status: 200, contentType: 'text/html', body: url.endsWith('/contact')
        ? '<h1>Contact OpenCage Fixture</h1><a href="mailto:team@opencage.example">Team</a>'
        : '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>' }
    } })
  assert.equal(result.preferredEmail, 'team@opencage.example')
  assert.deepEqual(claims.filter(item => item.operation === 'verify').map(item => item.value), ['https://opencage.example/contact'])
  assert.equal(thirdPartyFetches, 0)
})

test('claim replay and real budget exhaustion perform no external call and remain distinguishable', async () => {
  for (const [budget, expected] of [['replayed', 'contact_claim_replayed'], ['exhausted', 'contact_budget_exhausted']] as const) {
    let calls = 0
    const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], now,
      claimContactBudget: async () => budget, fetcher: async () => { calls += 1; throw new Error('unexpected') } })
    assert.equal(result.failureCode, expected)
    assert.equal(result.completed, false)
    assert.equal(calls, 0)
  }
})

test('same logical contact retry replays one stable key without another fetch or duplicate evidence', async () => {
  const claims = new Set<string>()
  let budgetIncrements = 0
  let fetches = 0
  const claimContactBudget = async (descriptor: ContactClaimDescriptor) => {
    const key = buildContactClaimKey({ scope: 'candidate', scopeId: CANDIDATE_ID, ...descriptor })
    if (claims.has(key)) return 'replayed' as const
    claims.add(key)
    budgetIncrements += 1
    return 'claimed' as const
  }
  const run = () => discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], now,
    claimContactBudget, fetcher: async url => {
      fetches += 1
      return { url, status: 200, contentType: 'text/html',
        body: '<h1>OpenCage Fixture</h1><a href="mailto:sales@opencage.example">Sales</a> sales@opencage.example' }
    } })
  const first = await run()
  const replay = await run()
  assert.equal(first.status, 'verified_email')
  assert.equal(first.evidence.filter(item => item.value === 'sales@opencage.example').length, 1)
  assert.equal(replay.failureCode, 'contact_claim_replayed')
  assert.equal(fetches, 1)
  assert.equal(budgetIncrements, 1)
  assert.equal(claims.size, 1)
})

test('search-claim replay does not repeat search work or become real exhaustion', async () => {
  let claims = 0
  let searches = 0
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [], now,
    claimContactBudget: async () => ++claims === 1 ? 'claimed' : 'replayed',
    searchAdapter: { search: async () => { searches += 1; return [] } },
    fetcher: fixture({ 'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>' }) })
  assert.equal(result.failureCode, 'contact_claim_replayed')
  assert.equal(result.completed, false)
  assert.equal(searches, 0)
})
