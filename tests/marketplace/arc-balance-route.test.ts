import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { handleArcBalanceRequest } from '../../src/lib/arc-balance-route'

const wallet = ('0x' + '11'.repeat(20)) as Address

test('Arc balance fallback rejects malformed wallets before reading or rate limiting', async () => {
  let reads = 0
  let limits = 0
  const response = await handleArcBalanceRequest(new NextRequest('https://mahshar.xyz/api/wallet/arc-balance?wallet=bad'), {
    rateLimit: async () => { limits += 1; return null },
    readBalance: async () => { reads += 1; throw new Error('must not read') },
  })
  assert.equal(response.status, 400)
  assert.equal(reads, 0)
  assert.equal(limits, 0)
})

test('Arc balance fallback returns only normalized fixed-contract balance data', async () => {
  const response = await handleArcBalanceRequest(new NextRequest(`https://mahshar.xyz/api/wallet/arc-balance?wallet=${wallet}`), {
    rateLimit: async () => null,
    readBalance: async normalized => ({ wallet: normalized, value: BigInt(1_250_000), status: 'fresh', source: 'server-fallback', updatedAt: Date.now() }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { wallet, chain_id: 5042, balance_raw: '1250000', balance_usdc: '1.25' })
})

test('Arc balance fallback is rate limited and does not touch the RPC when denied', async () => {
  let reads = 0
  const response = await handleArcBalanceRequest(new NextRequest(`https://mahshar.xyz/api/wallet/arc-balance?wallet=${wallet}`), {
    rateLimit: async () => NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
    readBalance: async normalized => { reads += 1; return { wallet: normalized, value: BigInt(1), status: 'fresh', source: 'server-fallback' } },
  })
  assert.equal(response.status, 429)
  assert.equal(reads, 0)
})

test('Arc balance fallback sanitizes upstream failures', async () => {
  const response = await handleArcBalanceRequest(new NextRequest(`https://mahshar.xyz/api/wallet/arc-balance?wallet=${wallet}`), {
    rateLimit: async () => null,
    readBalance: async () => { throw new Error('HTTP request failed URL: https://private.example Contract: 0xsecret') },
  })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'arc_balance_unavailable' })
})
