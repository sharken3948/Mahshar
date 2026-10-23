import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { reset, sessionHeaders, state, alice } from '../marketplace/fixtures'
import { resetBoundary, boundary } from './register.mjs'
import { PATCH } from '../../src/app/api/apis/[id]/route'
import { POST as create } from '../../src/app/api/apis/route'
import { AUTH_BUNDLE_EXAMPLES } from '../../src/lib/marketplace/provider-auth-config'

const origin = 'https://mahshar.xyz'
const id = 'size-fixture'
const context = { params: Promise.resolve({ id }) }
const base = { id, name: 'Size fixture', description: 'Synthetic', category: 'Data', price_per_call: 0.01,
  payment_model: 'pay-per-call', seller_wallet: alice.address.toLowerCase(), endpoint_url: 'https://provider.example/data',
  auth_type: 'public', method: 'GET', is_active: false, verified_at: null }
beforeEach(() => { reset(); resetBoundary(); state.tables.api_listings.push({ ...base }) })
const request = (body: string, extra: Record<string, string> = {}) => new NextRequest(origin + '/api/apis/' + id,
  { method: 'PATCH', headers: { ...sessionHeaders(), 'content-type': 'application/json', ...extra }, body })

test('Edit accepts exactly 64 KiB and rejects a larger body before any mutation', async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ example_response: '' }))
  const body = JSON.stringify({ example_response: 'x'.repeat(65536 - overhead) })
  assert.equal(Buffer.byteLength(body), 65536)
  assert.equal((await PATCH(request(body), context)).status, 200)
  const previous = structuredClone(state.tables.api_listings)
  assert.equal((await PATCH(request(body.replace('xxx', 'xxxx')), context)).status, 413)
  assert.deepEqual(state.tables.api_listings, previous)
  assert.equal(boundary.requests.length, 0)
})

test('Edit bounds UTF-8 bytes and streamed bodies without trusting Content-Length', async () => {
  const body = JSON.stringify({ example_response: '😀'.repeat(17000) })
  assert.ok(body.length < 65536 && Buffer.byteLength(body) > 65536)
  assert.equal((await PATCH(request(body, { 'content-length': '1' }), context)).status, 413)
  const payload = new TextEncoder().encode(body)
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(payload.slice(0, 32768)); controller.enqueue(payload.slice(32768)); controller.close()
  } })
  const streamed = new NextRequest(origin + '/api/apis/' + id, { method: 'PATCH', headers: sessionHeaders(),
    body: stream, duplex: 'half' } as RequestInit)
  assert.equal((await PATCH(streamed, context)).status, 413)
  assert.equal(state.tables.api_listings[0].example_response, undefined)
})

test('large legacy examples do not prevent compact metadata, availability or price edits', async () => {
  state.tables.api_listings[0].example_response = 'large-example-'.repeat(10000)
  for (const patch of [{ name: 'Renamed' }, { price_per_call: 0.02 }, { is_active: false }]) {
    assert.equal((await PATCH(request(JSON.stringify(patch)), context)).status, 200)
  }
  assert.equal(state.tables.api_listings[0].example_response.length, 140000)
})

test('supported static credential bundles plus a 32 KiB schema fit Seller Create', async () => {
  for (const [auth_type, auth_key] of Object.entries(AUTH_BUNDLE_EXAMPLES).filter(([type]) => !type.startsWith('oauth_'))) {
    const body = JSON.stringify({ ...base, id: undefined, auth_type, auth_key,
      request_schema: { type: 'object', description: 'd'.repeat(31000) } })
    assert.ok(Buffer.byteLength(body) < 65536)
    const response = await create(new NextRequest(origin + '/api/apis', {
      method: 'POST', headers: sessionHeaders(), body,
    }))
    assert.equal(response.status, 201, await response.text())
  }
})

test('a formerly unbounded large example replacement is explicitly rejected with 413', async () => {
  // Deliberate API limit, recorded as a rollout compatibility limitation.
  const response = await PATCH(request(JSON.stringify({ example_response: 'x'.repeat(70000) })), context)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error, 'Invalid or oversized request body')
})
