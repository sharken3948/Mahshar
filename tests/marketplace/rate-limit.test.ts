import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { enforceRateLimit, rateLimitIdentities, rateLimitIdentity } from '../../src/lib/rate-limit'
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

test('cost-incurring routes fail closed while read-only discovery fails open', async () => {
  state.rateLimitError = true
  const matchResponse = await match(new NextRequest('https://mahshar.xyz/api/ai/match', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'weather' }),
  }))
  assert.equal(matchResponse.status, 503)
  assert.equal((await matchResponse.json()).error, 'rate_limit_unavailable')
  const discoveryResponse = await discover(new NextRequest('https://mahshar.xyz/api/agent/discover'))
  assert.equal(discoveryResponse.status, 200)
})

test('route limit exhaustion returns 429 before external or database work', async () => {
  state.rateLimitAllowed = false
  const response = await match(new NextRequest('https://mahshar.xyz/api/ai/match', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'weather' }),
  }))
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '12')
})

test('audited routes apply the proportional fail-open and fail-closed policy', () => {
  const audited: Array<[string, string]> = [
    ['src/app/api/ai/score/route.ts', 'ai-score'],
    ['src/app/api/apis/[id]/verify/route.ts', 'listing-verify'],
    ['src/app/api/ai/match/route.ts', 'ai-match'],
  ]
  for (const [path, scope] of audited) {
    const source = readFileSync(path, 'utf8')
    assert.match(source, new RegExp(`scope: ['"]${scope}['"]`), path)
    assert.match(source, /failClosed: true/, path)
  }
  for (const [path, scope] of [
    ['src/app/api/gateway/balance/route.ts', 'gateway-balance'],
    ['src/app/api/agent/discover/route.ts', 'agent-discover'],
  ]) {
    const source = readFileSync(path, 'utf8')
    assert.match(source, new RegExp(`scope: ['"]${scope}['"]`), path)
    assert.match(source, /failClosed: false/, path)
  }
})

test('limiter backend failures are logged for both policies', async () => {
  const messages: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { messages.push(args) }
  try {
    const database = { rpc: async () => ({ data: null, error: { message: 'unavailable' } }) }
    await enforceRateLimit({ request, scope: 'read', limit: 1, windowSeconds: 60, database, failClosed: false })
    await enforceRateLimit({ request, scope: 'write', limit: 1, windowSeconds: 60, database, failClosed: true })
  } finally { console.error = original }
  assert.equal(messages.length, 2)
  assert.equal(messages.every(entry => entry[0] === '[rate-limit] backend unavailable'), true)
})

test('wallet and trusted IP quotas are independent and cannot reset one another', async () => {
  const previousVercel = process.env.VERCEL
  process.env.VERCEL = '1'
  try {
    const counts = new Map<string, number>()
    const database = { rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'mahshar_take_rate_limits')
      const buckets = args.p_buckets as Array<{ key_hash: string; limit: number }>
      const observations = buckets.map(bucket => {
        const count = (counts.get(bucket.key_hash) ?? 0) + 1
        counts.set(bucket.key_hash, count)
        return { allowed: count <= bucket.limit, remaining: Math.max(0, bucket.limit - count) }
      })
      return { data: [{ allowed: observations.every(value => value.allowed),
        remaining: Math.min(...observations.map(value => value.remaining)), retry_after_seconds: 60 }], error: null }
    } }
    const walletA = `0x${'a'.repeat(40)}`
    const walletB = `0x${'b'.repeat(40)}`
    const at = (ip: string) => new NextRequest('https://mahshar.xyz/api/gateway/balance', {
      headers: { 'x-vercel-forwarded-for': ip },
    })
    const take = (wallet: string, ip: string) => enforceRateLimit({ request: at(ip), scope: 'independent',
      wallet, limit: 2, windowSeconds: 60, failClosed: true, database })

    assert.equal(await take(walletA, '1.1.1.1'), null)
    assert.equal(await take(walletA, '1.1.1.1'), null)
    assert.equal((await take(walletA, '2.2.2.2'))?.status, 429, 'new IP must not reset wallet A')
    assert.equal((await take(walletB, '1.1.1.1'))?.status, 429, 'new wallet must not reset IP 1')
    assert.equal(await take(walletB, '2.2.2.2'), null, 'new wallet and new IP start fresh')

    const aAtOne = rateLimitIdentities(at('1.1.1.1'), 'independent', walletA)
    const aAtTwo = rateLimitIdentities(at('2.2.2.2'), 'independent', walletA)
    assert.equal(aAtOne.find(value => value.kind === 'wallet')?.keyHash,
      aAtTwo.find(value => value.kind === 'wallet')?.keyHash)
    assert.notEqual(aAtOne.find(value => value.kind === 'ip')?.keyHash,
      aAtTwo.find(value => value.kind === 'ip')?.keyHash)
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
  }
})

test('public routes remain IP-only and untrusted forwarded-for cannot reset a local bucket', async () => {
  const previousVercel = process.env.VERCEL
  delete process.env.VERCEL
  try {
    const first = rateLimitIdentities(new NextRequest('https://mahshar.xyz', { headers: { 'x-forwarded-for': '1.2.3.4' } }), 'public')
    const second = rateLimitIdentities(new NextRequest('https://mahshar.xyz', { headers: { 'x-forwarded-for': '9.9.9.9' } }), 'public')
    assert.equal(first.length, 1)
    assert.equal(first[0].kind, 'ip')
    assert.equal(first[0].keyHash, second[0].keyHash)
  } finally {
    if (previousVercel !== undefined) process.env.VERCEL = previousVercel
  }
})
