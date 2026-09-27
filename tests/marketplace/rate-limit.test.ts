import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { enforceRateLimit, rateLimitIdentity } from '../../src/lib/rate-limit'

const request = new NextRequest('https://mahshar.xyz/api/agent/discover')

test('rate limiter returns a machine-readable 429 and Retry-After', async () => {
  const response = await enforceRateLimit({
    request, scope: 'fixture', limit: 2, windowSeconds: 60,
    database: { rpc: async () => ({ data: [{ allowed: false, remaining: 0, retry_after_seconds: 17 }], error: null }) },
  })
  assert.equal(response?.status, 429)
  assert.equal(response?.headers.get('retry-after'), '17')
  assert.deepEqual(await response?.json(), { error: 'rate_limited', retry_after_seconds: 17 })
})

test('expensive rate limits fail closed while cheap discovery may fail open', async () => {
  const database = { rpc: async () => ({ data: null, error: { message: 'unavailable' } }) }
  assert.equal(await enforceRateLimit({ request, scope: 'cheap', limit: 1, windowSeconds: 60, database }), null)
  assert.equal((await enforceRateLimit({ request, scope: 'expensive', limit: 1, windowSeconds: 60, database, failClosed: true }))?.status, 503)
})

test('rate-limit keys are hashed and stable without trusting arbitrary forwarded-for locally', () => {
  const first = rateLimitIdentity(new NextRequest('https://mahshar.xyz', { headers: { 'x-forwarded-for': '1.2.3.4' } }), 'scope', ['api'])
  const second = rateLimitIdentity(new NextRequest('https://mahshar.xyz', { headers: { 'x-forwarded-for': '9.9.9.9' } }), 'scope', ['api'])
  assert.equal(first, second)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(first.includes('1.2.3.4'), false)
})
