import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { completeDeferredWallet, state, renderStart, timers, timerDelays } from './register.mjs'
import { DashboardWorkspaceProvider } from '../../src/app/dashboard/dashboard-workspace'
import { REFRESH_INTERVAL_MS } from '../../src/hooks/useVisibilityRefresh'

function renderWorkspace() {
  renderStart()
  const shell = DashboardWorkspaceProvider({ children: null })
  const tree = (shell.type as (props: unknown) => any)(shell.props)
  return tree.props.value
}

async function settle() {
  for (let index = 0; index < 12; index++) await setImmediate()
}

test('initial and scheduled seller calls load without a snapshot gate or duplicate refreshes', async () => {
  const wallet = state.address.toLowerCase()
  const groups = [
    { api_id: 'star-trek', api_name: 'Star Trek API', count: 1, successRate: 100, avgLatency: 100, lastCalled: '2026-10-28', calls: [] },
    { api_id: 'strictly-better', api_name: 'Strictly Better API', count: 2, successRate: 100, avgLatency: 100, lastCalled: '2026-10-28', calls: [] },
  ]
  state.walletFixtures[wallet] = { sellCallGroups: groups }
  state.deferredWallets.add(wallet)
  renderWorkspace()
  for (const effect of state.effects.splice(0)) effect()
  await settle()
  const callRequests = () => state.requests.filter(url => url.startsWith('/api/seller/calls?')).length
  assert.equal(callRequests(), 1, 'initial authenticated loading must fetch seller calls')

  // Finish the private snapshot before the listing summary: neither response may hide the other.
  const early = state.deferredResponses.filter(item => !item.url.includes('/api/seller/statistics/'))
  state.deferredResponses = state.deferredResponses.filter(item => item.url.includes('/api/seller/statistics/'))
  for (const item of early) item.resolve(Response.json(item.url.includes('/api/seller/calls?')
    ? { groups } : item.url.includes('/api/calls?') ? { calls: [] } : { gatewayAvailable: '12.5' }))
  await settle()
  completeDeferredWallet(wallet)
  await settle()
  let workspace = renderWorkspace()
  assert.deepEqual(workspace.sellCallGroups, groups)
  assert.equal(workspace.myApis[0].id, 'public', 'late listings must still render')
  assert.equal(workspace.sellerEarnings.withdrawable_balance, 2)
  assert.equal(workspace.loading, false)

  for (let render = 0; render < 3; render++) {
    renderWorkspace()
    for (const effect of state.effects.splice(0)) effect()
    await settle()
  }
  assert.equal(callRequests(), 1, 'rerenders must not restart loading')

  state.deferredWallets.add(wallet)
  const refreshA = workspace.fetchLiveData()
  const refreshB = workspace.fetchLiveData()
  await settle()
  assert.equal(callRequests(), 2, 'overlapping refreshes share one seller calls request')
  completeDeferredWallet(wallet)
  await Promise.all([refreshA, refreshB])

  // A new failed call must update the displayed rate independently of paid-call totals.
  state.walletFixtures[wallet].sellCallGroups = [groups[0], { ...groups[1], count: 3, successRate: 67 }]
  state.walletFixtures[wallet].sellerStatistics = {
    ...workspace.sellerEarnings,
    listings: [{ ...workspace.myApis[0], name: 'Updated listing' }],
  }
  state.now = 61_000
  for (const [index, callback] of timers.slice().entries()) {
    if (timerDelays[index] === REFRESH_INTERVAL_MS) callback()
  }
  await settle()
  workspace = renderWorkspace()
  assert.equal(callRequests(), 3, 'scheduled refresh fetches seller calls once')
  assert.equal(workspace.sellCallGroups[1].successRate, 67)
  assert.equal(workspace.sellCallGroups[1].count, 3)
  assert.equal(workspace.myApis[0].name, 'Updated listing')
  assert.equal(workspace.sellerEarnings.withdrawable_balance, 2)
  assert.equal(state.writes, 0, 'loading must not sign or submit wallet transactions')
})
