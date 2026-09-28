import { flushEffects, reset, state } from '../mainnet/register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Arc, Base, Solana, type ChainDefinition } from '@circle-fin/bridge-kit'
import { useBridge } from '../../src/hooks/useBridge'
import { progressStages } from '../../src/app/dashboard/wallet/bridge/presentation'
import { circleFeeIssue, SMALL_BRIDGE_AMOUNT } from '../../src/lib/bridge-journey-state'

const key = 'mahshar:circle-bridge:v1:' + state.owner.toLowerCase()
function render() { state.cursor = 0; return useBridge() }

test('Base approval and burn stage switches to Base without globally forcing Arc', async () => {
  reset()
  await render().bridge('Base', '1')
  const call = state.calls.find(item => 'bridge' in item)?.bridge
  assert.equal(call.from.chain.chain, 'Base')
  assert.deepEqual(state.switched, [Base.chainId])
  const bridge = render()
  assert.equal(bridge.result?.state, 'success')
  assert.equal(bridge.chainTransition, null)
})

test('failed wallet network switch becomes a recoverable action without submitting a bridge', async () => {
  reset(); state.switchError = true
  await render().bridge('Base', '1')
  let bridge = render()
  assert.equal(state.calls.filter(item => 'bridge' in item).length, 0)
  assert.deepEqual(bridge.chainTransition, { status: 'required', targetChainId: Base.chainId, targetName: 'Base' })
  assert.match(bridge.error ?? '', /wallet declined|Switch to Base/i)
  state.switchError = false
  assert.equal(await bridge.continueChainSwitch(), true)
  bridge = render()
  assert.equal(bridge.chainTransition, null)
  assert.equal(state.calls.filter(item => 'bridge' in item).length, 0, 'network recovery must not replay the bridge')
})

test('completed saved transfer does not block the next validated bridge', async () => {
  reset()
  const complete = {
    amount: '1', token: 'USDC', state: 'success', source: { address: state.owner, chain: Base },
    destination: { address: state.owner, recipientAddress: state.owner, chain: Arc, useForwarder: true },
    steps: [{ name: 'burn', state: 'success', txHash: '0x' + 'aa'.repeat(32) }],
  }
  localStorage.setItem(key, JSON.stringify({ result: complete }))
  render(); flushEffects()
  let bridge = render()
  assert.equal(bridge.pending, false)
  assert.equal(bridge.error, null)
  assert.equal(bridge.adapterReady('Base'), true)
  await bridge.bridge('Base', '0.25')
  bridge = render()
  assert.equal(state.calls.filter(call => 'bridge' in call).length, 1)
  assert.equal(bridge.pending, false)
  assert.equal(bridge.result?.state, 'success')
})

test('unknown saved submission stays protected without an idle progress error', () => {
  reset()
  localStorage.setItem(key, JSON.stringify({ source: 'Base', amount: '1' }))
  render(); flushEffects()
  const bridge = render()
  assert.equal(bridge.pending, true)
  assert.equal(bridge.error, null)
  assert.match(bridge.recoveryNotice ?? '', /Check your source wallet/)
  assert.deepEqual(progressStages(bridge.result, bridge.isLoading, bridge.stepLabel, bridge.error, bridge.liveSteps), ['pending','pending','pending','pending'])
})

test('a real failed bridge attempt remains visible as an error', async () => {
  reset()
  state.hardError = true
  let bridge = render()
  await bridge.bridge('Base', '0.25')
  bridge = render()
  assert.equal(bridge.error, 'submission unknown')
  assert.equal(bridge.pending, true)
  assert.ok(progressStages(bridge.result, bridge.isLoading, bridge.stepLabel, bridge.error, bridge.liveSteps).includes('failed'))
})

function failedResult(source: ChainDefinition = Solana, steps: { name: string; state: 'error' | 'success'; txHash?: string; errorMessage?: string }[] = [{ name: 'burn', state: 'error', errorMessage: 'MaxFeeMustBeLessThanAmount\nAnchor stack trace' }]) {
  return { amount: '0.01', token: 'USDC', state: 'error', provider: 'CCTPV2BridgingProvider',
    source: { address: source === Solana ? state.solanaOwner : state.owner, chain: source },
    destination: { address: state.owner, recipientAddress: state.owner, chain: Arc, useForwarder: true }, steps }
}

test('old failed Solana simulation is terminal and does not block a new Base transfer', async () => {
  reset()
  localStorage.setItem(key, JSON.stringify({ result: failedResult() }))
  render(); flushEffects()
  let bridge = render()
  assert.equal(bridge.pending, false)
  assert.equal(bridge.resumable, false)
  assert.equal(bridge.stepLabel, 'Bridge failed before submission')
  assert.equal(bridge.error, SMALL_BRIDGE_AMOUNT)
  assert.doesNotMatch(bridge.error ?? '', /Anchor|stack trace/)
  await bridge.bridge('Base', '0.1')
  bridge = render()
  assert.equal(state.calls.filter(call => 'bridge' in call).length, 1)
  assert.equal(bridge.result?.state, 'success')
})

test('Solana bridge execution uses the official Solana adapter and fixed Arc recipient', async () => {
  reset()
  await render().bridge('Solana', '1')
  const adapterCall = state.calls.find(call => 'solanaAdapter' in call)
  const bridgeCall = state.calls.find(call => 'bridge' in call)?.bridge
  assert.ok(adapterCall)
  assert.equal(bridgeCall.from.adapter.kind, 'solana')
  assert.equal(bridgeCall.to.chain, 'Arc')
  assert.equal(bridgeCall.to.recipientAddress, state.owner)
  assert.equal(state.switched.length, 0)
})

test('wallet rejection before broadcast is terminal, retained in storage, and permits next transfer', async () => {
  reset(); state.hardError = true; state.errorMessage = 'User rejected the request'
  let bridge = render()
  await bridge.bridge('Base', '0.1')
  bridge = render()
  assert.equal(bridge.pending, false)
  assert.equal(bridge.lastFailure()?.terminal, true)
  assert.match(localStorage.getItem(key) ?? '', /"terminal":true/)
  state.hardError = false
  await bridge.bridge('Base', '0.1')
  assert.equal(state.calls.filter(call => 'bridge' in call).length, 2)
})

test('SDK simulation error without burn is failed and non-resumable', async () => {
  reset(); state.sdkState = 'error'; state.sdkSteps = [{ name: 'burn', state: 'error', errorMessage: 'transaction simulation failed' }]
  let bridge = render()
  await bridge.bridge('Base', '0.1')
  bridge = render()
  assert.equal(bridge.pending, false)
  assert.equal(bridge.resumable, false)
  assert.equal(bridge.lastFailure()?.terminal, true)
})

test('source burn hash in failed result remains recoverable and blocks duplicate burn', async () => {
  reset()
  localStorage.setItem(key, JSON.stringify({ result: failedResult(Base, [{ name: 'burn', state: 'error', txHash: '0x'+'ab'.repeat(32), errorMessage: 'attestation failed' }]) }))
  render(); flushEffects()
  let bridge = render()
  assert.equal(bridge.pending, true)
  assert.equal(bridge.resumable, true)
  await bridge.bridge('Base', '0.1')
  bridge = render()
  assert.equal(state.calls.filter(call => 'bridge' in call).length, 0)
  assert.match(bridge.error ?? '', /Review or resume/)
})

test('attestation stage remains recoverable even if the SDK omits the burn hash', () => {
  reset()
  localStorage.setItem(key, JSON.stringify({ result: failedResult(Base, [
    { name: 'burn', state: 'success' }, { name: 'fetchAttestation', state: 'error', errorMessage: 'polling timeout' },
  ]) }))
  render(); flushEffects()
  const bridge = render()
  assert.equal(bridge.pending, true)
  assert.equal(bridge.resumable, true)
})

test('Circle fee estimate prevents too-small bridge before SDK submission', async () => {
  reset()
  assert.equal(circleFeeIssue('0.01', { fees: [{ type: 'provider', token: 'USDC', amount: '0.01' }], gasFees: [] } as never), SMALL_BRIDGE_AMOUNT)
  let bridge = render()
  await bridge.bridge('Base', '0.005')
  bridge = render()
  assert.equal(bridge.error, SMALL_BRIDGE_AMOUNT)
  assert.equal(bridge.pending, false)
  assert.equal(state.calls.filter(call => 'bridge' in call).length, 0)
  assert.equal(state.switched.length, 0)
})
