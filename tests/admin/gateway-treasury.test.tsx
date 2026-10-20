import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import { readGatewayTreasury } from '../../src/lib/admin/gateway-treasury-data'
import { clearOperationsCacheForTests } from '../../src/lib/admin/operations-cache'
import { runAdminDbRead } from '../../src/lib/admin/operations-data'
import { knownSellerLiabilities, recordedGrossCommission } from '../../src/lib/admin/gateway-treasury-calculation'
import { GatewayTreasuryCard } from '../../src/app/admin/operations/gateway-treasury-card'
import { TreasuryCard } from '../../src/app/admin/operations/treasury-card'
import { GET as getGatewayTreasuryRoute } from '../../src/app/api/admin/operations/gateway-treasury/route'

const privateKey = `0x${'12'.repeat(32)}`
const wallet = privateKeyToAccount(privateKey as `0x${string}`).address
const fixedTime = new Date('2026-10-19T12:00:00.000Z')
const buyer = '0x0000000000000000000000000000000000000001'
function purchase(id: string, amount: string, seller: string | null, attempt: string | null = null) {
  return { id, api_id: 'api-1', buyer_wallet: buyer, amount_usdc: amount,
    seller_share_usdc: seller, tx_hash: attempt ? `x402:${attempt}` : `legacy:${id}`, settlement_attempt_id: attempt }
}
function settlement(id: string, amount: string, seller: string, platform: string) {
  return { id, api_id: 'api-1', fingerprint: `fingerprint:${id}`, authorization_key: `authorization:${id}`,
    state: 'ACCOUNTING_COMPLETE', purchase_id: id, settlement_identity: `x402:${id}`,
    binding: { fingerprint: `fingerprint:${id}`, authorization_key: `authorization:${id}`,
      api_id: 'api-1', payer: buyer, network: 'eip155:5042',
      amount_atomic: amount, seller_atomic: seller, platform_atomic: platform } }
}
const ledger = {
  purchases: [
    purchase('unallocated', '1.100000', null),
    purchase('historical', '0.001100', '0.000900'),
    purchase('settled-1', '1.650000', '1.500000', 'settled-1'),
    purchase('settled-2', '0.110000', '0.100000', 'settled-2'),
  ],
  settlements: [settlement('settled-1', '1650000', '1500000', '150000'),
    settlement('settled-2', '110000', '100000', '10000'),
    { ...settlement('uncertain', '200000', '180000', '20000'), state: 'SETTLEMENT_UNKNOWN' }],
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
  assert.equal(data.known_seller_liabilities_usdc, '1.400900')
  assert.equal(data.completed_arc_commission_usdc, '0.160000')
  assert.equal(data.completed_arc_purchase_count, 2)
  assert.equal(data.historical_calculated_commission_usdc, '0.000200')
  assert.equal(data.historical_calculated_purchase_count, 1)
  assert.equal(data.total_recorded_gross_commission_usdc, '0.160200')
  assert.equal(data.safely_withdrawable_usdc, null)
  assert.equal(data.unresolved_settlement_attempts, 1)
  assert.equal(data.historical_unallocated_purchases, 1)
  assert.equal(data.unresolved_withdrawals, 1)
  assert.equal(data.coverage, 'known_covered')
  assert.equal(data.ownership, 'verification_pending')
  const html = renderToStaticMarkup(<GatewayTreasuryCard resource={{ phase: 'ready', data }} onRetry={async () => {}} />)
  assert.match(html, /Total Gateway funds/)
  assert.match(html, /Available Gateway funds/)
  assert.match(html, /Known outstanding seller liabilities/)
  assert.equal((html.match(/Verification pending/g) ?? []).length, 2)
  assert.match(html, /Completed Arc x402 commission \(2 purchases\)/)
  assert.match(html, /Historical calculated commission, no durable binding \(1 purchase\)/)
  assert.match(html, /Total recorded gross commissions/)
  assert.match(html, /Withdraw to Platform Wallet/)
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
  assert.doesNotMatch(html, /profit|\/withdraw\/quote|submit/i)
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

test('completed Arc accrual uses exact micros and excludes uncertain, duplicate, and mismatched bindings', () => {
  const purchases = [purchase('a', '0.000003', '0.000001', 'a'),
    purchase('b', '0.000002', '0.000001', 'b'), purchase('historical', '0.001100', '0.000900')]
  const a = settlement('a', '3', '1', '2')
  const b = settlement('b', '2', '1', '1')
  const clean = recordedGrossCommission(purchases, [a, b])
  assert.deepEqual([clean.completedArc, clean.historical, clean.gross], [BigInt(3), BigInt(200), BigInt(203)])
  assert.equal(clean.accountingIssues, 0)

  const disputed = recordedGrossCommission(purchases, [a, b, { ...a },
    { ...settlement('unknown', '900000', '800000', '100000'), state: 'SETTLEMENT_UNKNOWN' }])
  assert.equal(disputed.completedArc, BigInt(1))
  assert.equal(disputed.historical, BigInt(200))
  assert.ok(disputed.accountingIssues > 0)

  const mismatched = recordedGrossCommission(purchases, [{ ...a,
    binding: { ...a.binding, platform_atomic: '3' } }, b])
  assert.equal(mismatched.completedArc, BigInt(1))
  assert.ok(mismatched.accountingIssues > 0)
  const claimedLegacy = recordedGrossCommission([{ ...purchases[2], tx_hash: 'x402:a' }, ...purchases.slice(0, 2)], [a, b])
  assert.equal(claimedLegacy.historical, BigInt(0))
  assert.ok(claimedLegacy.accountingIssues > 0)
})

test('the 37 completed and 18 historical purchase cohorts remain separate in gross commission', () => {
  const completedPurchases = Array.from({ length: 36 }, (_, index) => purchase(`arc-${index}`, '0.001100', '0.000900', `arc-${index}`))
  completedPurchases.push(purchase('arc-large', '1.485200', '1.000000', 'arc-large'))
  const completedSettlements = Array.from({ length: 36 }, (_, index) => settlement(`arc-${index}`, '1100', '900', '200'))
  completedSettlements.push(settlement('arc-large', '1485200', '1000000', '485200'))
  const historical = [
    ...Array.from({ length: 14 }, (_, index) => purchase(`old-small-${index}`, '0.001100', '0.000900')),
    ...Array.from({ length: 3 }, (_, index) => purchase(`old-large-${index}`, '1.100000', '0.900000')),
    purchase('old-largest', '1.320000', '1.080000'),
  ]
  const commission = recordedGrossCommission([...completedPurchases, ...historical], completedSettlements)
  assert.equal(commission.completedArcCount, 37)
  assert.equal(commission.historicalCount, 18)
  assert.equal(commission.completedArc, BigInt(492400))
  assert.equal(commission.historical, BigInt(842800))
  assert.equal(commission.gross, BigInt(1335200))
  assert.equal(commission.accountingIssues, 0)
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
