import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import { readGatewayTreasury } from '../../src/lib/admin/gateway-treasury-data'
import { clearOperationsCacheForTests } from '../../src/lib/admin/operations-cache'
import { runAdminDbRead } from '../../src/lib/admin/operations-data'
import { knownSellerLiabilities } from '../../src/lib/admin/gateway-treasury-calculation'
import { GatewayTreasuryCard } from '../../src/app/admin/operations/gateway-treasury-card'
import { TreasuryCard } from '../../src/app/admin/operations/treasury-card'
import { GET as getGatewayTreasuryRoute } from '../../src/app/api/admin/operations/gateway-treasury/route'

const privateKey = `0x${'12'.repeat(32)}`
const wallet = privateKeyToAccount(privateKey as `0x${string}`).address
const fixedTime = new Date('2026-10-19T12:00:00.000Z')
const ledger = {
  purchases: [{ seller_share_usdc: null }, { seller_share_usdc: '1.500000' }, { seller_share_usdc: '0.100000' }],
  withdrawals: [
    { amount_usdc: '0.200000', status: 'minted' },
    { amount_usdc: '0.100000', status: 'pending_mint' },
    { amount_usdc: '0.050000', status: 'expired' },
  ],
}

function gatewayResponse(balance: unknown, extras: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ balances: [{ balance, withdrawing: '0.100000', pendingBatch: '0', ...extras }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

test('authenticated data reader targets the verified Arc depositor and shows known coverage without claiming profit', async () => {
  clearOperationsCacheForTests()
  let request: { url: string; init: RequestInit } | undefined
  const data = await readGatewayTreasury({ platformAddress: wallet, platformPrivateKey: privateKey,
    fetchBalance: async (url, init) => {
      request = { url: String(url), init: init ?? {} }
      return gatewayResponse('1.679321', { depositor: wallet, domain: 26 })
    },
    readLedger: async () => ledger, now: () => fixedTime,
  })
  assert.equal(request?.url, 'https://gateway-api.circle.com/v1/balances')
  assert.equal(request?.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(request?.init.body)), { token: 'USDC', sources: [{ depositor: wallet, domain: 26 }] })
  assert.equal((request?.init.headers as Record<string, string>)['X-ARC-PRIVATE-MAINNET-ENABLED'], 'true')
  assert.ok(request?.init.signal)
  assert.equal(data.total_balance_usdc, '1.779321')
  assert.equal(data.available_balance_usdc, '1.679321')
  assert.equal(data.withdrawing_usdc, '0.100000')
  assert.equal(data.known_seller_liabilities_usdc, '1.400000')
  assert.equal(data.historical_unallocated_purchases, 1)
  assert.equal(data.unresolved_withdrawals, 1)
  assert.equal(data.coverage, 'known_covered')
  assert.equal(data.ownership, 'verification_pending')
  const html = renderToStaticMarkup(<GatewayTreasuryCard resource={{ phase: 'ready', data }} onRetry={async () => {}} />)
  assert.match(html, /Total Gateway funds/)
  assert.match(html, /Available Gateway funds/)
  assert.match(html, /Known outstanding seller liabilities/)
  assert.equal((html.match(/Verification pending/g) ?? []).length, 2)
  assert.doesNotMatch(html, /profit|withdraw button|transfer/i)
})

test('shortfall, uncertain seller payouts and legacy rows remain visible; stale data never claims current availability', async () => {
  const data = await readGatewayTreasury({ platformAddress: wallet, platformPrivateKey: privateKey,
    fetchBalance: async () => gatewayResponse('1.000000'), readLedger: async () => ledger, now: () => fixedTime,
  })
  assert.equal(data.coverage, 'known_shortfall')
  const stale = renderToStaticMarkup(<GatewayTreasuryCard resource={{ phase: 'degraded', data }} onRetry={async () => {}} />)
  assert.match(stale, /Stale result/)
  assert.match(stale, /exceed available Gateway funds/)
  assert.match(stale, /historical purchases lack recorded seller shares/)
  assert.match(stale, /seller withdrawals need reconciliation/)
  assert.match(stale, /Last successful refresh/)
  const unavailable = renderToStaticMarkup(<GatewayTreasuryCard resource={{ phase: 'unavailable', data: null }} onRetry={async () => {}} />)
  assert.match(unavailable, /Unavailable/)
  assert.doesNotMatch(unavailable, /1.000000/)
})

test('invalid balance or inconsistent ledger fails closed; historical purchases do not become platform revenue', async () => {
  assert.rejects(readGatewayTreasury({ platformAddress: wallet, platformPrivateKey: privateKey,
    fetchBalance: async () => gatewayResponse('1.000000', { depositor: '0x0000000000000000000000000000000000000000' }),
    readLedger: async () => ledger,
  }), /source mismatch/)
  assert.rejects(readGatewayTreasury({ platformAddress: wallet, platformPrivateKey: privateKey,
    fetchBalance: async () => gatewayResponse('-1'), readLedger: async () => ledger,
  }), /Invalid treasury ledger amount/)
  assert.throws(() => knownSellerLiabilities([{ seller_share_usdc: null }], [{ amount_usdc: '1', status: 'minted' }]), /exceeds recorded shares/)
})

test('direct Arc wallet card remains a separate observation', () => {
  const html = renderToStaticMarkup(<TreasuryCard resource={{ phase: 'ready', data: {
    wallet, balance_usdc: '1.416119', status: 'fresh', chain_id: 5042,
    explorer_url: `https://arcscan.app/address/${wallet}`, as_of: fixedTime.toISOString(),
  } }} onRetry={async () => {}} />)
  assert.match(html, /Direct wallet balance only/)
  assert.match(html, /1\.416119/)
})

test('Gateway treasury endpoint denies unauthenticated reads before using the balance service', async () => {
  const response = await getGatewayTreasuryRoute(new NextRequest('https://mahshar.xyz/api/admin/operations/gateway-treasury'))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a queued Gateway read times out without executing later or leaking its queue place', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  const firstRead = runAdminDbRead(() => first.promise)
  const secondRead = runAdminDbRead(() => second.promise)
  await new Promise<void>(resolve => setImmediate(resolve))

  let lateReadExecuted = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), 20)
  const timedOut = runAdminDbRead(() => {
    lateReadExecuted = true
    return Promise.resolve('late')
  }, controller.signal)
  await assert.rejects(timedOut, error => (error as Error).name === 'TimeoutError')
  clearTimeout(timer)

  const nextRead = runAdminDbRead(() => Promise.resolve('recovered'))
  first.resolve('first')
  second.resolve('second')
  assert.deepEqual(await Promise.all([firstRead, secondRead, nextRead]), ['first', 'second', 'recovered'])
  assert.equal(lateReadExecuted, false)
})

test('a running timeout returns promptly but retains its concurrency slot until I/O settles', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  const controller = new AbortController()
  const timedOut = runAdminDbRead(() => first.promise, controller.signal)
  const secondRead = runAdminDbRead(() => second.promise)
  await new Promise<void>(resolve => setImmediate(resolve))

  controller.abort(new DOMException('deadline', 'TimeoutError'))
  await assert.rejects(timedOut, error => (error as Error).name === 'TimeoutError')
  let thirdStarted = false
  const thirdRead = runAdminDbRead(() => { thirdStarted = true; return Promise.resolve('third') })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(thirdStarted, false)

  first.reject(new Error('late database failure'))
  second.resolve('second')
  assert.equal(await secondRead, 'second')
  assert.equal(await thirdRead, 'third')
  assert.equal(thirdStarted, true)
  assert.equal(await runAdminDbRead(() => Promise.resolve('normal'), AbortSignal.timeout(100)), 'normal')
})

test('an already aborted queued read never starts and leaves the queue usable', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('deadline', 'TimeoutError'))
  let executed = false
  await assert.rejects(runAdminDbRead(() => {
    executed = true
    return Promise.resolve('unexpected')
  }, controller.signal), error => (error as Error).name === 'TimeoutError')
  assert.equal(executed, false)
  assert.equal(await runAdminDbRead(() => Promise.resolve('healthy')), 'healthy')
})
