import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { completeDeferredWallet, renderStart, state } from './register.mjs'
import { DashboardWorkspaceProvider } from '../../src/app/dashboard/dashboard-workspace'

const walletA = `0x${'11'.repeat(20)}`
const walletB = `0x${'22'.repeat(20)}`

function renderWorkspace() {
  renderStart()
  const shell = DashboardWorkspaceProvider({ children: null })
  const tree = (shell.type as (props: unknown) => any)(shell.props)
  return tree.props.value
}

async function settle() {
  for (let index = 0; index < 16; index++) await setImmediate()
}

function sellerStatistics(wallet: string, marker: number) {
  return {
    total_earnings: marker, accumulated_share: marker, in_flight_withdrawals: marker / 10,
    withdrawable_balance: marker * 0.9, total_calls: marker,
    earnings_by_api: [{ api_id: `api-${marker}`, api_name: `API ${marker}`, total: marker, calls: marker }],
    listings: [{
      id: `api-${marker}`, seller_wallet: wallet, name: `API ${marker}`, description: 'Description', endpoint_url: 'https://private.example',
      auth_type: 'public', auth_param_name: null, example_request: null, example_response: null, expected_status_codes: null,
      category: 'Data', price_per_call: 1, payment_model: 'pay-per-call', method: 'GET', score: 9, uptime: 100,
      created_at: '2026-01-01', is_active: true, verified_at: '2026-01-01',
    }],
  }
}

test('deferred wallet A private data cannot overwrite wallet B and A does not suppress B requests', async () => {
  state.requests = []; state.effects = []; state.slots = []; state.deferredResponses = []
  state.deferredWallets = new Set([walletA.toLowerCase(), walletB.toLowerCase()])
  state.walletFixtures = {
    [walletA.toLowerCase()]: {
      gatewayAvailable: '11', totalSpent: 11, sellerStatistics: sellerStatistics(walletA, 11),
      buyerCalls: [{ id: 'call-a', api_id: 'api-11', api_listings: { name: 'API 11', method: 'GET' }, created_at: '2026-01-01', latency_ms: 11, success: true, payment_type: 'gateway' }],
      sellCallGroups: [{ api_id: 'api-11', api_name: 'API 11', count: 11, avgLatency: 11, successRate: 100, lastCalled: '2026-01-01', calls: [] }],
    },
    [walletB.toLowerCase()]: {
      gatewayAvailable: '22', totalSpent: 22, sellerStatistics: sellerStatistics(walletB, 22),
      buyerCalls: [{ id: 'call-b', api_id: 'api-22', api_listings: { name: 'API 22', method: 'GET' }, created_at: '2026-01-02', latency_ms: 22, success: true, payment_type: 'gateway' }],
      sellCallGroups: [{ api_id: 'api-22', api_name: 'API 22', count: 22, avgLatency: 22, successRate: 100, lastCalled: '2026-01-02', calls: [] }],
    },
  }

  state.address = walletA
  let workspace = renderWorkspace()
  for (const effect of state.effects.splice(0)) effect()
  void workspace.loadPrivateSnapshot()
  await settle()
  assert.ok(state.deferredResponses.some(item => item.wallet === walletA.toLowerCase()))

  state.address = walletB
  state.slots = []; state.effects = []
  workspace = renderWorkspace()
  assert.equal(workspace.address.toLowerCase(), walletB.toLowerCase())
  for (const effect of state.effects.splice(0)) effect()
  void workspace.loadPrivateSnapshot()
  await settle()
  assert.ok(state.deferredResponses.some(item => item.wallet === walletB.toLowerCase()),
    `wallet A work suppressed wallet B: ${JSON.stringify({ requests: state.requests, pending: state.deferredResponses.map(item => item.wallet) })}`)

  completeDeferredWallet(walletB.toLowerCase())
  await settle()
  workspace = renderWorkspace()
  assert.equal(workspace.gatewayStats.gatewayAvailable, '22')
  assert.equal(workspace.sellerEarnings.total_earnings, 22)
  assert.equal(workspace.myApis[0].id, 'api-22')
  assert.equal(workspace.calls[0].id, 'call-b')
  assert.equal(workspace.sellCallGroups[0].api_id, 'api-22')

  completeDeferredWallet(walletA.toLowerCase())
  await settle()
  workspace = renderWorkspace()
  assert.equal(workspace.gatewayStats.gatewayAvailable, '22')
  assert.equal(workspace.sellerEarnings.total_earnings, 22)
  assert.equal(workspace.myApis[0].id, 'api-22')
  assert.equal(workspace.calls[0].id, 'call-b')
  assert.equal(workspace.sellCallGroups[0].api_id, 'api-22')

  state.address = ''
  state.slots = []; state.effects = []
  workspace = renderWorkspace()
  for (const effect of state.effects.splice(0)) effect()
  workspace = renderWorkspace()
  assert.equal(workspace.gatewayStats, null)
  assert.equal(workspace.sellerEarnings, null)
  assert.deepEqual(workspace.myApis, [])
  assert.deepEqual(workspace.calls, [])
  assert.deepEqual(workspace.sellCallGroups, [])
  assert.equal(workspace.earningsWithdrawResult, null)
  assert.equal(workspace.loading, false)
})
