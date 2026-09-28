import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { renderStart, resetHarness, runEffects, state, timerDelays, timers } from './navbar-refresh-register.mjs'
import { NavBar } from '../../src/components/NavBar'
import { REFRESH_INTERVAL_MS } from '../../src/hooks/useVisibilityRefresh'

function textContent(node: any): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join(' ')
  return textContent(node.props?.children)
}

function render() {
  renderStart()
  return NavBar({})
}

beforeEach(resetHarness)

test('NavBar waits for session hydration before starting its private balance read', async () => {
  state.sessionStatus = 'checking'
  render(); runEffects(); await setImmediate()
  assert.equal(state.requests.length, 0)
  state.sessionStatus = 'authenticated'
  render(); runEffects(); await setImmediate()
  assert.equal(state.requests.length, 1)
})

test('NavBar retains its last successful Gateway balance when the 60-second poll fails', async () => {
  render()
  runEffects()
  await setImmediate()

  let tree = render()
  assert.match(textContent(tree), /\$\s*12\.5\s+USDC/)

  state.responseOk = false
  const scheduledPoll = timers.find((_, index) => timerDelays[index] === REFRESH_INTERVAL_MS)
  assert.ok(scheduledPoll)
  scheduledPoll()
  for (let index = 0; index < 4; index++) await setImmediate()

  tree = render()
  assert.match(textContent(tree), /\$\s*12\.5\s+USDC/)
  assert.doesNotMatch(textContent(tree), /\$\s*—\s+USDC/)
})

test('NavBar ignores wallet A response after switching to wallet B', async () => {
  state.deferred = true
  render(); runEffects()
  const walletA = state.address
  assert.equal(state.pending.length, 1)

  state.address = '0x' + '22'.repeat(20)
  render(); runEffects()
  assert.equal(state.pending.length, 2)
  const pending = state.pending as Array<{ input: string; resolve: (response: Response) => void }>
  const requestA = pending.find(item => item.input.includes(walletA.toLowerCase()))
  const requestB = pending.find(item => item.input.includes(state.address.toLowerCase()))
  assert.ok(requestA); assert.ok(requestB)

  requestB.resolve(Response.json({ gatewayAvailable: '22' }))
  for (let index = 0; index < 3; index++) await setImmediate()
  requestA.resolve(Response.json({ gatewayAvailable: '11' }))
  for (let index = 0; index < 3; index++) await setImmediate()

  assert.match(textContent(render()), /\$\s*22\s+USDC/)
  assert.doesNotMatch(textContent(render()), /\$\s*11\s+USDC/)
})
