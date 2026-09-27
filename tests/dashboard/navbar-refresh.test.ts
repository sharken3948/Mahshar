import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { renderStart, runEffects, state, timerDelays, timers } from './navbar-refresh-register.mjs'
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
