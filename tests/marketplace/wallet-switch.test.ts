import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { MarketplaceSessionProvider } from '../../src/components/MarketplaceSessionProvider'
import { alice, bob, flush, releaseSessionBodies, remount, render, replayEffects, reset, runEffects,
  state } from './wallet-switch-register.mjs'

beforeEach(reset)

async function connect() {
  let context = render(MarketplaceSessionProvider)
  runEffects()
  await flush()
  context = render(MarketplaceSessionProvider)
  return context
}

test('initial connection and simultaneous private requests share one login signature', async () => {
  const context = render(MarketplaceSessionProvider)
  runEffects()
  const reads = [context.request('/api/calls'), context.request('/api/seller/calls'), context.request('/api/gateway/balance')]
  await Promise.all(reads)
  assert.equal(state.signatures, 1)
  assert.deepEqual(state.protectedFetches, ['/api/calls', '/api/seller/calls', '/api/gateway/balance'])
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

  releaseSessionBodies()
  await flush()
  const context = render(MarketplaceSessionProvider)
  assert.equal(context.status, 'authenticated')
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
