import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BRAND_ICONS, HOME_DESCRIPTION, HOME_TITLE, MAHSHAR_NAME, MAHSHAR_ORIGIN, homepageStructuredData } from '../../src/lib/seo/brand'
import { aboutMetadata, providersMetadata } from '../../src/lib/seo/education-metadata'

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
  const website = homepageStructuredData['@graph'].find(entry => entry['@type'] === 'WebSite')
  const organization = homepageStructuredData['@graph'].find(entry => entry['@type'] === 'Organization')
  assert.equal(homepageStructuredData['@context'], 'https://schema.org')
  assert.deepEqual(website, { '@type': 'WebSite', name: MAHSHAR_NAME, url: MAHSHAR_ORIGIN })
  assert.deepEqual(organization, { '@type': 'Organization', name: MAHSHAR_NAME, url: MAHSHAR_ORIGIN, logo: `${MAHSHAR_ORIGIN}/logo.png` })
  assert.match(home, /JSON\.stringify\(homepageStructuredData\)\.replace\(\/<\/g, '\\\\u003c'\)/)
  assert.doesNotMatch(JSON.stringify(homepageStructuredData), /sameAs|foundingDate|address|contactPoint/)
})

test('homepage metadata is brand-first and describes the implemented marketplace', () => {
  assert.equal(HOME_TITLE, 'Mahshar | API Marketplace for AI Agents')
  assert.equal(HOME_DESCRIPTION, 'Mahshar is an API marketplace where AI agents and builders discover APIs and pay per call with USDC on Arc Mainnet.')
  assert.ok(HOME_DESCRIPTION.length <= 160)
  for (const term of ['API marketplace', 'AI agents', 'pay per call', 'USDC', 'Arc']) {
    assert.ok(HOME_DESCRIPTION.includes(term), term)
  }
  const home = read('src/app/page.tsx')
  assert.match(home, /title: HOME_TITLE/)
  assert.match(home, /description: HOME_DESCRIPTION/)
  assert.match(home, /alternates: \{ canonical: '\/' \}/)
  assert.match(home, /<h1/)
  assert.match(home, />MAHSHAR API MARKETPLACE<\/p>/)
})

test('primary public route titles are unique, concise, and branded', () => {
  const expected = new Map([
    ['src/app/marketplace/page.tsx', 'API Marketplace | Mahshar'],
    ['src/lib/seo/education-metadata.ts#about', 'About Mahshar'],
    ['src/lib/seo/education-metadata.ts#providers', 'For API Providers | Mahshar'],
    ['src/app/agents/page.tsx', 'AI Agents | Mahshar'],
    ['src/app/docs/page.tsx', 'Docs | Mahshar'],
    ['src/app/support/page.tsx', 'Support | Mahshar'],
  ])
  assert.equal(new Set(expected.values()).size, expected.size)
  for (const [target, title] of expected) {
    const path = target.split('#')[0]
    assert.ok(read(path).includes(`title: '${title}'`), `${target}: ${title}`)
    assert.ok(title.includes('Mahshar'), title)
  }
})

test('primary public route descriptions are useful and unique', () => {
  const sourceDescription = (path: string) => read(path).match(/description: '([^']+)'/)?.[1] ?? ''
  const descriptions = [
    HOME_DESCRIPTION,
    sourceDescription('src/app/marketplace/page.tsx'),
    String(providersMetadata.description),
    sourceDescription('src/app/agents/page.tsx'),
    sourceDescription('src/app/docs/page.tsx'),
    String(aboutMetadata.description),
    sourceDescription('src/app/support/page.tsx'),
  ]
  assert.equal(descriptions.length, 7)
  assert.equal(new Set(descriptions).size, descriptions.length)
  assert.ok(descriptions.every(description => description.length >= 60 && description.length <= 160))
})

test('favicon metadata declares each physical asset once per relation with its true dimensions', () => {
  const icon = readFileSync('public/icon.png')
  assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG')
  const width = icon.readUInt32BE(16)
  const height = icon.readUInt32BE(20)
  assert.deepEqual([width, height], [512, 512])
  assert.ok(existsSync('src/app/icon.png'))
  assert.deepEqual(BRAND_ICONS.icon, [{ url: '/icon.png', sizes: '512x512', type: 'image/png' }])
  assert.deepEqual(BRAND_ICONS.apple, [{ url: '/icon.png', sizes: '512x512', type: 'image/png' }])

  for (const declarations of [BRAND_ICONS.icon, BRAND_ICONS.apple]) {
    assert.equal(new Set(declarations.map(item => `${item.url}:${item.sizes}`)).size, declarations.length)
    for (const declaration of declarations) {
      const match = declaration.sizes.match(/^(\d+)x(\d+)$/)
      assert.ok(match)
      assert.deepEqual([Number(match[1]), Number(match[2])], [width, height])
    }
  }

  const layout = read('src/app/layout.tsx')
  assert.match(layout, /icons: BRAND_ICONS/)
  assert.doesNotMatch(layout, /192x192|32x32|16x16/)
})

test('intended public routes remain indexable while private application areas remain noindex', () => {
  for (const route of ['page', 'marketplace/page', 'providers/page', 'agents/page', 'docs/page', 'about/page', 'support/page']) {
    const source = read(`src/app/${route}.tsx`)
    assert.doesNotMatch(source, /noindex|index:\s*false|follow:\s*false/, route)
  }
  for (const area of ['dashboard', 'admin', 'buyer', 'seller']) {
    assert.match(read(`src/app/${area}/layout.tsx`), /robots:\s*\{\s*index: false, follow: false\s*\}/, area)
  }
})

test('homepage buyer CTA remains on the established application journey', () => {
  const home = read('src/app/page.tsx')
  assert.match(home, /href="\/buyer"[^>]*>Buy in Marketplace/)
})
