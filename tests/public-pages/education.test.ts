import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { aboutMetadata, providersMetadata } from '../../src/lib/seo/education-metadata'

const read = (path: string) => readFileSync(path, 'utf8')
const educationPages = [
  ['src/app/about/page.tsx', '/about'],
  ['src/app/providers/page.tsx', '/providers'],
] as const

test('education pages export their directly verified route metadata', () => {
  const expected = [
    [educationPages[0], aboutMetadata, 'About Mahshar'],
    [educationPages[1], providersMetadata, 'For API Providers | Mahshar'],
  ] as const
  for (const [[path, canonical], metadata, title] of expected) {
    const source = read(path)
    assert.match(source, /export const metadata: Metadata/)
    assert.equal(metadata.title, title)
    assert.ok(metadata.description.length > 0)
    assert.equal(metadata.alternates.canonical, canonical)
    assert.equal(metadata.openGraph.url, canonical)
    assert.equal(metadata.openGraph.title, title)
    assert.ok(metadata.openGraph.description.length > 0)
    assert.equal(metadata.twitter.title, title)
    assert.ok(metadata.twitter.description.length > 0)
  }
})

test('education pages are server-rendered public content with no application dependencies', () => {
  for (const [path] of educationPages) {
    const source = read(path)
    assert.match(source, /<PublicPageShell>/)
    assert.equal((source.match(/<h1>/g) ?? []).length, 1, `${path}: one H1`)
    for (const forbidden of [
      /['"]use client['"]/, /useAccount/, /useMarketplaceSession/, /gateway\/balance/,
      /useVisibilityRefresh/, /pollBalance/, /createServiceClient/, /supabase/, /fetch\(/,
    ]) assert.doesNotMatch(source, forbidden, `${path}: ${forbidden}`)
  }
})

test('public and application Explore navigation contain the exact ordered public routes', () => {
  const publicNav = read('src/components/PublicOnlyNav.tsx')
  const appNav = read('src/components/NavBar.tsx')
  const footer = read('src/components/PublicSiteFooter.tsx')
  const expected = ['/marketplace', '/providers', '/agents', '/docs', '/about', '/support']
  const labels = ['Marketplace', 'For API Providers', 'Agents', 'Docs', 'About', 'Support']

  const publicLinks = publicNav.slice(publicNav.indexOf('const publicLinks'), publicNav.indexOf('] as const'))
  assert.deepEqual([...publicLinks.matchAll(/href: '([^']+)'/g)].map(match => match[1]), expected)
  assert.deepEqual([...publicLinks.matchAll(/label: '([^']+)'/g)].map(match => match[1]), labels)

  assert.deepEqual([...footer.matchAll(/<Link href="([^"]+)">([^<]+)<\/Link>/g)].map(match => [match[1], match[2]]), expected.map((route, index) => [route, labels[index]]))

  const mobileStart = appNav.indexOf('id="mahshar-mobile-explore"')
  const mobile = appNav.slice(mobileStart, appNav.indexOf('</div>}', mobileStart))
  assert.deepEqual([...mobile.matchAll(/href="([^"]+)"/g)].map(match => match[1]), expected)

  const desktopStart = appNav.indexOf('id="landing-explore-menu"')
  const desktop = appNav.slice(desktopStart, appNav.indexOf('</div>\n      )}', desktopStart))
  assert.deepEqual([...desktop.matchAll(/href="([^"]+)"/g)].map(match => match[1]), expected)
})

test('homepage buyer CTA remains on the wallet-enabled buyer application', () => {
  const home = read('src/app/page.tsx')
  assert.match(home, /href="\/buyer"[^>]*>Buy in Marketplace/)
  assert.match(home, /href="\/about"[^>]*>About Mahshar/)
  assert.doesNotMatch(home, />Learn more</)
})

test('education copy avoids affiliation, guarantees, and transient ecosystem statistics', () => {
  const source = educationPages.map(([path]) => read(path)).join('\n')
  for (const unsupported of [
    /Mahshar is (?:an )?official (?:Circle )?partner/i, /Circle-endorsed Mahshar/i, /guaranteed revenue/i,
    /zero integration/i, /\d+\+ (?:services|endpoints|APIs)/i, /market share/i,
  ]) assert.doesNotMatch(source, unsupported)
})

test('provider copy scopes credential, discovery, and listing-control guarantees to implemented boundaries', () => {
  const about = read('src/app/about/page.tsx')
  const providers = read('src/app/providers/page.tsx')
  const source = `${about}\n${providers}`
  assert.doesNotMatch(source, /credentials? (?:are |is )?not returned to buyers|stay behind the Marketplace boundary|Expose stored seller credentials to buyers/i)
  assert.match(source, /(?:not included|omitted) (?:in|from) public discovery (?:or|and) buyer-facing listing data/)
  assert.match(providers, /Eligible active listings can appear through Mahshar’s machine-readable agent discovery\./)
  assert.match(providers, /The OpenAPI document describes how clients use Mahshar’s public machine interface\./)
  assert.match(providers, /machine-readable discovery for eligible active listings, plus an OpenAPI description/)
  assert.match(providers, /Activation remains subject to Mahshar’s verification and marketplace health safeguards\./)
})

test('public trust surface exposes verifiable product-first evidence without identity claims', () => {
  const trust = read('src/components/PublicTrustPanel.tsx')
  const footer = read('src/components/PublicSiteFooter.tsx')
  for (const value of [
    'Arc Mainnet', 'Chain ID 5042', 'https://github.com/sharken3948/Mahshar',
    'support@mahshar.xyz', '0x052650D1764406d702252B20B2294346A594A1ef',
    '0xa3efb83ad9ac4f2164d36b2579104cb7fb19c986cd623206b27387330e33fa33',
  ]) assert.ok(trust.includes(value), value)
  assert.match(trust, /not operated by, endorsed by, or part of Circle/)
  assert.match(trust, /PUBLIC REFERENCES/)
  assert.match(trust, /Public product references, in one place\./)
  assert.match(trust, /PRODUCTION NETWORK/)
  assert.doesNotMatch(trust, /PRODUCT TRUST|LIVE NETWORK|independently verifiable|one public network reference/)
  assert.equal((trust.match(/aria-label=/g) ?? []).length, 3)
  for (const path of ['src/app/page.tsx', 'src/app/about/page.tsx', 'src/app/providers/page.tsx']) {
    assert.match(read(path), /<PublicTrustPanel \/>/, path)
  }
  assert.match(footer, />GitHub<\/a>/)
  assert.match(footer, />Arc verification<\/a>/)
  assert.equal((footer.match(/aria-label=/g) ?? []).length, 3)
  assert.doesNotMatch(trust, /founder|team size|headquarters|incorporat|official partner|security audit/i)
})
