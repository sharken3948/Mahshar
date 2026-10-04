import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { MarketplaceSessionProvider, resetMarketplaceSessionCoordinatorForTests,
  setMarketplaceSessionTimeoutForTests } from '../../src/components/MarketplaceSessionProvider'
import { alice, bob, emitChainChanged, flush, releaseSessionBodies, remount, render, replayEffects, reset, runEffects,
  signature, state } from './wallet-switch-register.mjs'

beforeEach(() => {
  resetMarketplaceSessionCoordinatorForTests()
  reset()
})

async function connect() {
  let context = render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  context = render(MarketplaceSessionProvider)
  return context
}

async function wait(milliseconds: number) {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
  await flush()
}

for (const [label, chainId] of [['Arc Testnet', 5042002], ['BNB', 56], ['Ethereum', 1]] as const) {
  test(`${label} reconnect switches once to provider-confirmed Arc Mainnet before session restoration`, async () => {
    state.providerChainId = chainId
    state.serverWallet = alice
    render(MarketplaceSessionProvider)
    runEffects()
    await flush()
    const context = render(MarketplaceSessionProvider)
    assert.equal(state.switchRequests, 1)
    assert.equal(state.providerChainId, 5042)
    assert.equal(context.status, 'authenticated')
    assert.equal(context.networkStatus, 'ready')
    assert.equal(state.signatures, 0)
    assert.ok(state.chainEvents.indexOf('switch:5042') < state.chainEvents.findIndex((value: string) => value.startsWith('fetch:/api/auth/session?')))
  })
}

test('delayed provider confirmation blocks session checks and signatures until eth_chainId is 5042', async () => {
  state.providerChainId = 5042002
  state.providerConfirmationReady = false
  state.serverWallet = alice
  const context = render(MarketplaceSessionProvider)
  runEffects()
  const request = context.request('/api/calls')
  await flush()
  assert.equal(state.switchRequests, 1)
  assert.equal(state.signatures, 0)
  assert.equal(state.fetches.length, 0)
  state.providerConfirmationReady = true
  await wait(180)
  assert.equal((await request).ok, true)
  assert.equal(state.providerChainId, 5042)
  assert.equal(state.signatures, 0)
})

test('a rejected Arc Mainnet switch stops without a retry loop or login signature', async () => {
  state.providerChainId = 1
  state.rejectNextSwitch = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  let context = render(MarketplaceSessionProvider)
  assert.equal(state.switchRequests, 1)
  assert.equal(state.signatures, 0)
  assert.equal(state.fetches.length, 0)
  assert.equal(context.networkStatus, 'required')
  assert.equal(context.status, 'unauthenticated')
  replayEffects()
  await flush()
  context = render(MarketplaceSessionProvider)
  assert.equal(state.switchRequests, 1)
  assert.equal(context.status, 'unauthenticated')
})

test('simultaneous consumers share one Arc Mainnet switch and cannot sign early', async () => {
  state.providerChainId = 56
  state.providerConfirmationReady = false
  const context = render(MarketplaceSessionProvider)
  runEffects()
  const reads = [context.request('/api/calls'), context.request('/api/seller/calls')]
  await flush()
  assert.equal(state.switchRequests, 1)
  assert.equal(state.signatures, 0)
  assert.equal(state.fetches.length, 0)
  state.providerConfirmationReady = true
  await wait(180)
  await Promise.all(reads)
  assert.equal(state.switchRequests, 1)
  assert.equal(state.signatures, 1)
})

test('external chain changes update network state without invalidating the valid browser session', async () => {
  state.serverWallet = alice
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(render(MarketplaceSessionProvider).status, 'authenticated')
  emitChainChanged(1)
  let context = render(MarketplaceSessionProvider)
  assert.equal(context.networkStatus, 'required')
  assert.equal(context.status, 'authenticated')
  emitChainChanged(5042)
  context = render(MarketplaceSessionProvider)
  assert.equal(context.networkStatus, 'ready')
  assert.equal(context.status, 'authenticated')
})

test('initial connection and simultaneous private requests share one login signature', async () => {
  const context = render(MarketplaceSessionProvider)
  runEffects()
  const reads = [context.request('/api/calls'), context.request('/api/seller/calls'), context.request('/api/gateway/balance')]
  await Promise.all(reads)
  assert.equal(state.signatures, 1)
  assert.deepEqual(state.protectedFetches, ['/api/calls', '/api/seller/calls', '/api/gateway/balance'])
})

test('fresh connect, Strict Mode remount, and all initial private consumers complete behind one login', async () => {
  state.deferSignatures = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.signatures, 1)
  assert.equal(render(MarketplaceSessionProvider).status, 'signing', 'the signature state should exist only while the wallet prompt is unresolved')

  replayEffects()
  remount()
  const context = render(MarketplaceSessionProvider)
  runEffects()
  const reads = [
    context.request('/api/gateway/balance?wallet=' + alice),
    context.request('/api/calls?buyer_wallet=' + alice),
    context.request('/api/seller/statistics/' + alice),
    context.request('/api/seller/calls?seller_wallet=' + alice),
    context.request('/api/gateway/balance?wallet=' + alice + '&include_history=true'),
  ]
  await flush()
  assert.equal(state.signatures, 1)
  state.pendingSignatures.shift().resolve(signature)
  const responses = await Promise.all(reads)
  assert.ok(responses.every(response => response.ok))
  assert.equal(render(MarketplaceSessionProvider).status, 'authenticated')
  assert.equal(state.signatures, 1)
  assert.equal(state.fetches.filter((item: { input: string }) => item.input === '/api/auth/challenge').length, 1)
  assert.equal(state.fetches.filter((item: { input: string; init: RequestInit }) =>
    item.input === '/api/auth/session' && item.init.method === 'POST').length, 1)
})

test('a provider remount reuses a valid matching server session without requesting a signature', async () => {
  state.serverWallet = alice
  state.deferSessionBodies = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.pendingSessionBodies.length, 1)
  assert.equal(state.signatures, 0)

  remount()
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.signatures, 0, 'the remounted provider signed before the valid session check completed')
  assert.equal(render(MarketplaceSessionProvider).status, 'checking', 'session recovery must not claim a signature is active')

  releaseSessionBodies()
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'authenticated')
  assert.notEqual(context.status, 'signing')
  assert.equal(context.wallet, alice)
  assert.equal(state.signatures, 0)
  assert.equal(state.fetches.filter((item: { input: string }) => item.input.startsWith('/api/auth/challenge')).length, 0)
})

test('a valid session serves simultaneous private consumers with zero login signatures', async () => {
  state.serverWallet = alice
  const context = render(MarketplaceSessionProvider)
  runEffects()
  const responses = await Promise.all([
    context.request('/api/calls'),
    context.request('/api/seller/calls'),
    context.request('/api/gateway/balance'),
  ])
  assert.ok(responses.every(response => response.ok))
  assert.equal(state.signatures, 0)
  assert.equal(state.fetches.filter((item: { input: string }) => item.input.startsWith('/api/auth/session?')).length, 1)
})

test('an expired session completes validation before requesting exactly one login signature', async () => {
  state.serverWallet = alice
  state.sessionExpired = true
  const context = render(MarketplaceSessionProvider)
  runEffects()
  await Promise.all([context.request('/api/calls'), context.request('/api/seller/calls')])
  assert.equal(state.signatures, 1)
  const sessionCheck = state.fetches.findIndex((item: { input: string }) => item.input.startsWith('/api/auth/session?'))
  const challenge = state.fetches.findIndex((item: { input: string }) => item.input === '/api/auth/challenge')
  assert.ok(sessionCheck >= 0 && challenge > sessionCheck)
})

for (const [label, configure] of [
  ['session GET', () => { state.hangSessionGet = true }],
  ['challenge POST', () => { state.hangChallenge = true }],
  ['session POST', () => { state.hangSessionPost = true }],
  ['provider acquisition', () => { state.hangProvider = true }],
] as const) {
  test(`a never-resolving ${label} times out to a recoverable Sign in state`, async () => {
    setMarketplaceSessionTimeoutForTests(20)
    configure()
    render(MarketplaceSessionProvider)
    runEffects()
    await wait(35)
    const context = render(MarketplaceSessionProvider)
    assert.ok(['error', 'unauthenticated'].includes(context.status))
    assert.notEqual(context.status, 'checking')
    assert.notEqual(context.status, 'signing')
  })
}

test('a stale session check cannot overwrite the newer wallet session', async () => {
  state.serverWallet = alice
  state.deferSessionBodies = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.pendingSessionBodies.length, 1)

  state.address = bob
  state.serverWallet = bob
  state.deferSessionBodies = false
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(render(MarketplaceSessionProvider).status, 'authenticated')
  releaseSessionBodies()
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.wallet, bob)
  assert.equal(context.status, 'authenticated')
  assert.equal(state.signatures, 0)
})

test('a timed-out signature resolving later cannot restore checking or signing', async () => {
  setMarketplaceSessionTimeoutForTests(20)
  state.deferSignatures = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.signatures, 1)
  assert.equal(render(MarketplaceSessionProvider).status, 'signing')
  await wait(35)
  let context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'error')

  state.pendingSignatures.shift().resolve(signature)
  await flush()
  context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'error')
  assert.equal(context.wallet, alice)
  assert.equal(state.signatures, 1)
})

test('retry cannot overlap a timed-out wallet prompt and succeeds after that prompt settles', async () => {
  setMarketplaceSessionTimeoutForTests(20)
  state.deferSignatures = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  await wait(35)
  let context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'error')

  state.deferSignatures = false
  const blockedRetry = context.authenticate()
  await wait(35)
  assert.equal(await blockedRetry, false)
  context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'error')
  assert.equal(state.signatures, 1)

  state.pendingSignatures.shift().resolve(signature)
  await flush()
  context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'error')
  assert.equal(context.wallet, alice)

  assert.equal(await context.authenticate(), true)
  context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'authenticated')
  assert.equal(state.signatures, 2)
})

test('a wrong-wallet server session requests exactly one login for the connected wallet', async () => {
  state.serverWallet = bob
  const context = render(MarketplaceSessionProvider)
  runEffects()
  await Promise.all([context.request('/api/calls'), context.request('/api/seller/calls')])
  assert.equal(state.signatures, 1)
  assert.equal(state.serverWallet, alice)
})

test('Strict Mode effect replay cannot turn a valid pending session check into a signature prompt', async () => {
  state.serverWallet = alice
  state.deferSessionBodies = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.pendingSessionBodies.length, 1)

  replayEffects()
  await flush()
  assert.equal(state.signatures, 0)
  releaseSessionBodies()
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'authenticated')
  assert.equal(state.signatures, 0)
})

test('navigation, data refresh, and provider rerenders reuse the valid server session', async () => {
  let context = await connect()
  assert.equal(state.signatures, 1)
  await context.request('/api/calls')
  await context.request('/api/apis?seller_wallet=' + alice)
  context = render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  await context.request('/api/seller/statistics/' + alice)
  assert.equal(state.signatures, 1)
})

test('wallet in-app browser remount reuses the successful login in the same browser context', async () => {
  await connect()
  assert.equal(state.signatures, 1)
  remount()
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'authenticated')
  assert.equal(context.wallet, alice)
  assert.notEqual(context.status, 'signing')
  assert.equal(state.signatures, 1)
})

test('wallet A to B requires one B login and never reuses the A session', async () => {
  let context = await connect()
  assert.equal(state.serverWallet, alice)
  state.address = bob
  context = render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  context = render(MarketplaceSessionProvider)
  await context.request('/api/calls?buyer_wallet=' + bob)
  assert.equal(state.serverWallet, bob)
  assert.equal(state.signatures, 2)
  assert.ok(state.fetches.some((item: { input: string }) => item.input.includes(`wallet=${encodeURIComponent(bob)}`)))
})

test('wallet switching serializes login prompts and ignores the late wallet A completion', async () => {
  state.deferSignatures = true
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.signatures, 1)

  state.address = bob
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.signatures, 1, 'wallet B prompt opened while wallet A signing was unresolved')

  state.pendingSignatures.shift().resolve(`0x${'33'.repeat(65)}`)
  await flush()
  assert.equal(state.signatures, 2)
  state.pendingSignatures.shift().resolve(`0x${'33'.repeat(65)}`)
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.wallet, bob)
  assert.equal(context.status, 'authenticated')
  assert.equal(state.serverWallet, bob)
})

test('disconnect clears authenticated client state and revokes the browser session', async () => {
  await connect()
  state.address = null
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'disconnected')
  assert.equal(state.serverWallet, null)
  await assert.rejects(context.request('/api/calls'), /Connect your wallet first/)
})

test('rejected login does not reopen automatically and explicit sign-in retries once', async () => {
  state.rejectNextSignature = true
  let context = render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'unauthenticated')
  assert.notEqual(context.status, 'signing')
  assert.equal(state.signatures, 1)
  render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  assert.equal(state.signatures, 1)
  assert.equal(await context.authenticate(), true)
  assert.equal(state.signatures, 2)
})

test('an operation-specific 401 is returned without replaying a mutation', async () => {
  const context = await connect()
  state.protectedError = 'Nonce has already been used.'
  const response = await context.request('/api/seller/withdraw', { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
  assert.equal(state.protectedFetches.filter((url: string) => url === '/api/seller/withdraw').length, 1)
  assert.equal(state.signatures, 1)
})
