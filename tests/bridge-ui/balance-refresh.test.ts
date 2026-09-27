import { deferred, queueEvmRead, queueSolanaRead, renderStart, reset, runEffects, setEvmChains } from './balance-refresh-register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useBridgeBalances } from '../../src/hooks/useBridgeBalances'
import { useSolanaBridgeBalance } from '../../src/hooks/useSolanaBridgeBalance'

const tick = () => new Promise(resolve => setImmediate(resolve))
const solanaAccounts = (amount: string) => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] })

test('EVM balance refresh keeps the previous snapshot visible until fresh reads finish', async () => {
  reset()
  const initial = deferred()
  queueEvmRead(initial)
  const render = () => { renderStart(); return useBridgeBalances() }

  render()
  runEffects()
  await tick()
  let balances = render()
  runEffects()
  balances = render()
  assert.equal(balances.balances[0].isLoading, true)

  initial.resolve(BigInt(1_000_000))
  await tick()
  balances = render()
  assert.equal(balances.balances[0].usdcBalance, '1')
  assert.equal(balances.balances[0].isLoading, false)

  const background = deferred()
  queueEvmRead(background)
  const refresh = balances.refresh()
  balances = render()
  assert.equal(balances.balances[0].usdcBalance, '1')
  assert.equal(balances.balances[0].isLoading, false)

  background.resolve(BigInt(2_000_000))
  assert.equal(await refresh, true)
  balances = render()
  assert.equal(balances.balances[0].usdcBalance, '2')
  assert.equal(balances.balances[0].isLoading, false)
})

test('Solana balance refresh uses loading only before the first snapshot', async () => {
  reset()
  const initial = deferred()
  queueSolanaRead(initial)
  const render = () => { renderStart(); return useSolanaBridgeBalance('owner') }

  let balance = render()
  runEffects()
  balance = render()
  assert.equal(balance.isLoading, true)

  initial.resolve(solanaAccounts('1000000'))
  await tick()
  balance = render()
  assert.equal(balance.usdcBalance, '1')
  assert.equal(balance.isLoading, false)

  const background = deferred()
  queueSolanaRead(background)
  const refresh = balance.refresh()
  balance = render()
  assert.equal(balance.usdcBalance, '1')
  assert.equal(balance.isLoading, false)

  background.resolve(solanaAccounts('2000000'))
  assert.equal(await refresh, true)
  balance = render()
  assert.equal(balance.usdcBalance, '2')
  assert.equal(balance.isLoading, false)
})

test('a failed EVM chain refresh retains that chain while successful chains update', async () => {
  reset()
  setEvmChains([
    { chain: 'Base', chainId: 8453, name: 'Base', type: 'evm', usdcAddress: '0x' + '22'.repeat(20), rpcEndpoints: ['https://base.invalid'] },
    { chain: 'Ethereum', chainId: 1, name: 'Ethereum', type: 'evm', usdcAddress: '0x' + '33'.repeat(20), rpcEndpoints: ['https://ethereum.invalid'] },
  ])
  const baseInitial = deferred()
  const ethereumInitial = deferred()
  queueEvmRead(baseInitial)
  queueEvmRead(ethereumInitial)
  const render = () => { renderStart(); return useBridgeBalances() }

  render()
  runEffects()
  await tick()
  render()
  runEffects()
  baseInitial.resolve(BigInt(1_000_000))
  ethereumInitial.resolve(BigInt(3_000_000))
  await tick()

  let snapshot = render()
  assert.deepEqual(snapshot.balances.map(item => item.usdcBalance), ['1', '3'])

  const baseRefresh = deferred()
  const ethereumRefresh = deferred()
  queueEvmRead(baseRefresh)
  queueEvmRead(ethereumRefresh)
  const refresh = snapshot.refresh()
  baseRefresh.resolve(BigInt(2_000_000))
  ethereumRefresh.reject(new Error('temporary Ethereum RPC failure'))

  assert.equal(await refresh, false)
  snapshot = render()
  assert.deepEqual(snapshot.balances.map(item => item.usdcBalance), ['2', '3'])
  assert.deepEqual(snapshot.balances.map(item => item.isLoading), [false, false])
  assert.equal(snapshot.balances.some(item => item.usdcBalance === '?'), false)
})

test('a same-wallet Solana refresh failure retains the last successful balance', async () => {
  reset()
  const initial = deferred()
  queueSolanaRead(initial)
  const render = () => { renderStart(); return useSolanaBridgeBalance('owner') }

  render()
  runEffects()
  initial.resolve(solanaAccounts('1500000'))
  await tick()
  let snapshot = render()
  assert.equal(snapshot.usdcBalance, '1.5')

  const background = deferred()
  queueSolanaRead(background)
  const refresh = snapshot.refresh()
  background.reject(new Error('temporary Solana RPC failure'))

  assert.equal(await refresh, false)
  snapshot = render()
  assert.equal(snapshot.usdcBalance, '1.5')
  assert.equal(snapshot.isLoading, false)
  assert.equal(snapshot.error, 'temporary Solana RPC failure')
})
