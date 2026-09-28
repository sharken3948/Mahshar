import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { renderStart, state, timerDelays, timers } from './register.mjs'
import { DashboardWorkspaceProvider } from '../../src/app/dashboard/dashboard-workspace'
import { TARGETED_REFRESH_DELAY_MS, TARGETED_REFRESH_RETRY_DELAY_MS } from '../../src/lib/wallet-refresh'

function renderWorkspace() {
  renderStart()
  const shell = DashboardWorkspaceProvider({ children: null })
  const tree = (shell.type as (props: unknown) => any)(shell.props)
  return tree.props.value
}

async function settle() {
  for (let index = 0; index < 12; index++) await setImmediate()
}

test('successful deposit, withdrawal, and seller withdrawal schedule only their targeted reads', async () => {
  renderWorkspace()
  for (const effect of state.effects.splice(0)) effect()
  await settle()
  state.allowWalletActions = true
  let timerCursor = timers.length

  const runAttempt = async (delay: number) => {
    const index = timerDelays.findIndex((value, item) => item >= timerCursor && value === delay)
    assert.notEqual(index, -1)
    timerCursor = Math.max(timerCursor, index + 1)
    timers[index]()
    await settle()
  }
  const requestCount = (prefix: string) => state.requests.filter((url: string) => url.startsWith(prefix)).length

  let workspace = renderWorkspace()
  workspace.setDepositAmount('1')
  workspace = renderWorkspace()
  const beforeDeposit = {
    gateway: requestCount('/api/gateway/balance?'), seller: requestCount('/api/seller/statistics/'), calls: requestCount('/api/calls?'),
    arc: state.contractRefreshes.balanceOf, pending: state.contractRefreshes.withdrawingBalance,
    bridge: state.bridgeRefreshes, solana: state.solanaRefreshes,
  }
  const solanaWalletActionsBeforeDeposit = state.solanaWalletActions
  await workspace.handleDeposit()
  assert.equal(state.evmSwitches.at(-1), 5042)
  assert.equal(state.evmProviderRequests.at(-1), 'eth_accounts')
  assert.equal(state.gatewayDeposits.at(-1)?.from.chain, 'Arc')
  assert.equal(state.solanaWalletActions, solanaWalletActionsBeforeDeposit)
  assert.equal(requestCount('/api/gateway/balance?'), beforeDeposit.gateway)
  assert.equal(renderWorkspace().gatewayStats.gatewayAvailable, '12.5')
  await runAttempt(TARGETED_REFRESH_DELAY_MS)
  assert.equal(requestCount('/api/gateway/balance?'), beforeDeposit.gateway + 1)
  assert.equal(state.contractRefreshes.balanceOf, beforeDeposit.arc + 2, 'deposit uses one confirmed preflight read and one post-action refresh')
  assert.equal(state.contractRefreshes.withdrawingBalance, beforeDeposit.pending)
  assert.equal(state.bridgeRefreshes, beforeDeposit.bridge)
  assert.equal(state.solanaRefreshes, beforeDeposit.solana)
  assert.equal(requestCount('/api/seller/statistics/'), beforeDeposit.seller)
  assert.equal(requestCount('/api/calls?'), beforeDeposit.calls)
  await runAttempt(TARGETED_REFRESH_RETRY_DELAY_MS)

  workspace = renderWorkspace()
  workspace.setWithdrawAmount('1')
  workspace = renderWorkspace()
  const beforeWithdrawalGateway = requestCount('/api/gateway/balance?')
  const beforeWithdrawalArc = state.contractRefreshes.balanceOf
  await workspace.handleWithdraw()
  await runAttempt(TARGETED_REFRESH_DELAY_MS)
  assert.equal(requestCount('/api/gateway/balance?'), beforeWithdrawalGateway + 1)
  assert.equal(state.contractRefreshes.balanceOf, beforeWithdrawalArc + 1)
  await runAttempt(TARGETED_REFRESH_RETRY_DELAY_MS)

  workspace = renderWorkspace()
  workspace.setEarningsWithdrawAmount('1')
  workspace = renderWorkspace()
  const beforeSeller = requestCount('/api/seller/statistics/')
  const beforeSellerArc = state.contractRefreshes.balanceOf
  const beforeSellerGateway = requestCount('/api/gateway/balance?')
  const beforeSellerCalls = requestCount('/api/calls?')
  await workspace.handleWithdrawEarnings()
  await runAttempt(TARGETED_REFRESH_DELAY_MS)
  assert.equal(requestCount('/api/seller/statistics/'), beforeSeller + 1)
  assert.equal(state.contractRefreshes.balanceOf, beforeSellerArc + 1)
  assert.equal(requestCount('/api/gateway/balance?'), beforeSellerGateway)
  assert.equal(requestCount('/api/calls?'), beforeSellerCalls)

  const targetedTimersBeforeMarketplaceState = timerDelays.filter(delay => delay === TARGETED_REFRESH_DELAY_MS || delay === TARGETED_REFRESH_RETRY_DELAY_MS).length
  workspace.setMyApis(workspace.myApis)
  await settle()
  assert.equal(timerDelays.filter(delay => delay === TARGETED_REFRESH_DELAY_MS || delay === TARGETED_REFRESH_RETRY_DELAY_MS).length, targetedTimersBeforeMarketplaceState)
})
