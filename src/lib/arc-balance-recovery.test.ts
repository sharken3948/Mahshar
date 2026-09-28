import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindArcBalanceBrowserRecovery, bindArcBalanceProviderRecovery } from './arc-balance-recovery'

test('focus and visible document recovery refresh passively and clean up', () => {
  const listeners = new Map<string, () => void>()
  const windowTarget = {
    addEventListener: (event: 'focus', listener: () => void) => listeners.set(`window:${event}`, listener),
    removeEventListener: (event: 'focus') => listeners.delete(`window:${event}`),
  }
  const documentTarget = {
    visibilityState: 'hidden',
    addEventListener: (event: 'visibilitychange', listener: () => void) => listeners.set(`document:${event}`, listener),
    removeEventListener: (event: 'visibilitychange') => listeners.delete(`document:${event}`),
  }
  let refreshes = 0
  const cleanup = bindArcBalanceBrowserRecovery(() => { refreshes += 1 }, windowTarget, documentTarget)
  listeners.get('window:focus')?.()
  listeners.get('document:visibilitychange')?.()
  documentTarget.visibilityState = 'visible'
  listeners.get('document:visibilitychange')?.()
  assert.equal(refreshes, 2)
  cleanup()
  assert.equal(listeners.size, 0)
})

test('provider connect, chain, and account events trigger recovery without requesting a switch', () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const provider = {
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    removeListener: (event: string) => listeners.delete(event),
  }
  let refreshes = 0
  const cleanup = bindArcBalanceProviderRecovery(provider, () => { refreshes += 1 })
  listeners.get('connect')?.()
  listeners.get('chainChanged')?.('0x13b2')
  listeners.get('accountsChanged')?.([])
  assert.equal(refreshes, 3)
  cleanup()
  assert.equal(listeners.size, 0)
})
