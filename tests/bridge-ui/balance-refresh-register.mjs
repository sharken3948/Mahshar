import Module from 'node:module'

const load = Module._load
const DEFAULT_EVM_CHAINS = [{ chain: 'Base', chainId: 8453, name: 'Base', type: 'evm', usdcAddress: '0x' + '22'.repeat(20), rpcEndpoints: ['https://example.invalid'] }]
export const state = { slots: [], cursor: 0, effects: [], evmReads: [], solanaReads: [], evmChains: DEFAULT_EVM_CHAINS }

/** @returns {{ promise: Promise<unknown>, resolve: (value: unknown) => void, reject: (reason: unknown) => void }} */
export function deferred() {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

export function queueEvmRead(read) { state.evmReads.push(read) }
export function queueSolanaRead(read) { state.solanaReads.push(read) }
export function setEvmChains(chains) { state.evmChains = chains }

export function reset() {
  state.slots = []
  state.cursor = 0
  state.effects = []
  state.evmReads = []
  state.solanaReads = []
  state.evmChains = DEFAULT_EVM_CHAINS
}

export function renderStart() { state.cursor = 0 }
export function runEffects() { for (const effect of state.effects.splice(0)) effect() }

function nextSlot(initial) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = initial
  return index
}

function useState(initial) {
  const index = nextSlot(typeof initial === 'function' ? initial() : initial)
  return [state.slots[index], value => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value }]
}

function useRef(value) {
  const index = nextSlot({ current: value })
  return state.slots[index]
}

function memo(factory, dependencies) {
  const index = state.cursor++
  const previous = state.slots[index]
  if (!previous || dependencies.some((dependency, item) => dependency !== previous.dependencies[item])) {
    state.slots[index] = { dependencies, value: factory() }
  }
  return state.slots[index].value
}

function useEffect(effect, dependencies) {
  const index = state.cursor++
  const previous = state.slots[index]
  if (!previous || dependencies.some((dependency, item) => dependency !== previous.dependencies[item])) {
    state.effects.push(() => {
      previous?.cleanup?.()
      state.slots[index] = { dependencies, cleanup: effect() }
    })
  }
}

function formatUnits(value) {
  const whole = value / 1_000_000n
  const fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

Module._load = function(id, parent, main) {
  if (id === 'react') return { useCallback: (callback, dependencies) => memo(() => callback, dependencies), useEffect, useRef, useState }
  if (id === 'wagmi') return { useAccount: () => ({ address: '0x' + '11'.repeat(20), isConnected: true }) }
  if (id === 'viem') return {
    createPublicClient: () => ({ readContract: () => state.evmReads.shift().promise }),
    fallback: transports => transports,
    formatUnits,
    getAddress: value => value,
    http: value => value,
  }
  if (id === '@/lib/circle-bridge') return { discoverCircleRoutes: async () => ({ routes: state.evmChains.map(source => ({ source })) }) }
  if (id === '@circle-fin/bridge-kit') return { Solana: { usdcAddress: 'mint' } }
  if (id === '@solana/web3.js') return {
    Connection: class { getParsedTokenAccountsByOwner() { return state.solanaReads.shift().promise } },
    PublicKey: class {},
  }
  return load.call(this, id, parent, main)
}
