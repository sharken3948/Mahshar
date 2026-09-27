import Module from 'node:module'

const load = Module._load
export const state = { slots: [], cursor: 0, effects: [], requests: [], balance: '12.5', responseOk: true }
export const timers = []
export const timerDelays = []

export function renderStart() { state.cursor = 0 }
export function runEffects() { for (const effect of state.effects.splice(0)) effect() }

function nextSlot(initial) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial
  return index
}

function useState(initial) {
  const index = nextSlot(initial)
  return [state.slots[index], value => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value }]
}

function useRef(initial) {
  const index = nextSlot({ current: initial })
  return state.slots[index]
}

function memo(factory, dependencies) {
  const index = state.cursor++
  const previous = state.slots[index]
  if (!previous || dependencies.some((dependency, item) => dependency !== previous.dependencies[item])) {
    state.slots[index] = { value: factory(), dependencies }
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

globalThis.fetch = async input => {
  state.requests.push(String(input))
  return state.responseOk
    ? Response.json({ gatewayAvailable: state.balance })
    : Response.json({ error: 'temporary gateway failure' }, { status: 503 })
}
globalThis.setTimeout = (callback, delay) => { timers.push(callback); timerDelays.push(delay); return timers.length }
globalThis.clearTimeout = () => {}
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} }

Module._load = function(id, parent, main) {
  if (id.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_target, property) => String(property) }) }
  if (id === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
  if (id === 'react') return {
    memo: component => component,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useEffect,
    useRef,
    useState,
  }
  if (id === 'next/link') return function Link() {}
  if (id === '@rainbow-me/rainbowkit') return { ConnectButton: function ConnectButton() {} }
  if (id === 'wagmi') return { useAccount: () => ({ address: '0x' + '11'.repeat(20), isConnected: true }) }
  if (id === './MahsharLogo') return { MahsharLogo: function MahsharLogo() {} }
  if (id === './ProductPreferencesProvider') return { useProductPreferences: () => ({ formatUsdc: value => String(value) }) }
  return load.call(this, id, parent, main)
}
