import Module from 'node:module'

const load = Module._load
export const alice = `0x${'11'.repeat(20)}`
export const bob = `0x${'22'.repeat(20)}`
export const signature = `0x${'33'.repeat(65)}`
export const state = globalThis.__mahsharWalletSwitchState ??= {
  address: alice, serverWallet: null, slots: [], cursor: 0, pendingEffects: [], context: null,
  signatures: 0, fetches: [], protectedFetches: [], rejectNextSignature: false, protectedError: null,
  deferSignatures: false, pendingSignatures: [],
}

export function reset() {
  for (const slot of state.slots) slot?.cleanup?.()
  state.address = alice; state.serverWallet = null; state.slots = []; state.cursor = 0
  state.pendingEffects = []; state.context = null; state.signatures = 0; state.fetches = []
  state.protectedFetches = []; state.rejectNextSignature = false; state.protectedError = null
  state.deferSignatures = false; state.pendingSignatures = []
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
    state.slots[index] = { deps, cleanup: old?.cleanup }
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
export async function flush() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
}

globalThis.window = { location: { origin: 'https://mahshar.xyz' } }
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  state.fetches.push({ input: url, init })
  if (url.startsWith('/api/auth/session?')) {
    const requested = new URL(url, globalThis.window.location.origin).searchParams.get('wallet')
    return state.serverWallet === requested
      ? Response.json({ authenticated: true, wallet: requested })
      : Response.json({ error: 'Wallet session required' }, { status: 401 })
  }
  if (url === '/api/auth/challenge') {
    const wallet = JSON.parse(init.body).wallet
    return Response.json({ challenge_id: '11111111-1111-4111-8111-111111111111', wallet,
      nonce: `0x${'44'.repeat(32)}`, issued_at: 100, deadline: 400, origin: globalThis.window.location.origin })
  }
  if (url === '/api/auth/session' && init.method === 'POST') {
    const wallet = JSON.parse(init.body).wallet
    state.serverWallet = wallet
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

Module._load = function (id, parent, main) {
  if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  if (id === 'react') return { createContext: () => contextObject, useContext: () => state.context,
    useState, useRef, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps), useEffect }
  if (id === 'wagmi') return {
    useAccount: () => ({ address: state.address }), useConfig: () => state,
    useSignTypedData: () => ({ signTypedDataAsync: async () => {
      state.signatures++
      if (state.rejectNextSignature) { state.rejectNextSignature = false; throw Object.assign(new Error('rejected'), { code: 4001 }) }
      if (state.deferSignatures) return new Promise((resolve, reject) => state.pendingSignatures.push({ resolve, reject }))
      return signature
    } }),
  }
  if (id === '@wagmi/core') return { getAccount: config => ({ address: config.address }) }
  return load.call(this, id, parent, main)
}
