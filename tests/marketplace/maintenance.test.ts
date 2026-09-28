import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { GET } from '../../src/app/api/internal/maintenance/prune-responses/route'
import { reset, state } from './fixtures'

const previousSecret = process.env.CRON_SECRET
const secret = 'cron-fixture-secret-that-is-at-least-32-characters'
beforeEach(() => { reset(); process.env.CRON_SECRET = secret })
after(() => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = previousSecret
})

test('maintenance route rejects missing or invalid authorization', async () => {
  assert.equal((await GET(new NextRequest('https://attacker.example/api/internal/maintenance/prune-responses'))).status, 401)
  assert.equal((await GET(new NextRequest('https://mahshar.xyz/api/internal/maintenance/prune-responses', {
    headers: { authorization: 'Bearer wrong-secret' },
  }))).status, 401)
  assert.equal(state.pruneCalls, 0)
  delete process.env.CRON_SECRET
  assert.equal((await GET(new NextRequest('https://mahshar.xyz/api/internal/maintenance/prune-responses'))).status, 503)
})

test('authorized maintenance invokes the bounded pruning RPC and is repeatable', async () => {
  state.pruneResult = 17
  state.authPruneResult = { challenges: 3, sessions: 4 }
  const request = () => new NextRequest('https://spoofed-host.example/api/internal/maintenance/prune-responses', {
    headers: { authorization: `Bearer ${secret}` },
  })
  for (let invocation = 1; invocation <= 2; invocation++) {
    const response = await GET(request())
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, cleared_response_bodies: 17,
      cleared_wallet_challenges: 3, cleared_wallet_sessions: 4, limit: 1000 })
    assert.equal(state.pruneCalls, invocation)
    assert.equal(state.authPruneCalls, invocation)
  }
})
