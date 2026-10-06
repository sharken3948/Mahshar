import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverProviderContacts } from './contact'
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
  const claims: string[] = []
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'opencage.example', facts: [],
    claimContactBudget: async key => { claims.push(key); return 'claimed' }, now,
    searchAdapter: { search: async query => { queries.push(query); return query.endsWith(' contact')
      ? [{ url: 'https://opencage.example/contact', title: 'Contact' }] : [] } },
    fetcher: fixture({
      'https://opencage.example/': '<h1>OpenCage Fixture</h1><p>Geocoding API.</p>',
      'https://opencage.example/contact': '<h1>OpenCage Fixture contact</h1><a href="mailto:business@opencage.example">Business</a>',
    }) })
  assert.equal(queries.length, 1)
  assert.deepEqual(claims.map(key => key.split(':')[0]), ['page', 'search', 'verify'])
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
