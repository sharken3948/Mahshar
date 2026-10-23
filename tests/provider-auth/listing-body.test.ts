import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_LISTING_BODY_BYTES, LISTING_BODY_LIMIT_MESSAGE, serializeListingBody, listingResponseError } from '../../src/lib/marketplace/listing-body'

test('Seller request preflight uses the same UTF-8 ceiling as Create and Edit', () => {
  const overhead = new TextEncoder().encode(JSON.stringify({ example_response: '' })).byteLength
  const exact = { example_response: 'x'.repeat(MAX_LISTING_BODY_BYTES - overhead) }
  assert.equal(new TextEncoder().encode(serializeListingBody(exact)).byteLength, 65536)
  assert.throws(() => serializeListingBody({ example_response: exact.example_response + 'x' }), { message: LISTING_BODY_LIMIT_MESSAGE })
  assert.throws(() => serializeListingBody({ example_response: '😀'.repeat(17000) }), { message: LISTING_BODY_LIMIT_MESSAGE })
  assert.equal(listingResponseError(413, 'generic server error'), LISTING_BODY_LIMIT_MESSAGE)
  assert.equal(listingResponseError(409, 'Reload listing'), 'Reload listing')
})
