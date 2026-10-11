import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { POST } from '../../src/app/api/apis/route'
import { enforceRateLimit, rateLimitIdentities } from '../../src/lib/rate-limit'
import { alice, bob, origin, reset, sessionHeaders, state } from './fixtures'

const MAX_BODY_BYTES = 64 * 1024
const wallet = alice.address.toLowerCase()
const validBody = {
  name: 'Synthetic API',
  description: 'Synthetic listing used only by local tests',
  category: 'Data',
  price_per_call: 0.1,
  payment_model: 'pay-per-call',
  seller_wallet: wallet,
  auth_type: 'public',
  endpoint_url: 'https://provider.example/data',
  method: 'GET',
}

beforeEach(reset)

function rawRequest(body: BodyInit, extraHeaders: Record<string, string> = {}) {
  return new NextRequest(`${origin}/api/apis`, {
    method: 'POST',
    headers: { ...sessionHeaders(alice), 'content-type': 'application/json', ...extraHeaders },
    body,
    duplex: 'half',
  } as never)
}

function jsonRequest(body: unknown) {
  return rawRequest(JSON.stringify(body))
}

function bodyWithBytes(bytes: number) {
  const body = { ...validBody, example_response: '' }
  const fixedBytes = Buffer.byteLength(JSON.stringify(body))
  assert.ok(bytes >= fixedBytes)
  body.example_response = 'x'.repeat(bytes - fixedBytes)
  const serialized = JSON.stringify(body)
  assert.equal(Buffer.byteLength(serialized), bytes)
  return serialized
}

function inMemoryLimiter() {
  const counts = new Map<string, number>()
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const buckets = name === 'mahshar_take_rate_limits'
        ? args.p_buckets as Array<{ key_hash: string; limit: number }>
        : [{ key_hash: String(args.p_key_hash), limit: Number(args.p_limit) }]
      const results = buckets.map(bucket => {
        const count = (counts.get(bucket.key_hash) ?? 0) + 1
        counts.set(bucket.key_hash, count)
        return { allowed: count <= bucket.limit, remaining: Math.max(0, bucket.limit - count) }
      })
      return {
        data: [{
          allowed: results.every(result => result.allowed),
          remaining: Math.min(...results.map(result => result.remaining)),
          retry_after_seconds: 60,
        }],
        error: null,
      }
    },
  }
}

test('normal public and credentialed creations preserve success shape and remain inactive', async () => {
  const publicResponse = await POST(jsonRequest(validBody))
  assert.equal(publicResponse.status, 201)
  assert.deepEqual(Object.keys(await publicResponse.json()), ['id'])

  const credential = 'synthetic-provider-token'
  const credentialedResponse = await POST(jsonRequest({
    ...validBody,
    name: 'Credentialed API',
    auth_type: 'apikey',
    auth_key: credential,
    auth_param_name: 'X-API-Key',
    query_parameters: [{ name: 'limit', type: 'integer', minimum: 1, maximum: 100, example: 10 }],
    example_request: '{"limit":10}',
  }))
  assert.equal(credentialedResponse.status, 201)
  assert.equal(state.tables.api_listings.length, 2)
  assert.equal(state.tables.api_listings.every(row => row.is_active === false), true)
  assert.equal(state.tables.api_listings[1].encrypted_key === credential, false)
  assert.equal(JSON.stringify(await credentialedResponse.json()).includes(credential), false)
})

test('a valid payload immediately below 64 KiB is accepted', async () => {
  const response = await POST(rawRequest(bodyWithBytes(MAX_BODY_BYTES - 1)))
  assert.equal(response.status, 201)
  assert.equal(state.tables.api_listings.length, 1)
})

test('oversized Content-Length is rejected before body parsing or insertion', async () => {
  const response = await POST(rawRequest(JSON.stringify(validBody), { 'content-length': String(MAX_BODY_BYTES + 1) }))
  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { error: 'Request body too large' })
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)
})

test('an oversized chunked stream is cancelled and rejected without insertion', async () => {
  let cancelled = false
  const oversized = new TextEncoder().encode(bodyWithBytes(MAX_BODY_BYTES + 1))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized.subarray(0, 32 * 1024))
      controller.enqueue(oversized.subarray(32 * 1024))
    },
    cancel() { cancelled = true },
  })
  const response = await POST(rawRequest(stream))
  assert.equal(response.status, 413)
  assert.equal(cancelled, true)
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)
})

test('malformed JSON and invalid UTF-8 return controlled 400 responses', async () => {
  for (const body of ['{"name":', new Uint8Array([0xc3, 0x28])]) {
    const response = await POST(rawRequest(body))
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Invalid JSON body' })
  }
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)
})

test('root and scalar validation reject invalid inputs before schema traversal or DNS', async () => {
  for (const body of [[], null, { ...validBody, endpoint_url: 7 }, { ...validBody, method: {} }]) {
    const response = await POST(jsonRequest(body))
    assert.equal(response.status, 400)
  }
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)
})

test('oversized parameter arrays and deeply nested schemas are rejected before DNS', async () => {
  const parameters = Array.from({ length: 5000 }, (_, index) => ({ name: `p${index}`, type: 'string' }))
  const largeParameters = await POST(jsonRequest({ ...validBody, query_parameters: parameters }))
  assert.equal(largeParameters.status, 413)

  let schema: Record<string, unknown> = { type: 'string' }
  for (let depth = 0; depth < 12; depth++) schema = { type: 'object', properties: { child: schema } }
  const deepSchema = await POST(jsonRequest({ ...validBody, request_schema: schema }))
  assert.equal(deepSchema.status, 400)
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)
})

test('creation limiter enforces ten attempts per minute by wallet', async () => {
  const database = inMemoryLimiter()
  const request = new NextRequest(`${origin}/api/apis`)
  for (let attempt = 1; attempt <= 10; attempt++) {
    assert.equal(await enforceRateLimit({ request, scope: 'listing-create', wallet, limit: 10,
      windowSeconds: 60, failClosed: true, database }), null)
  }
  const rejected = await enforceRateLimit({ request, scope: 'listing-create', wallet, limit: 10,
    windowSeconds: 60, failClosed: true, database })
  assert.equal(rejected?.status, 429)
})

test('trusted IP bucket stops rotating wallets while spoofed forwarding headers are ignored', async () => {
  const previousVercel = process.env.VERCEL
  const previousTrustedHeader = process.env.MAHSHAR_TRUSTED_CLIENT_IP_HEADER
  process.env.VERCEL = '1'
  delete process.env.MAHSHAR_TRUSTED_CLIENT_IP_HEADER
  try {
    const database = inMemoryLimiter()
    for (let attempt = 0; attempt < 10; attempt++) {
      const rotatingWallet = `0x${attempt.toString(16).padStart(40, '0')}`
      const request = new NextRequest(`${origin}/api/apis`, { headers: { 'x-vercel-forwarded-for': '203.0.113.10' } })
      assert.equal(await enforceRateLimit({ request, scope: 'listing-create', wallet: rotatingWallet, limit: 10,
        windowSeconds: 60, failClosed: true, database }), null)
    }
    const eleventh = new NextRequest(`${origin}/api/apis`, { headers: { 'x-vercel-forwarded-for': '203.0.113.10' } })
    const rejected = await enforceRateLimit({ request: eleventh, scope: 'listing-create', wallet: bob.address,
      limit: 10, windowSeconds: 60, failClosed: true, database })
    assert.equal(rejected?.status, 429)
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
    if (previousTrustedHeader === undefined) delete process.env.MAHSHAR_TRUSTED_CLIENT_IP_HEADER
    else process.env.MAHSHAR_TRUSTED_CLIENT_IP_HEADER = previousTrustedHeader
  }

  const first = rateLimitIdentities(new NextRequest(origin, { headers: { 'x-forwarded-for': '1.2.3.4' } }), 'listing-create', wallet)
  const second = rateLimitIdentities(new NextRequest(origin, { headers: { 'x-forwarded-for': '9.9.9.9' } }), 'listing-create', wallet)
  assert.deepEqual(first, second)
  assert.equal(first.some(identity => identity.kind === 'ip'), false)
})

test('rate-limit exhaustion and backend failure stop before parsing, DNS, encryption, or insertion', async () => {
  state.rateLimitAllowed = false
  const exhausted = await POST(jsonRequest(validBody))
  assert.equal(exhausted.status, 429)
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)

  reset()
  state.rateLimitError = true
  const messages: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { messages.push(args) }
  try {
    const unavailable = await POST(jsonRequest(validBody))
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), { error: 'rate_limit_unavailable' })
  } finally {
    console.error = originalError
  }
  assert.equal(messages.length, 1)
  assert.equal(state.urlValidationCalls, 0)
  assert.equal(state.tables.api_listings.length, 0)
})

test('database errors are sanitized and do not expose credentials or create partial rows', async () => {
  state.failListingInsert = true
  const credential = 'synthetic-provider-token'
  const response = await POST(jsonRequest({ ...validBody, auth_type: 'bearer', auth_key: credential }))
  assert.equal(response.status, 500)
  const serialized = JSON.stringify(await response.json())
  assert.equal(serialized, JSON.stringify({ error: 'Listing creation failed' }))
  assert.equal(serialized.includes('sensitive database detail'), false)
  assert.equal(serialized.includes(credential), false)
  assert.equal(state.tables.api_listings.length, 0)
})

test('route ordering and scope remain bounded, fail-closed, and creation-specific', () => {
  const source = readFileSync('src/app/api/apis/route.ts', 'utf8')
  const postStart = source.indexOf('export const POST')
  assert.doesNotMatch(source, /request\.json\s*\(/)
  assert.match(source, /MAX_LISTING_CREATE_BODY_BYTES = 64 \* 1024/)
  assert.match(source, /scope: 'listing-create'/)
  assert.match(source, /LISTING_CREATE_RATE_LIMIT = 10/)
  assert.match(source, /LISTING_CREATE_RATE_WINDOW_SECONDS = 60/)
  assert.match(source, /failClosed: true/)
  const positions = [
    source.indexOf('const limited = await enforceRateLimit'),
    source.indexOf('readBoundedJson<unknown>'),
    source.indexOf('const contractResult = listingContractMetadata'),
    source.indexOf('const requestContract = validateListingRequestContract'),
    source.indexOf('const urlValidation = await validateEndpointUrl'),
    source.indexOf('const encrypted_key ='),
    source.indexOf(".from('api_listings')", postStart),
  ]
  assert.equal(positions.every(position => position >= 0), true)
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
})
