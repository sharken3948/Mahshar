import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import type { Hex } from 'viem'
import { alice, bob, origin, reset, sessionHeaders, state } from './fixtures'
import { POST as challenge } from '../../src/app/api/auth/challenge/route'
import { DELETE as logout, GET as session, POST as login } from '../../src/app/api/auth/session/route'
import { LOGIN_AUTH_DOMAIN, LOGIN_AUTH_TYPES, loginMessage } from '../../src/lib/marketplace/session-auth'

beforeEach(reset)

function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, { method, headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }) })
}

async function newChallenge(wallet = alice.address) {
  const response = await challenge(request('/api/auth/challenge', 'POST', { wallet }))
  assert.equal(response.status, 200)
  return response.json() as Promise<{ challenge_id: string; wallet: `0x${string}`; nonce: Hex;
    issued_at: number; deadline: number; origin: string }>
}

async function proof(challengeBody: Awaited<ReturnType<typeof newChallenge>>, signer = alice) {
  const signature = await signer.signTypedData({ domain: LOGIN_AUTH_DOMAIN, types: LOGIN_AUTH_TYPES,
    primaryType: 'MahsharLogin', message: loginMessage({ wallet: challengeBody.wallet, origin: challengeBody.origin,
      nonce: challengeBody.nonce, issuedAt: challengeBody.issued_at, deadline: challengeBody.deadline }) })
  return { ...challengeBody, challenge_id: challengeBody.challenge_id, signature }
}

function sessionCookie(response: Response) {
  const match = response.headers.get('set-cookie')?.match(/mahshar_session=([^;]+)/)
  assert.ok(match?.[1])
  return `mahshar_session=${match[1]}`
}

test('valid wallet login creates one normalized, eight-hour server session', async () => {
  const loginChallenge = await newChallenge(alice.address)
  assert.equal(loginChallenge.wallet, alice.address.toLowerCase())
  const response = await login(request('/api/auth/session', 'POST', await proof(loginChallenge)))
  assert.equal(response.status, 200)
  const cookie = sessionCookie(response)
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/i)
  assert.match(response.headers.get('set-cookie') ?? '', /SameSite=lax/i)
  assert.equal(state.tables.wallet_sessions.length, 1)
  const lifetime = new Date(state.tables.wallet_sessions[0].expires_at).getTime()
    - new Date(state.tables.wallet_sessions[0].created_at).getTime()
  assert.ok(lifetime > 7.9 * 60 * 60 * 1000 && lifetime <= 8.1 * 60 * 60 * 1000)

  const check = await session(request(`/api/auth/session?wallet=${loginChallenge.wallet}`, 'GET', undefined, { cookie }))
  assert.equal(check.status, 200)
  assert.deepEqual((await check.json()).wallet, loginChallenge.wallet)
})

test('invalid signature is rejected without consuming the challenge', async () => {
  const loginChallenge = await newChallenge()
  const response = await login(request('/api/auth/session', 'POST', await proof(loginChallenge, bob)))
  assert.equal(response.status, 401)
  assert.equal(state.tables.wallet_auth_challenges[0].used_at, undefined)
  assert.equal(state.tables.wallet_sessions.length, 0)
})

test('login signatures are bound to the canonical origin and Arc Mainnet domain', async () => {
  const originChallenge = await newChallenge()
  const wrongOriginSignature = await alice.signTypedData({ domain: LOGIN_AUTH_DOMAIN, types: LOGIN_AUTH_TYPES,
    primaryType: 'MahsharLogin', message: loginMessage({ wallet: originChallenge.wallet,
      origin: 'https://evil.example', nonce: originChallenge.nonce,
      issuedAt: originChallenge.issued_at, deadline: originChallenge.deadline }) })
  assert.equal((await login(request('/api/auth/session', 'POST', {
    ...originChallenge, signature: wrongOriginSignature,
  }))).status, 401)

  const chainChallenge = await newChallenge()
  const wrongChainSignature = await alice.signTypedData({ domain: { ...LOGIN_AUTH_DOMAIN, chainId: 1 },
    types: LOGIN_AUTH_TYPES, primaryType: 'MahsharLogin', message: loginMessage({ wallet: chainChallenge.wallet,
      origin: chainChallenge.origin, nonce: chainChallenge.nonce,
      issuedAt: chainChallenge.issued_at, deadline: chainChallenge.deadline }) })
  assert.equal((await login(request('/api/auth/session', 'POST', {
    ...chainChallenge, signature: wrongChainSignature,
  }))).status, 401)
})

test('expired and reused login challenges are rejected', async () => {
  const expired = await newChallenge()
  expired.issued_at -= 600
  expired.deadline -= 600
  state.tables.wallet_auth_challenges[0].issued_at = new Date(expired.issued_at * 1000).toISOString()
  state.tables.wallet_auth_challenges[0].expires_at = new Date(expired.deadline * 1000).toISOString()
  assert.equal((await login(request('/api/auth/session', 'POST', await proof(expired)))).status, 401)

  reset()
  const reusable = await newChallenge()
  const signed = await proof(reusable)
  assert.equal((await login(request('/api/auth/session', 'POST', signed))).status, 200)
  assert.equal((await login(request('/api/auth/session', 'POST', signed))).status, 401)
  assert.equal(state.tables.wallet_sessions.length, 1)
})

test('tampered, expired, revoked, and wrong-wallet sessions are rejected', async () => {
  assert.equal((await session(request('/api/auth/session', 'GET', undefined,
    { cookie: `mahshar_session=${'x'.repeat(43)}` }))).status, 401)
  assert.equal((await session(request('/api/auth/session', 'GET', undefined,
    sessionHeaders(alice, { expired: true })))).status, 401)
  assert.equal((await session(request('/api/auth/session', 'GET', undefined,
    sessionHeaders(alice, { revoked: true })))).status, 401)
  assert.equal((await session(request(`/api/auth/session?wallet=${bob.address}`, 'GET', undefined,
    sessionHeaders(alice)))).status, 403)
})

test('logout revokes the current session and clears its cookie', async () => {
  const headers = sessionHeaders(alice)
  const response = await logout(request('/api/auth/session', 'DELETE', undefined, headers))
  assert.equal(response.status, 200)
  assert.ok(state.tables.wallet_sessions[0].revoked_at)
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i)
  assert.equal((await session(request('/api/auth/session', 'GET', undefined, headers))).status, 401)
})

test('login and logout reject cross-origin cookie mutations', async () => {
  const loginChallenge = await newChallenge()
  const evil = { origin: 'https://evil.example' }
  assert.equal((await login(request('/api/auth/session', 'POST', await proof(loginChallenge), evil))).status, 403)
  assert.equal((await logout(request('/api/auth/session', 'DELETE', undefined, evil))).status, 403)
})

test('login challenge and verification fail closed when rate-limit storage is unavailable', async () => {
  state.rateLimitError = true
  assert.equal((await challenge(request('/api/auth/challenge', 'POST', { wallet: alice.address }))).status, 503)
  assert.equal((await login(request('/api/auth/session', 'POST', {}))).status, 503)
})
