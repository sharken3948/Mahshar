import assert from 'node:assert/strict'
import { test } from 'node:test'
import saved from './fixtures/contact-official-saved.json'
import { discoverProviderContacts } from '../../src/lib/admin-worker/discovery/contact'
import { contactResearchDue } from '../../src/lib/admin-worker/contact-coverage'
import type { RawCandidate } from '../../src/lib/admin-worker/discovery/types'
import type { DiscoveryFetcher } from '../../src/lib/admin-worker/discovery/fetch'

const now = () => '2026-10-15T12:00:00Z'
const candidate: RawCandidate = { sourceType: 'api_directory', sourceUrl: 'https://directory.example/api',
  discoveredName: 'Fixture', discoveredDomain: 'fixture.example', discoveredProduct: 'API' }
const claimContactBudget = async () => 'claimed' as const
const fixture = (pages: Record<string, string>): DiscoveryFetcher => async url => ({ url,
  status: pages[url] === undefined ? 404 : 200, body: pages[url] ?? '', contentType: 'text/html' })
const research = (pages: Record<string, string>) => discoverProviderContacts({ candidate,
  normalizedDomain: 'fixture.example', facts: [], claimContactBudget, now, fetcher: fixture(pages), searchAdapter: { search: async () => [] } })

for (const page of saved) test(`saved official evidence recovers ${page.domain} without network or inference`, async () => {
  const root = `https://${page.domain}/`
  const result = await discoverProviderContacts({ candidate: { ...candidate, discoveredDomain: page.domain,
    discoveredName: page.domain, discoveredContactUrl: page.source_url }, normalizedDomain: page.domain,
    facts: [{ sourceType: 'website', sourceRole: 'official_contact', url: page.source_url, checkedAt: now() }],
    claimContactBudget, now, searchAdapter: { search: async () => { throw new Error('Email evidence should avoid search') } },
    fetcher: fixture({ [root]: `<h1>${page.domain}</h1>`, [page.source_url]: page.html }) })
  assert.equal(result.status, 'verified_email')
  assert.equal(result.preferredEmail, page.expected_email)
  assert.equal(result.evidence.filter(e => e.value === page.expected_email).length, 1)
  assert.equal(result.evidence.find(e => e.value === page.expected_email)?.sourceUrl, page.source_url)
})

test('explicit entities, mailto encoding and at/dot obfuscation decode without guessing', async () => {
  const result = await research({ 'https://fixture.example/': `<h1>Fixture</h1>
    <a href="mailto:sales%40fixture.example?subject=Pricing">Sales</a>
    <p>sales &#64; fixture&#46;example</p><p>support [at] fixture [dot] example</p>
    <p>team (at) fixture (dot) example</p><p>business @ fixture . example</p>` })
  assert.deepEqual(result.evidence.filter(e => e.type === 'email').map(e => e.value).sort(),
    ['business@fixture.example', 'sales@fixture.example', 'support@fixture.example', 'team@fixture.example'])
  assert.equal(result.preferredEmail, 'business@fixture.example')
})

test('untrusted identities, executable/commented text, malformed encoding and prose never create an email', async () => {
  const result = await research({ 'https://fixture.example/': `<h1>Fixture</h1>
    <script>const email='sales@fixture.example'; fetch('/send')</script>
    <!-- support@fixture.example --><template>team@fixture.example</template>
    <a href="mailto:%0Asales%40fixture.example">Sales</a><a href="mailto:%ZZ">Contact</a>
    <p>hello at fixture dot example</p><p>sales [at] attacker.example</p>
    <span data-cfemail="ffffff0">invalid</span><a href="javascript:alert('sales@fixture.example')">Contact</a>` })
  assert.equal(result.emailReady, false)
  assert.equal(result.preferredEmail, null)
  assert.equal(result.evidence.filter(e => e.type === 'email').length, 0)
  const impostor = await discoverProviderContacts({ candidate, normalizedDomain: 'fixture.example', facts: [], claimContactBudget, now,
    searchAdapter: { search: async () => [{ url: 'https://directory.example/contact', title: 'Fixture sales' }] },
    fetcher: async url => ({ url: url === 'https://fixture.example/' ? 'https://attacker.example/contact' : url,
      status: 200, contentType: 'text/html', body: '<h1>Fixture</h1>sales@fixture.example' }) })
  assert.equal(impostor.emailReady, false)
})

test('security, privacy and legal mailboxes remain ineligible contact evidence', async () => {
  const result = await research({ 'https://fixture.example/': '<h1>Fixture</h1>security [at] fixture.example privacy @ fixture.example legal&#64;fixture.example' })
  assert.equal(result.emailReady, false)
  assert.ok(result.evidence.every(e => !e.emailReady && !e.preferred))
  const ambiguous = await research({ 'https://fixture.example/': '<h1>Fixture</h1><a href="mailto:reports@fixture.example">Security reports only</a><p>reports@fixture.example</p>' })
  assert.equal(ambiguous.emailReady, false)
})

test('published structured contacts survive without evaluating scripts or extending sentence punctuation', async () => {
  const result = await research({ 'https://fixture.example/': `<h1>Fixture</h1><p>Write to info@fixture.example. View details.</p>
    <meta itemprop="email" content="sales@fixture.example">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","contactPoint":{"@type":"ContactPoint","email":"partners@fixture.example"}}</script>
    <script>const email = "guessed@fixture.example"</script>` })
  assert.deepEqual(result.evidence.filter(e => e.type === 'email').map(e => e.value).sort(),
    ['info@fixture.example', 'partners@fixture.example', 'sales@fixture.example'])
})

test('unquoted official contact navigation is prioritized ahead of crowded documentation links', async () => {
  const result = await research({ 'https://fixture.example/': '<h1>Fixture</h1>'
    + Array.from({ length: 120 }, (_, i) => `<a href="/docs/${i}">Developer</a>`).join('') + '<a href=/contact>Contact</a>',
    'https://fixture.example/contact': '<h1>Fixture contact</h1><a href=mailto:sales%40fixture.example>Sales</a>' })
  assert.equal(result.preferredEmail, 'sales@fixture.example')
})

test('repeated contact links cannot consume the page slots needed for About-page email evidence', async () => {
  const result = await research({ 'https://fixture.example/': '<h1>Fixture</h1>'
    + '<a href="/contact">Contact</a>'.repeat(20) + '<a href="/about">About us</a>',
    'https://fixture.example/contact': '<h1>Contact Fixture</h1>',
    'https://fixture.example/about': '<h1>Fixture</h1>support @ fixture.example' })
  assert.equal(result.preferredEmail, 'support@fixture.example')
})

test('a form page does not stop bounded search for an official email', async () => {
  let searches = 0
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'fixture.example', facts: [], claimContactBudget, now,
    fetcher: fixture({ 'https://fixture.example/': '<h1>Fixture</h1><a href="/contact">Contact</a>',
      'https://fixture.example/contact': '<form><input type="email"><textarea name="message"></textarea></form>',
      'https://fixture.example/contact-sales': '<h1>Fixture sales</h1>sales @ fixture.example' }),
    searchAdapter: { search: async () => { searches++; return [{ url: 'https://fixture.example/contact-sales', title: 'Contact sales' }] } } })
  assert.equal(result.preferredEmail, 'sales@fixture.example')
  assert.equal(searches, 1)
  assert.equal(result.evidence.find(e => e.value.endsWith('/contact'))?.formState, 'available')
})

test('actual contact forms distinguish available, CAPTCHA and opaque embedded manual routes', async () => {
  for (const [extra, expected] of [['', 'available'], ['<input name="captcha">', 'manual_required']] as const) {
    const result = await research({ 'https://fixture.example/': `<h1>Fixture</h1><form><input type="email"><textarea name="message"></textarea>${extra}</form>` })
    assert.equal(result.evidence.find(e => e.type !== 'email')?.formState, expected)
    assert.equal(result.emailReady, false)
  }
  const embed = await research({ 'https://fixture.example/': '<h1>Fixture</h1><div data-tf-live="official-widget"></div>' })
  assert.equal(embed.evidence[0]?.formState, 'manual_required')
  const page = await research({ 'https://fixture.example/': '<h1>Fixture</h1><a href="/contact">Contact</a>',
    'https://fixture.example/contact': '<h1>Contact Fixture</h1><form><input type="email" name="newsletter"></form>' })
  assert.ok(page.evidence.every(e => e.formState === undefined))
})

test('page/search/verification budgets are unchanged and duplicate URLs are fetched once', async () => {
  const requests: string[] = [], claims: string[] = []
  const result = await discoverProviderContacts({ candidate, normalizedDomain: 'fixture.example', facts: [], now,
    claimContactBudget: async c => { claims.push(c.operation); return 'claimed' },
    fetcher: async url => { requests.push(url); return { url, status: 200, contentType: 'text/html',
      body: '<h1>Fixture</h1>' + Array.from({ length: 50 }, (_, n) => `<a href="/contact/${n}">Contact</a>`).join('') } },
    searchAdapter: { search: async (_, limit) => {
      assert.equal(limit, 3)
      return Array.from({ length: 100 }, (_, n) => ({ url: `https://fixture.example/contact/search-${n}`, title: 'Contact' }))
    } } })
  assert.equal(result.emailReady, false)
  assert.ok(claims.filter(c => c === 'page').length <= 6)
  assert.equal(claims.filter(c => c === 'search').length, 6)
  assert.ok(claims.filter(c => c === 'verify').length <= 4)
  assert.equal(new Set(requests).size, requests.length)
})

test('freshness rechecks commercial no-email evidence after seven days, others after thirty, unresolved after one', () => {
  const at = Date.parse(now())
  const checked = (days: number) => new Date(at - days * 86_400_000).toISOString()
  assert.equal(contactResearchDue({ commercial_api: true, contact_researched_at: checked(7) }, at), true)
  assert.equal(contactResearchDue({ commercial_api: true, contact_research_state: 'no_contact_found', contact_checked_at: checked(6) }, at), false)
  assert.equal(contactResearchDue({ commercial_api: true, contact_checked_at: checked(0) }, at), true)
  assert.equal(contactResearchDue({ commercial_api: false, contact_checked_at: checked(29) }, at), false)
  assert.equal(contactResearchDue({ commercial_api: false, contact_checked_at: checked(30) }, at), true)
  assert.equal(contactResearchDue({ contact_research_state: 'unresolved', contact_checked_at: checked(1) }, at), true)
  assert.equal(contactResearchDue({ email_ready: true, contact_checked_at: checked(100) }, at), true)
  assert.equal(contactResearchDue({ email_ready: true, contact_checked_at: checked(29) }, at), false)
  assert.equal(contactResearchDue({ email_ready: true }, at), true)
  assert.equal(contactResearchDue({ contact_checked_at: 'invalid' }, at), true)
})
