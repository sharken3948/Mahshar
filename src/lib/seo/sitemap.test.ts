import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toPublicSeoListing } from './listing'
import { buildFailureTolerantSitemap, buildSitemap, STATIC_PUBLIC_PATHS } from './sitemap'

const listing = toPublicSeoListing({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Public Data API',
  description: 'Returns public data.',
  category: 'Data',
  price_per_call: 0.1,
  payment_model: 'pay-per-call',
  is_active: true,
  auth_type: 'public',
  endpoint_url: 'https://upstream.example/data',
  method: 'GET',
  example_request: null,
  example_response: null,
  body_required: false,
  dynamic_path_supported: false,
  path_parameters: [],
  query_parameters: [],
  verified_at: null,
  created_at: '2026-09-29T00:00:00.000Z',
})

test('sitemap contains static public routes and active listing detail URLs', () => {
  assert.ok(listing)
  const urls = buildSitemap([listing]).map(entry => entry.url)
  for (const path of STATIC_PUBLIC_PATHS) {
    assert.ok(urls.includes(`https://mahshar.xyz${path}`), path)
  }
  assert.ok(urls.includes('https://mahshar.xyz/apis/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/public-data-api'))
})

test('sitemap does not include private application or API routes', () => {
  const urls = buildSitemap([]).map(entry => new URL(entry.url).pathname)
  for (const excluded of ['/admin', '/dashboard', '/buyer', '/seller', '/api']) {
    assert.equal(urls.some(path => path === excluded || path.startsWith(`${excluded}/`)), false, excluded)
  }
})

test('static sitemap remains complete when no dynamic listings are available', () => {
  assert.equal(buildSitemap([]).length, STATIC_PUBLIC_PATHS.length)
})

test('a rejected listing reader still returns the complete static sitemap', async () => {
  const sitemap = await buildFailureTolerantSitemap(async () => { throw new Error('database unavailable') })
  assert.deepEqual(sitemap.map(entry => entry.url), STATIC_PUBLIC_PATHS.map(path => `https://mahshar.xyz${path}`))
})
