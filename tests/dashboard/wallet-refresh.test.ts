import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REFRESH_INTERVAL_MS } from '../../src/hooks/useVisibilityRefresh'
import {
  createTargetedWalletRefreshScheduler,
  TARGETED_REFRESH_DELAY_MS,
  TARGETED_REFRESH_RETRY_DELAY_MS,
  walletRefreshResources,
  type WalletRefreshAction,
  type WalletRefreshResource,
} from '../../src/lib/wallet-refresh'

test('wallet-moving actions map only to the resources they affect', () => {
  assert.deepEqual(walletRefreshResources({ kind: 'gatewayDeposit' }), ['arcWallet', 'gateway'])
  assert.deepEqual(walletRefreshResources({ kind: 'gatewayWithdrawal' }), ['arcWallet', 'gateway'])
  assert.deepEqual(walletRefreshResources({ kind: 'trustlessWithdrawalInitiated' }), ['arcWallet', 'gateway', 'pendingWithdrawal'])
  assert.deepEqual(walletRefreshResources({ kind: 'trustlessWithdrawalReleased' }), ['arcWallet', 'pendingWithdrawal'])
  assert.deepEqual(walletRefreshResources({ kind: 'sellerWithdrawal' }), ['arcWallet', 'sellerEarnings'])
  assert.deepEqual(walletRefreshResources({ kind: 'bridge', source: 'evm' }), ['arcWallet', 'evmBridge'])
  assert.deepEqual(walletRefreshResources({ kind: 'bridge', source: 'solana' }), ['arcWallet', 'solana'])
  assert.deepEqual(walletRefreshResources({ kind: 'marketplacePurchase' } as unknown as WalletRefreshAction), [])
  assert.equal(REFRESH_INTERVAL_MS, 60_000)
})

test('targeted refresh timers deduplicate triggers, preserve visible state, and stop after one retry', async () => {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = []
  const calls: Array<Set<WalletRefreshResource>> = []
  let resolveFirst: (() => void) | null = null
  const first = new Promise<void>(resolve => { resolveFirst = resolve })
  const visible = { gateway: '12.5', arc: '2.5' }
  const scheduler = createTargetedWalletRefreshScheduler({
    getScope: () => '0xABC',
    refresh: resources => {
      calls.push(new Set(resources))
      return calls.length === 1 ? first : Promise.resolve()
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false }
      timers.push(timer)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: timer => { const entry = timers[Number(timer) - 1]; if (entry) entry.cancelled = true },
  })

  scheduler.schedule({ kind: 'gatewayDeposit' })
  scheduler.schedule({ kind: 'gatewayDeposit' })
  scheduler.schedule({ kind: 'bridge', source: 'evm' })
  assert.deepEqual(timers.map(timer => timer.delay), [TARGETED_REFRESH_DELAY_MS, TARGETED_REFRESH_RETRY_DELAY_MS])

  timers[0].callback()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0]], ['arcWallet', 'gateway', 'evmBridge'])
  assert.deepEqual(visible, { gateway: '12.5', arc: '2.5' })

  timers[1].callback()
  assert.equal(calls.length, 1)
  resolveFirst!()
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.deepEqual([...calls[1]], ['arcWallet', 'gateway', 'evmBridge'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.length, 2)
})

test('account changes cancel delayed targeted reads', () => {
  const timers: Array<{ callback: () => void; delay: number }> = []
  let scope = '0x111'
  let refreshes = 0
  const scheduler = createTargetedWalletRefreshScheduler({
    getScope: () => scope,
    refresh: async () => { refreshes++ },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length as unknown as ReturnType<typeof setTimeout> },
    clearTimer: () => {},
  })
  scheduler.schedule({ kind: 'gatewayWithdrawal' })
  scope = '0x222'
  timers[0].callback()
  timers[1].callback()
  assert.equal(refreshes, 0)
})

test('the optional retry skips resources whose first refresh already changed the snapshot', async () => {
  const timers: Array<() => void> = []
  let snapshot = 'before'
  let refreshes = 0
  const scheduler = createTargetedWalletRefreshScheduler({
    getScope: () => '0x111',
    getSnapshot: () => snapshot,
    refresh: async () => { refreshes++; snapshot = 'after' },
    setTimer: callback => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout> },
    clearTimer: () => {},
  })
  scheduler.schedule({ kind: 'gatewayDeposit' })
  timers[0]()
  await new Promise(resolve => setImmediate(resolve))
  timers[1]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refreshes, 1)
})
