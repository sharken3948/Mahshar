import Module from 'node:module'

const load = Module._load
export const alice = `0x${'11'.repeat(20)}`
export const bob = `0x${'22'.repeat(20)}`
export const signature = `0x${'33'.repeat(65)}`
export const state = globalThis.__mahsharWalletSwitchState ??= {
  address: alice, serverWallet: null, slots: [], cursor: 0, pendingEffects: [], context: null,
  signatures: 0, fetches: [], protectedFetches: [], rejectNextSignature: false, protectedError: null,
  deferSignatures: false, pendingSignatures: [], sessionExpired: false,
  deferSessionBodies: false, pendingSessionBodies: [],
  hangSessionGet: false, hangChallenge: false, hangSessionPost: false, hangProvider: false,
  providerChainId: 5042, providerConfirmationReady: true, pendingProviderChainId: null,
  switchRequests: 0, rejectNextSwitch: false, providerReads: 0, chainEvents: [],
  chainListeners: new Set(),
}

export function reset() {
  for (const pending of state.pendingSessionBodies) pending.resolve(pending.body)
  for (const slot of state.slots) slot?.cleanup?.()
  state.address = alice; state.serverWallet = null; state.slots = []; state.cursor = 0
  state.pendingEffects = []; state.context = null; state.signatures = 0; state.fetches = []
  state.protectedFetches = []; state.rejectNextSignature = false; state.protectedError = null
  state.deferSignatures = false; state.pendingSignatures = []; state.sessionExpired = false
  state.deferSessionBodies = false; state.pendingSessionBodies = []
  state.hangSessionGet = false; state.hangChallenge = false; state.hangSessionPost = false; state.hangProvider = false
  state.providerChainId = 5042; state.providerConfirmationReady = true; state.pendingProviderChainId = null
  state.switchRequests = 0; state.rejectNextSwitch = false; state.providerReads = 0; state.chainEvents = []
  state.chainListeners = new Set()
}

export function emitChainChanged(chainId) {
  state.providerChainId = chainId
  for (const listener of state.chainListeners) listener(`0x${chainId.toString(16)}`)
}

function useState(initial) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
  return [state.slots[index].value, value => {
    state.slots[index].value = typeof value === 'function' ? value(state.slots[index].value) : value
  }]
}
function useRef(initial) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = { current: initial }
  return state.slots[index]
}
function memo(factory, deps) {
  const index = state.cursor++
  const old = state.slots[index]
  if (!old || deps.some((value, position) => value !== old.deps[position])) state.slots[index] = { value: factory(), deps }
  return state.slots[index].value
}
function useEffect(effect, deps) {
  const index = state.cursor++
  const old = state.slots[index]
  if (!old || deps.some((value, position) => value !== old.deps[position])) {
    state.slots[index] = { deps, cleanup: old?.cleanup, effect }
    state.pendingEffects.push(() => {
      state.slots[index].cleanup?.()
      state.slots[index].cleanup = effect()
    })
  }
}
const contextObject = { Provider: props => { state.context = props.value; return props.children } }

export function render(Provider) {
  state.cursor = 0
  const element = Provider({ children: null })
  element.type(element.props)
  return state.context
}
export function runEffects() {
  const effects = state.pendingEffects.splice(0)
  for (const effect of effects) effect()
}
export function replayEffects() {
  for (const slot of state.slots) {
    if (!slot?.effect) continue
    slot.cleanup?.()
    slot.cleanup = slot.effect()
  }
}
export function remount() {
  for (const slot of state.slots) slot?.cleanup?.()
  state.slots = []; state.cursor = 0; state.pendingEffects = []; state.context = null
}
export function releaseSessionBodies() {
  const pending = state.pendingSessionBodies.splice(0)
  for (const item of pending) item.resolve(item.body)
}
export async function flush() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
}

globalThis.window = { location: { origin: 'https://mahshar.xyz' } }
function hangUntilAbort(signal) {
  return new Promise((_, reject) => signal?.addEventListener('abort', () =>
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  state.fetches.push({ input: url, init })
  state.chainEvents.push(`fetch:${url}`)
  if (url.startsWith('/api/auth/session?')) {
    if (state.hangSessionGet) return hangUntilAbort(init.signal)
    const requested = new URL(url, globalThis.window.location.origin).searchParams.get('wallet')
    const valid = state.serverWallet === requested && !state.sessionExpired
    if (!valid) return Response.json({ error: state.sessionExpired ? 'Wallet session expired' : 'Wallet session required' }, { status: 401 })
    const body = { authenticated: true, wallet: requested }
    if (!state.deferSessionBodies) return Response.json(body)
    return {
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        const pending = { resolve, reject, body }
        state.pendingSessionBodies.push(pending)
        init.signal?.addEventListener('abort', () => {
          const index = state.pendingSessionBodies.indexOf(pending)
          if (index >= 0) state.pendingSessionBodies.splice(index, 1)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, { once: true })
      }),
    }
  }
  if (url === '/api/auth/challenge') {
    if (state.hangChallenge) return hangUntilAbort(init.signal)
    const wallet = JSON.parse(init.body).wallet
    return Response.json({ challenge_id: '11111111-1111-4111-8111-111111111111', wallet,
      nonce: `0x${'44'.repeat(32)}`, issued_at: 100, deadline: 400, origin: globalThis.window.location.origin })
  }
  if (url === '/api/auth/session' && init.method === 'POST') {
    if (state.hangSessionPost) return hangUntilAbort(init.signal)
    const wallet = JSON.parse(init.body).wallet
    state.serverWallet = wallet
    state.sessionExpired = false
    return Response.json({ authenticated: true, wallet })
  }
  if (url === '/api/auth/session' && init.method === 'DELETE') {
    state.serverWallet = null
    return Response.json({ authenticated: false })
  }
  state.protectedFetches.push(url)
  if (state.protectedError) return Response.json({ error: state.protectedError }, { status: 401 })
  return Response.json({ ok: true })
}

const provider = {
  request: async ({ method }) => {
    if (method !== 'eth_chainId') return null
    state.providerReads += 1
    if (state.providerConfirmationReady && state.pendingProviderChainId !== null) {
      state.providerChainId = state.pendingProviderChainId
      state.pendingProviderChainId = null
    }
    return `0x${state.providerChainId.toString(16)}`
  },
  on: (event, listener) => { if (event === 'chainChanged') state.chainListeners.add(listener) },
  removeListener: (event, listener) => { if (event === 'chainChanged') state.chainListeners.delete(listener) },
}
const connector = { getProvider: async () => state.hangProvider ? new Promise(() => {}) : provider }

Module._load = function (id, parent, main) {
  if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  if (id === 'react') return { createContext: () => contextObject, useContext: () => state.context,
    useState, useRef, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps), useEffect }
  if (id === 'wagmi') return {
    useAccount: () => ({ address: state.address, connector }), useConfig: () => state,
    useSwitchChain: () => ({ switchChainAsync: async ({ chainId }) => {
      state.switchRequests += 1
      state.chainEvents.push(`switch:${chainId}`)
      if (state.rejectNextSwitch) {
        state.rejectNextSwitch = false
        throw Object.assign(new Error('User rejected the request'), { code: 4001 })
      }
      state.pendingProviderChainId = chainId
      if (state.providerConfirmationReady) {
        state.providerChainId = chainId
        state.pendingProviderChainId = null
      }
      return { id: chainId }
    } }),
    useSignTypedData: () => ({ signTypedDataAsync: async () => {
      state.signatures++
      state.chainEvents.push('signature')
      if (state.rejectNextSignature) { state.rejectNextSignature = false; throw Object.assign(new Error('rejected'), { code: 4001 }) }
      if (state.deferSignatures) return new Promise((resolve, reject) => state.pendingSignatures.push({ resolve, reject }))
      return signature
    } }),
  }
  if (id === '@wagmi/core') return { getAccount: config => ({ address: config.address, connector }) }
  return load.call(this, id, parent, main)
}
