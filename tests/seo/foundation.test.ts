import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('SEO public routes and isolated server catalog exist', () => {
  for (const path of [
    'src/app/marketplace/page.tsx',
    'src/app/apis/[id]/[slug]/page.tsx',
    'src/app/sitemap.ts',
    'src/lib/seo/public-catalog.ts',
  ]) assert.ok(existsSync(path), path)

  const catalog = read('src/lib/seo/public-catalog.ts')
  const buyerApi = read('src/app/api/apis/route.ts')
  assert.match(catalog, /import 'server-only'/)
  assert.match(catalog, /SEO_CATALOG_COLUMNS/)
  assert.match(catalog, /\.eq\('is_active', true\)/)
  assert.match(catalog, /toPublicSeoListing/)
  const detailReader = catalog.slice(catalog.indexOf('export async function getPublicSeoListing(id:'))
  assert.ok(detailReader.indexOf('if (!isValidListingId(id)) return null') < detailReader.indexOf('const supabase = await serviceClient()'))
  assert.doesNotMatch(catalog, /select\(['"]\*['"]\)/)
  assert.doesNotMatch(catalog, /encrypted_key/)
  assert.doesNotMatch(catalog, /error\.message/)
  assert.doesNotMatch(buyerApi, /lib\/seo\/public-catalog/)
})

test('public SEO shell and navigation contain no wallet, session, Gateway, or polling dependencies', () => {
  const shell = read('src/components/PublicPageShell.tsx')
  const navigation = read('src/components/PublicOnlyNav.tsx')
  assert.match(shell, /<PublicOnlyNav \/>/)
  assert.doesNotMatch(shell, /NavBar/)
  for (const source of [shell, navigation]) {
    assert.doesNotMatch(source, /useAccount|useMarketplaceSession|gateway\/balance|useVisibilityRefresh|pollBalance/)
  }
  for (const destination of ['/marketplace', '/about', '/providers', '/agents', '/docs', '/support', '/buyer']) {
    assert.ok(navigation.includes(`href: '${destination}'`) || navigation.includes(`href="${destination}"`), destination)
  }
  for (const route of ['marketplace', 'about', 'providers', 'agents', 'docs', 'support']) {
    assert.match(read(`src/app/${route}/page.tsx`), /<PublicPageShell>/)
  }
  assert.match(read('src/app/apis/[id]/[slug]/page.tsx'), /<PublicPageShell>/)
})

test('route-specific social metadata does not inherit homepage title, description, or URL', () => {
  const root = read('src/app/layout.tsx')
  const rootSocial = root.slice(root.indexOf('openGraph:'), root.indexOf('icons:'))
  assert.doesNotMatch(rootSocial, /title:|description:|url:\s*'\/'/)

  for (const [route, canonical] of [
    ['page', '/'], ['marketplace/page', '/marketplace'], ['agents/page', '/agents'],
    ['docs/page', '/docs'], ['support/page', '/support'],
  ] as const) {
    const source = read(`src/app/${route}.tsx`)
    assert.match(source, /openGraph:/)
    assert.match(source, /twitter:/)
    assert.ok(source.includes(`url: '${canonical}'`), canonical)
  }
  const education = read('src/lib/seo/education-metadata.ts')
  for (const canonical of ['/about', '/providers']) {
    assert.match(education, /openGraph:/)
    assert.match(education, /twitter:/)
    assert.ok(education.includes(`url: '${canonical}'`), canonical)
  }
})

test('SEO detail rendering contains no free-form example, schema, or parameter output', () => {
  const listing = read('src/lib/seo/listing.ts')
  const detail = read('src/app/apis/[id]/[slug]/page.tsx')
  for (const field of ['exampleRequest', 'exampleResponse', 'requestSchema', 'responseSchema', 'pathParameters', 'queryParameters']) {
    assert.doesNotMatch(listing, new RegExp(field), field)
    assert.doesNotMatch(detail, new RegExp(field), field)
  }
  assert.match(listing, /safe\.payment_model !== 'pay-per-call'/)
})

test('robots declares the sitemap without blocking application routes', () => {
  const robots = read('public/robots.txt')
  assert.match(robots, /^User-agent: \*$/m)
  assert.match(robots, /^Allow: \/$/m)
  assert.match(robots, /^Sitemap: https:\/\/mahshar\.xyz\/sitemap\.xml$/m)
  assert.doesNotMatch(robots, /^Disallow:/m)
})

test('dashboard, admin, buyer, and seller layouts explicitly noindex and nofollow', () => {
  for (const area of ['dashboard', 'admin', 'buyer', 'seller']) {
    const source = read(`src/app/${area}/layout.tsx`)
    assert.match(source, /robots:\s*\{\s*index: false, follow: false\s*\}/, area)
  }
})

test('public canonical metadata covers the intended indexable routes', () => {
  const routes = [
    ['src/app/page.tsx', '/'],
    ['src/app/marketplace/page.tsx', '/marketplace'],
    ['src/lib/seo/education-metadata.ts', '/about'],
    ['src/lib/seo/education-metadata.ts', '/providers'],
    ['src/app/agents/page.tsx', '/agents'],
    ['src/app/docs/page.tsx', '/docs'],
    ['src/app/support/page.tsx', '/support'],
  ] as const
  for (const [file, canonical] of routes) {
    assert.ok(read(file).includes(`canonical: '${canonical}'`), `${file}: ${canonical}`)
  }
})

test('homepage structured data is conservative and safely serialized', () => {
  const home = read('src/app/page.tsx')
  assert.match(home, /'@type': 'WebSite'/)
  assert.match(home, /'@type': 'Organization'/)
  assert.match(home, /JSON\.stringify\(jsonLd\)\.replace\(\/<\/g, '\\\\u003c'\)/)
  assert.doesNotMatch(home, /sameAs|foundingDate|address:/)
})

test('homepage buyer CTA remains on the established application journey', () => {
  const home = read('src/app/page.tsx')
  assert.match(home, /href="\/buyer"[^>]*>Buy in Marketplace/)
})
