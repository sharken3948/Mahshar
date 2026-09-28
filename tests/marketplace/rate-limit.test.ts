import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { enforceRateLimit, rateLimitIdentity } from '../../src/lib/rate-limit'
import { POST as match } from '../../src/app/api/ai/match/route'
import { GET as discover } from '../../src/app/api/agent/discover/route'
import { reset, state } from './fixtures'

beforeEach(reset)

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

test('cost-incurring and machine discovery routes fail closed when limiter storage fails', async () => {
  state.rateLimitError = true
  const matchResponse = await match(new NextRequest('https://mahshar.xyz/api/ai/match', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'weather' }),
  }))
  assert.equal(matchResponse.status, 503)
  assert.equal((await matchResponse.json()).error, 'rate_limit_unavailable')
  const discoveryResponse = await discover(new NextRequest('https://mahshar.xyz/api/agent/discover'))
  assert.equal(discoveryResponse.status, 503)
})

test('route limit exhaustion returns 429 before external or database work', async () => {
  state.rateLimitAllowed = false
  const response = await match(new NextRequest('https://mahshar.xyz/api/ai/match', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'weather' }),
  }))
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '12')
})

test('every audited expensive or security-sensitive route fails closed', () => {
  const audited: Array<[string, string]> = [
    ['src/app/api/ai/score/route.ts', 'ai-score'],
    ['src/app/api/apis/[id]/verify/route.ts', 'listing-verify'],
    ['src/app/api/gateway/balance/route.ts', 'gateway-balance'],
    ['src/app/api/ai/match/route.ts', 'ai-match'],
    ['src/app/api/agent/discover/route.ts', 'agent-discover'],
  ]
  for (const [path, scope] of audited) {
    const source = readFileSync(path, 'utf8')
    assert.match(source, new RegExp(`scope: ['"]${scope}['"]`), path)
    assert.match(source, /failClosed: true/, path)
  }
})
