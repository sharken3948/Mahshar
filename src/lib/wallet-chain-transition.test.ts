import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EIP1193Provider } from 'viem'
import { chainSynchronizedProvider, providerChainId, switchWalletChainAndWait, waitForProviderChain, waitForWalletChain, walletChainErrorMessage } from './wallet-chain-transition'

function providerState(initial: number) {
  let chainId = initial
  const calls: string[] = []
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push(method)
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
    if (method === 'wallet_switchEthereumChain') {
      const value = (params as { chainId: string }[])[0].chainId
      chainId = Number.parseInt(value, 16)
      return null
    }
    return null
  } } as EIP1193Provider
  return { provider, calls, chainId: () => chainId, setChainId: (value: number) => { chainId = value } }
}

test('Base source stage remains on Base for approval and burn', async () => {
  const state = providerState(5042)
  let connectorChain = 5042
  await switchWalletChainAndWait({
    provider: state.provider, getConnectorChainId: () => connectorChain, targetChainId: 8453, targetName: 'Base',
    switchChain: async () => { state.setChainId(8453); connectorChain = 8453 }, options: { timeoutMs: 10, pollMs: 0 },
  })
  assert.equal(state.chainId(), 8453)
  assert.equal(connectorChain, 8453)
})

test('resolved switch waits for delayed provider and connector convergence', async () => {
  const state = providerState(8453)
  let connectorChain = 8453
  let polls = 0
  const result = await switchWalletChainAndWait({
    provider: state.provider, getConnectorChainId: () => connectorChain, targetChainId: 5042, targetName: 'Arc',
    switchChain: async () => {}, options: { timeoutMs: 1_000, pollMs: 0, sleep: async () => {
      polls += 1
      if (polls === 1) state.setChainId(5042)
      if (polls === 2) connectorChain = 5042
    } },
  })
  assert.equal(result.confirmed, true)
  assert.ok(polls >= 2)
})

test('provider-only confirmation never treats a cached connector value as proof', async () => {
  const state = providerState(5042002)
  let polls = 0
  assert.equal(await providerChainId(state.provider), 5042002)
  const result = await waitForProviderChain(state.provider, 5042, {
    timeoutMs: 1_000, pollMs: 0, sleep: async () => {
      polls += 1
      if (polls === 2) state.setChainId(5042)
    },
  })
  assert.equal(result.confirmed, true)
  assert.equal(result.providerChainId, 5042)
  assert.ok(polls >= 2)
})

test('Circle adapter provider does not release Arc switch until connector catches up', async () => {
  const state = providerState(8453)
  let connectorChain = 8453
  const transitions: unknown[] = []
  let polls = 0
  const synchronized = chainSynchronizedProvider(state.provider, () => connectorChain,
    id => id === 5042 ? 'Arc' : String(id), value => transitions.push(value),
    { timeoutMs: 1_000, pollMs: 0, sleep: async () => { polls += 1; if (polls === 2) connectorChain = 5042 } })
  await synchronized.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13b2' }] })
  assert.deepEqual(transitions, [
    { status: 'switching', targetChainId: 5042, targetName: 'Arc' }, null,
  ])
  assert.ok(polls >= 2)
})

test('failed synchronization is recoverable and raw chain IDs are not user-facing', async () => {
  const state = providerState(8453)
  const settled = await waitForWalletChain(state.provider, () => 8453, 5042,
    { timeoutMs: 0, pollMs: 0 })
  assert.equal(settled.confirmed, false)
  await assert.rejects(() => switchWalletChainAndWait({
    provider: state.provider, getConnectorChainId: () => 8453, targetChainId: 5042, targetName: 'Arc',
    switchChain: async () => {}, options: { timeoutMs: 0, pollMs: 0 },
  }), /Switch to Arc to continue/)
  const message = walletChainErrorMessage(new Error('Active chainId is 0x2105 but received 0x13b2'), 'Arc')
  assert.equal(message, 'Your wallet network is still updating. Switch to Arc to continue.')
  assert.doesNotMatch(message, /0x2105|0x13b2|ChainMismatch/)
})
