import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiListingCanonicalUrl,
  apiListingPath,
  isValidListingId,
  listingRouteDecision,
  SEO_CATEGORY_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_NAME_MAX_LENGTH,
  slugifyListingName,
  toPublicSeoListing,
} from './listing'

const activeListing = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'ÍoScope Wallet Risk / Scoring',
  description: 'Scores wallet risk from public chain data.',
  category: 'Risk',
  price_per_call: 0.25,
  payment_model: 'pay-per-call',
  score: 92,
  uptime: 99.9,
  is_active: true,
  seller_wallet: '0x' + '11'.repeat(20),
  auth_type: 'apikey',
  auth_param_name: null,
  encrypted_key: 'must-never-leave-the-reader',
  endpoint_url: 'https://upstream.example/private',
  method: 'POST',
  example_request: '{"wallet":"0xabc","api_key":"source-only-request-secret"}',
  example_response: '{"authorization":"Bearer source-only-response-secret"}',
  request_schema: {
    type: 'object',
    properties: {
      wallet: { type: 'string' },
      api_key: { type: 'string', description: 'source-only-request-schema-secret' },
    },
    required: ['wallet', 'api_key'],
    additionalProperties: false,
  },
  response_schema: { privateExample: 'source-only-response-schema-secret' },
  body_required: true,
  dynamic_path_supported: false,
  path_parameters: [],
  query_parameters: [{ name: 'region', type: 'string', required: false, description: 'source-only-parameter-secret' }],
  expected_status_codes: [200],
  verified_at: '2026-09-30T00:00:00.000Z',
  created_at: '2026-09-29T00:00:00.000Z',
}

test('listing slugs are deterministic, ASCII-safe, collapsed, trimmed, and have a fallback', () => {
  assert.equal(slugifyListingName(activeListing.name), 'ioscope-wallet-risk-scoring')
  assert.equal(slugifyListingName('  API---With   Gaps  '), 'api-with-gaps')
  assert.equal(slugifyListingName('東京'), 'api')
  assert.match(slugifyListingName('Café + Data'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('canonical listing paths retain the durable ID and current name slug', () => {
  const listing = toPublicSeoListing(activeListing)
  assert.ok(listing)
  assert.equal(apiListingPath(listing), '/apis/11111111-2222-3333-4444-555555555555/ioscope-wallet-risk-scoring')
  assert.equal(apiListingCanonicalUrl(listing), 'https://mahshar.xyz/apis/11111111-2222-3333-4444-555555555555/ioscope-wallet-risk-scoring')
})

test('wrong slugs permanently resolve toward the current canonical location', () => {
  const listing = toPublicSeoListing(activeListing)
  assert.ok(listing)
  assert.deepEqual(listingRouteDecision(listing, 'old-name'), {
    kind: 'redirect',
    location: '/apis/11111111-2222-3333-4444-555555555555/ioscope-wallet-risk-scoring',
  })
  assert.deepEqual(listingRouteDecision(listing, 'ioscope-wallet-risk-scoring'), { kind: 'render' })
  assert.deepEqual(listingRouteDecision(null, 'anything'), { kind: 'not-found' })
})

test('inactive and invalid-contract listings are not eligible for SEO pages', () => {
  assert.equal(toPublicSeoListing({ ...activeListing, is_active: false }), null)
  assert.equal(toPublicSeoListing({ ...activeListing, endpoint_url: 'not-a-url' }), null)
  assert.equal(toPublicSeoListing({ ...activeListing, method: 'PATCH' }), null)
})

test('only pay-per-call listings with bounded public strings are SEO eligible', () => {
  assert.equal(toPublicSeoListing({ ...activeListing, payment_model: 'credits' }), null)
  assert.equal(toPublicSeoListing({ ...activeListing, payment_model: 'both' }), null)
  assert.equal(toPublicSeoListing({ ...activeListing, name: 'n'.repeat(SEO_NAME_MAX_LENGTH + 1) }), null)
  assert.equal(toPublicSeoListing({ ...activeListing, description: 'd'.repeat(SEO_DESCRIPTION_MAX_LENGTH + 1) }), null)
  assert.equal(toPublicSeoListing({ ...activeListing, category: 'c'.repeat(SEO_CATEGORY_MAX_LENGTH + 1) }), null)
})

test('listing IDs use canonical UUID syntax before an SEO detail lookup', () => {
  assert.equal(isValidListingId(activeListing.id), true)
  assert.equal(isValidListingId('not-a-uuid'), false)
  assert.equal(isValidListingId('11111111222233334444555555555555'), false)
})

test('public SEO DTO is flat and omits credentials, examples, schemas, and parameter metadata', () => {
  const listing = toPublicSeoListing(activeListing)
  assert.ok(listing)
  const serialized = JSON.stringify(listing)
  for (const prohibited of [
    'endpoint_url', 'upstream.example', 'encrypted_key', 'must-never-leave', 'auth_param_name',
    'source-only-request-secret', 'source-only-response-secret', 'source-only-request-schema-secret',
    'source-only-response-schema-secret', 'source-only-parameter-secret', 'exampleRequest', 'requestSchema',
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited)
  }
  assert.equal(Object.values(listing).some(value => value !== null && typeof value === 'object'), false)
  assert.deepEqual(Object.keys(listing).sort(), [
    'authType', 'category', 'description', 'id', 'method', 'name', 'paymentModel',
    'pricePerCall', 'score', 'verified',
  ].sort())
})
