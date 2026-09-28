import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { state, renderStart, timers, timerDelays, visibilityHandlers } from './register.mjs'
import { DashboardWorkspaceProvider } from '../../src/app/dashboard/dashboard-workspace'
import { REFRESH_INTERVAL_MS } from '../../src/hooks/useVisibilityRefresh'

test('wallet connect authorizes private dashboard reads without wallet transactions', async () => {
  function render() {
    renderStart()
    const shell=DashboardWorkspaceProvider({children:null})
    const tree=(shell.type as (p:unknown)=>any)(shell.props)
    return tree.props.value
  }
  render()
  for(const effect of state.effects.splice(0))effect()
  for(let i=0;i<12;i++)await setImmediate()
  const workspace=render()
  assert.equal(workspace.walletUsdcRaw,BigInt(2500000))
  assert.equal(workspace.gatewayStats.gatewayAvailable,'12.5')
  assert.equal(workspace.gatewayStats.totalSpent,undefined)
  assert.equal(workspace.myApis[0].id,'public')
  assert.equal(workspace.sellerEarnings.withdrawable_balance,2)
  assert.equal(workspace.sellerEarnings.earnings_by_api[0].calls,5)
  assert.equal(workspace.bridgeBalances[0].chainName,'Base')
  assert.equal(workspace.circleBridge.catalog.routes[0].source.chain,'Base')
  assert.equal(workspace.withdrawingRaw,BigInt(0))
  assert.equal('privateAccess' in workspace, false)
  assert.equal(state.requests.filter(url=>url.startsWith('/api/seller/statistics/')).length,1)
  assert.equal(state.requests.filter(url=>url.startsWith('/api/calls?')).length,1)
  await Promise.all([workspace.fetchLiveData(), workspace.fetchLiveData()])
  assert.equal(state.requests.filter(url=>url.startsWith('/api/seller/statistics/')).length,2)
  assert.ok(timerDelays.filter(delay=>delay===REFRESH_INTERVAL_MS).length>=2)
  Object.defineProperty(document,'visibilityState',{value:'hidden',writable:true,configurable:true})
  for(const handler of visibilityHandlers)handler()
  for(let i=0;i<4;i++)await setImmediate()
  assert.equal(state.requests.filter(url=>url.startsWith('/api/seller/statistics/')).length,2)
  Object.defineProperty(document,'visibilityState',{value:'visible',writable:true,configurable:true})
  for(const handler of visibilityHandlers)handler()
  for(let i=0;i<12;i++)await setImmediate()
  assert.equal(state.requests.filter(url=>url.startsWith('/api/seller/statistics/')).length,3)
  for(const timer of timers)timer()
  for(let i=0;i<12;i++)await setImmediate()
  assert.equal(state.requests.filter(url=>url.startsWith('/api/seller/statistics/')).length,4)
  assert.ok(state.signatures > 0);assert.equal(state.writes,0)
  assert.ok(!state.requests.some(url=>url.includes('/challenge')||url.includes('/session')))
})
