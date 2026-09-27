import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, state } from './fixtures'
import { buildConfirmMessage, buildWithdrawMessage } from '../../src/lib/withdraw-auth-message'
import { POST as withdraw } from '../../src/app/api/seller/withdraw/route'
import { POST as confirm } from '../../src/app/api/seller/withdraw/confirm/route'

beforeEach(reset)

function request(path: string, body: unknown) {
  return new NextRequest(origin + path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function withdrawalBody(options: { wallet?: string; amount?: number; nonce?: string; signer?: typeof alice } = {}) {
  const seller_wallet = options.wallet ?? alice.address
  const amount_usdc = options.amount ?? 1
  const timestamp = new Date().toISOString()
  const nonce = options.nonce ?? 'withdraw-fixture'
  const message = buildWithdrawMessage({ sellerWallet: seller_wallet, amountUsdc: amount_usdc.toFixed(6), timestamp, nonce })
  const signature = await (options.signer ?? alice).signMessage({ message })
  return { seller_wallet, amount_usdc, timestamp, nonce, signature }
}

async function confirmationBody(options: { wallet?: string; withdrawalId?: string; nonce?: string; signer?: typeof alice } = {}) {
  const seller_wallet = options.wallet ?? alice.address
  const withdrawal_id = options.withdrawalId ?? 'withdrawal-fixture'
  const timestamp = new Date().toISOString()
  const nonce = options.nonce ?? 'confirm-fixture'
  const message = buildConfirmMessage({ sellerWallet: seller_wallet, withdrawalId: withdrawal_id, timestamp, nonce })
  const signature = await (options.signer ?? alice).signMessage({ message })
  return { withdrawal_id, seller_wallet, timestamp, nonce, signature }
}

test('withdrawal requires an amount-bound signature and does not consume an invalid proof', async () => {
  const signed = await withdrawalBody({ amount: 1 })
  const response = await withdraw(request('/api/seller/withdraw', { ...signed, amount_usdc: 2 }))
  assert.equal(response.status, 401)
  assert.equal(state.tables.withdraw_used_nonces.length, 0)
})

test('withdrawal consumes a valid nonce before seller accounting and rejects replay', async () => {
  const body = await withdrawalBody()
  const first = await withdraw(request('/api/seller/withdraw', body))
  assert.equal(first.status, 400)
  assert.equal((await first.json()).error, 'No listings for this seller')
  assert.equal(state.tables.withdraw_used_nonces.length, 1)

  const replay = await withdraw(request('/api/seller/withdraw', body))
  assert.equal(replay.status, 401)
  assert.equal((await replay.json()).error, 'Nonce has already been used.')
})

test('withdrawal rejects a signature from a wallet other than the claimed seller', async () => {
  const body = await withdrawalBody({ wallet: alice.address, signer: bob })
  const response = await withdraw(request('/api/seller/withdraw', body))
  assert.equal(response.status, 401)
  assert.equal(state.tables.withdraw_used_nonces.length, 0)
})

test('withdrawal confirmation preserves nonce replay and row ownership protection', async () => {
  state.tables.seller_withdrawals.push({ id: 'withdrawal-fixture', seller_wallet: bob.address, status: 'pending_mint' })
  const body = await confirmationBody()

  const first = await confirm(request('/api/seller/withdraw/confirm', body))
  assert.equal(first.status, 403)
  assert.equal((await first.json()).error, 'Withdrawal does not belong to this seller')
  assert.equal(state.tables.withdraw_used_nonces.length, 1)

  const replay = await confirm(request('/api/seller/withdraw/confirm', body))
  assert.equal(replay.status, 401)
  assert.equal((await replay.json()).error, 'Nonce has already been used.')
})
