import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { useWalletAuthorization } from '../../src/hooks/useWalletAuthorization'
import { OPERATION_AUTH_HEADER } from '../../src/lib/marketplace/operation-authorization'
import { alice, bob, reset, signature, state } from './wallet-switch-register.mjs'

beforeEach(reset)

test('operation authorization rejects a wallet switch before request submission', async () => {
  const { request } = useWalletAuthorization()
  const pending = request('/api/apis', { method: 'POST', body: JSON.stringify({ name: 'Fixture' }) })
  await setImmediate()
  assert.equal(state.signatures.length, 1)

  state.address = bob
  state.signatures[0].resolve(signature)

  await assert.rejects(pending, /Wallet changed/)
  assert.equal(state.fetches.length, 0)
})

test('operation authorization uses the current wallet and submits exactly once when it stays connected', async () => {
  const { request } = useWalletAuthorization()
  const pending = request('/api/apis?mode=create', { method: 'POST', body: JSON.stringify({ name: 'Fixture' }) })
  await setImmediate()
  assert.equal(state.signatures.length, 1)
  assert.equal(state.signatures[0].input.account, alice)

  state.signatures[0].resolve(signature)
  const response = await pending

  assert.equal(response.status, 200)
  assert.equal(state.fetches.length, 1)
  const headers = new Headers(state.fetches[0].init?.headers)
  const proof = JSON.parse(decodeURIComponent(headers.get(OPERATION_AUTH_HEADER) ?? ''))
  assert.equal(proof.wallet, alice)
  assert.equal(proof.signature, signature)
})
