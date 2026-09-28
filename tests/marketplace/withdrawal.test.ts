import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from './fixtures'
import { buildConfirmMessage, buildWithdrawMessage } from '../../src/lib/withdraw-auth-message'
import { POST as withdraw } from '../../src/app/api/seller/withdraw/route'
import { POST as confirm } from '../../src/app/api/seller/withdraw/confirm/route'
import { resetWithdrawalState, withdrawalState } from './withdrawal-register.mjs'

beforeEach(() => { reset(); resetWithdrawalState() })

function request(path: string, body: unknown, session: typeof alice | typeof bob | null = alice) {
  return new NextRequest(origin + path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...(session ? sessionHeaders(session) : {}) },
    body: JSON.stringify(body),
  })
}

test('withdrawal requires both the owner session and a fresh withdrawal signature', async () => {
  const signed = await withdrawalBody()
  assert.equal((await withdraw(request('/api/seller/withdraw', signed, null))).status, 401)
  assert.equal((await withdraw(request('/api/seller/withdraw', signed, bob))).status, 403)
  assert.equal((await withdraw(request('/api/seller/withdraw', { seller_wallet: alice.address, amount_usdc: 1 }))).status, 401)
  assert.equal(state.tables.withdraw_used_nonces.length, 0)
})

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
  assert.equal((await first.json()).error, 'Insufficient withdrawable balance.')
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

function fundSeller(amount = 5) {
  state.tables.api_listings.push({ id: 'seller-api', seller_wallet: alice.address.toLowerCase() })
  state.tables.purchases.push({ id: 'seller-purchase', api_id: 'seller-api', seller_share_usdc: amount })
}

test('failure before transfer submission safely releases the reservation', async () => {
  fundSeller(); withdrawalState.gasPriceFails = true
  const response = await withdraw(request('/api/seller/withdraw', await withdrawalBody({ nonce: 'pre-submit-failure' })))
  assert.equal(response.status, 503)
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(state.tables.seller_withdrawals[0].status, 'expired')
})

test('ambiguous Gateway outcomes remain locked and are never automatically resubmitted', async () => {
  for (const mode of ['timeout', '500', 'malformed', 'success-false']) {
    reset(); resetWithdrawalState(); fundSeller(1); withdrawalState.transferMode = mode
    const response = await withdraw(request('/api/seller/withdraw', await withdrawalBody({ nonce: `ambiguous-${mode}` })))
    assert.equal(response.status, 502, mode)
    const row = state.tables.seller_withdrawals[0]
    assert.equal(row.status, 'submission_unknown', mode)
    assert.equal(withdrawalState.transferCalls, 1, mode)

    const retry = await withdraw(request('/api/seller/withdraw', await withdrawalBody({ nonce: `retry-${mode}` })))
    assert.equal(retry.status, 400, mode)
    assert.equal(withdrawalState.transferCalls, 1, mode)
    const recovery = await confirm(request('/api/seller/withdraw/confirm', await confirmationBody({
      withdrawalId: row.id, nonce: `confirm-${mode}`,
    })))
    assert.equal(recovery.status, 409, mode)
    assert.equal(withdrawalState.transferCalls, 1, mode)
  }
})

test('explicit validation rejection proves non-execution and releases the reservation', async () => {
  fundSeller(); withdrawalState.transferMode = 'rejected'
  const response = await withdraw(request('/api/seller/withdraw', await withdrawalBody({ nonce: 'definite-rejection' })))
  assert.equal(response.status, 502)
  assert.equal(state.tables.seller_withdrawals[0].status, 'expired')
  assert.equal(withdrawalState.mintCalls, 0)
})

test('queryable confirmed failure releases an unknown reservation without replaying transfer', async () => {
  fundSeller(); withdrawalState.transferMode = 'malformed-with-id'
  await withdraw(request('/api/seller/withdraw', await withdrawalBody({ nonce: 'queryable-unknown' })))
  const row = state.tables.seller_withdrawals[0]
  assert.equal(row.status, 'submission_unknown')
  withdrawalState.transferMode = 'status-failed'
  const response = await confirm(request('/api/seller/withdraw/confirm', await confirmationBody({
    withdrawalId: row.id, nonce: 'confirm-failed-transfer',
  })))
  assert.equal(response.status, 502)
  assert.equal(row.status, 'expired')
  assert.equal(withdrawalState.transferCalls, 1)
  assert.equal(withdrawalState.statusCalls, 1)
  assert.equal(withdrawalState.mintCalls, 0)
})

test('the same confirmation proof can resume a pending reconciliation without duplicating transfer or mint', async () => {
  fundSeller()
  state.tables.seller_withdrawals.push({
    id: 'withdrawal-fixture', seller_wallet: alice.address.toLowerCase(), status: 'submission_unknown',
    gateway_transfer_id: 'transfer-fixture', mint_tx_hash: null, attestation: null, attestation_signature: null,
  })
  withdrawalState.transferMode = 'status-pending'
  const body = await confirmationBody({ nonce: 'pending-confirmation-retry' })
  const pending = await confirm(request('/api/seller/withdraw/confirm', body))
  assert.equal(pending.status, 202)
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(withdrawalState.mintCalls, 0)

  withdrawalState.transferMode = 'success'
  const completed = await confirm(request('/api/seller/withdraw/confirm', body))
  assert.equal(completed.status, 200)
  assert.equal((await completed.json()).status, 'minted')
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(withdrawalState.statusCalls, 2)
  assert.equal(withdrawalState.mintCalls, 1)
})

test('confirmed success mints exactly once and repeated confirmation is idempotent', async () => {
  fundSeller()
  const response = await withdraw(request('/api/seller/withdraw', await withdrawalBody({ nonce: 'successful-withdrawal' })))
  assert.equal(response.status, 200)
  const row = state.tables.seller_withdrawals[0]
  assert.equal(row.status, 'minted')
  assert.equal(withdrawalState.transferCalls, 1)
  assert.equal(withdrawalState.mintCalls, 1)

  const body = await confirmationBody({ withdrawalId: row.id, nonce: 'idempotent-confirm' })
  for (let attempt = 0; attempt < 2; attempt++) {
    const repeated = await confirm(request('/api/seller/withdraw/confirm', body))
    assert.equal(repeated.status, 200)
    assert.equal((await repeated.json()).status, 'minted')
  }
  assert.equal(withdrawalState.transferCalls, 1)
  assert.equal(withdrawalState.mintCalls, 1)
})
