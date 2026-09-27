import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { state, renderStart, timers, timerDelays } from './register.mjs'
import { DashboardWorkspaceProvider } from '../../src/app/dashboard/dashboard-workspace'
import { REFRESH_INTERVAL_MS } from '../../src/hooks/useVisibilityRefresh'

const firstCall = {
  id: 'call-1',
  api_id: 'public',
  api_listings: { name: 'Public API', method: 'GET' },
  created_at: '2026-09-27T10:00:00.000Z',
  latency_ms: 120,
  success: true,
  payment_type: 'gateway',
}

function renderWorkspace() {
  renderStart()
  const shell = DashboardWorkspaceProvider({ children: null })
  const tree = (shell.type as (props: unknown) => any)(shell.props)
  return tree.props.value
}

async function settle() {
  for (let index = 0; index < 12; index++) await setImmediate()
}

test('scheduled refreshes update on success and retain all last-known-good dashboard data on failure', async () => {
  state.buyerCalls = [firstCall]
  renderWorkspace()
  for (const effect of state.effects.splice(0)) effect()
  await settle()

  let workspace = renderWorkspace()
  assert.equal(workspace.gatewayStats.gatewayAvailable, '12.5')
  assert.equal(workspace.sellerEarnings.withdrawable_balance, 2)
  assert.equal(workspace.myApis[0].id, 'public')
  assert.equal(workspace.callGroups[0].count, 1)
  assert.equal(workspace.balanceUpdatedAt, 1_000)

  let timerCursor = 0
  const runScheduledRefresh = async () => {
    const end = timers.length
    const scheduled = timers.slice(timerCursor, end).filter((_, index) => timerDelays[timerCursor + index] === REFRESH_INTERVAL_MS)
    timerCursor = end
    for (const callback of scheduled) callback()
    await settle()
  }

  state.now = 61_000
  state.gatewayAvailable = '13.5'
  state.sellerStatistics = {
    ...state.sellerStatistics,
    total_earnings: 4.5,
    accumulated_share: 4.25,
    in_flight_withdrawals: 0.25,
    withdrawable_balance: 4,
    earnings_by_api: [{ api_id: 'public', api_name: 'Public API', total: 4.5, calls: 6 }],
    total_calls: 6,
    listings: [{
      id: 'public', seller_wallet: state.address, name: 'Public API', description: 'Description', endpoint_url: 'https://seller.example',
      auth_type: 'public', auth_param_name: null, example_request: null, example_response: null, expected_status_codes: null,
      category: 'Data', price_per_call: 0.5, payment_model: 'pay-per-call', method: 'GET', score: 9, uptime: 100,
      created_at: '2026-01-01', is_active: true, verified_at: '2026-01-01',
    }],
  }
  state.buyerCalls = [firstCall, { ...firstCall, id: 'call-2', created_at: '2026-09-27T10:01:00.000Z' }]
  await runScheduledRefresh()

  workspace = renderWorkspace()
  assert.equal(workspace.gatewayStats.gatewayAvailable, '13.5')
  assert.equal(workspace.sellerEarnings.withdrawable_balance, 4)
  assert.equal(workspace.sellerEarnings.earnings_by_api[0].calls, 6)
  assert.equal(workspace.callGroups[0].count, 2)
  assert.equal(workspace.balanceUpdatedAt, 61_000)

  const stableContent = {
    gatewayStats: workspace.gatewayStats,
    sellerEarnings: workspace.sellerEarnings,
    myApis: workspace.myApis,
    calls: workspace.calls,
    callGroups: workspace.callGroups,
    loading: workspace.loading,
  }
  const stableStructure = {
    gatewayCard: workspace.gatewayStats ? 'content' : 'skeleton',
    earningsCard: workspace.sellerEarnings ? 'content' : 'skeleton',
    apiCard: workspace.myApis.length ? 'table' : 'empty',
    activityCard: workspace.callGroups.length ? 'table' : 'empty',
  }

  state.now = 121_000
  state.gatewayOk = false
  state.sellerOk = false
  state.buyerCallsOk = false
  state.balanceReadsOk = false
  state.bridgeRefreshOk = false
  state.solanaRefreshOk = false
  await runScheduledRefresh()

  workspace = renderWorkspace()
  assert.deepEqual({
    gatewayStats: workspace.gatewayStats,
    sellerEarnings: workspace.sellerEarnings,
    myApis: workspace.myApis,
    calls: workspace.calls,
    callGroups: workspace.callGroups,
    loading: workspace.loading,
  }, stableContent)
  assert.equal(workspace.balanceUpdatedAt, 61_000)
  assert.equal(workspace.loading, false)
  assert.equal(workspace.myApis.length, 1)
  assert.equal(workspace.callGroups.length, 1)
  assert.deepEqual({
    gatewayCard: workspace.gatewayStats ? 'content' : 'skeleton',
    earningsCard: workspace.sellerEarnings ? 'content' : 'skeleton',
    apiCard: workspace.myApis.length ? 'table' : 'empty',
    activityCard: workspace.callGroups.length ? 'table' : 'empty',
  }, stableStructure)
})
