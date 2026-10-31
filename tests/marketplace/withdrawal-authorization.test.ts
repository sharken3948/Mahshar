import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { hashMessage, pad, type Hex } from 'viem'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from './fixtures'
import { buildConfirmMessage, buildWithdrawMessage, WITHDRAW_TIMESTAMP_WINDOW_SECONDS } from '../../src/lib/withdraw-auth-message'
import { POST as withdraw } from '../../src/app/api/seller/withdraw/route'
import { POST as confirm } from '../../src/app/api/seller/withdraw/confirm/route'
import { resetWithdrawalState, withdrawalState } from './withdrawal-register.mjs'

type Endpoint = 'withdraw' | 'confirm'
type Seller = { address: Hex }
const contract: Seller = { address: `0x${'77'.repeat(20)}` }
const path = (endpoint: Endpoint) => `/api/seller/withdraw${endpoint === 'confirm' ? '/confirm' : ''}`
const handler = (endpoint: Endpoint) => endpoint === 'confirm' ? confirm : withdraw

beforeEach(() => { reset(); resetWithdrawalState() })

function seed(endpoint: Endpoint, seller: Seller) {
  state.tables.api_listings.push({ id: 'seller-api', seller_wallet: seller.address.toLowerCase() })
  state.tables.purchases.push({ id: 'seller-purchase', api_id: 'seller-api', seller_share_usdc: 5 })
  if (endpoint === 'confirm') state.tables.seller_withdrawals.push({
    id: 'withdrawal-fixture', seller_wallet: seller.address.toLowerCase(), status: 'minted',
    amount_usdc: 1, mint_tx_hash: `0x${'aa'.repeat(32)}`,
  })
}

function financialSnapshot() {
  return structuredClone({
    nonces: state.tables.withdraw_used_nonces,
    withdrawals: state.tables.seller_withdrawals,
    purchases: state.tables.purchases,
    listings: state.tables.api_listings,
  })
}

function request(endpoint: Endpoint, body: unknown, seller: Seller | null, options: { expired?: boolean; revoked?: boolean } = {}) {
  return new NextRequest(origin + path(endpoint), {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json',
      ...(seller ? sessionHeaders({ ...alice, address: seller.address }, options) : {}) },
    body: JSON.stringify(body),
  })
}

async function proof(endpoint: Endpoint, seller: Seller, options: {
  timestamp?: string; signer?: typeof alice; approveContract?: boolean; messageOverride?: (message: string) => string
} = {}) {
  const timestamp = options.timestamp ?? new Date().toISOString()
  const nonce = `${endpoint}-authorization-fixture`
  const message = endpoint === 'withdraw'
    ? buildWithdrawMessage({ sellerWallet: seller.address, amountUsdc: '1.000000', timestamp, nonce })
    : buildConfirmMessage({ sellerWallet: seller.address, withdrawalId: 'withdrawal-fixture', timestamp, nonce })
  const signedMessage = options.messageOverride?.(message) ?? message
  const signature = options.signer ? await options.signer.signMessage({ message: signedMessage })
    : seller.address === contract.address ? '0x1234' as Hex : await alice.signMessage({ message: signedMessage })
  if (seller.address === contract.address) {
    withdrawalState.verification.contracts[seller.address.toLowerCase()] = options.approveContract === false ? []
      : [{ hash: hashMessage(signedMessage), signature }]
  }
  return { seller_wallet: seller.address, amount_usdc: 1, withdrawal_id: 'withdrawal-fixture', timestamp, nonce, signature }
}

async function rejectsWithoutFinancialEffects(endpoint: Endpoint, body: unknown, seller: Seller | null, expected = 401,
  sessionOptions: { expired?: boolean; revoked?: boolean } = {}) {
  const before = financialSnapshot()
  const response = await handler(endpoint)(request(endpoint, body, seller, sessionOptions))
  assert.equal(response.status, expected, JSON.stringify(await response.json()))
  assert.deepEqual(financialSnapshot(), before)
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(withdrawalState.statusCalls, 0)
  assert.equal(withdrawalState.mintCalls, 0)
}

for (const endpoint of ['withdraw', 'confirm'] as const) {
  test(`${endpoint}: valid EOA proof still succeeds with the seller session`, async () => {
    seed(endpoint, alice)
    const response = await handler(endpoint)(request(endpoint, await proof(endpoint, alice), alice))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'minted')
    assert.equal(state.tables.withdraw_used_nonces.length, 1)
    assert.ok(withdrawalState.verification.clientChains.every((id: number) => id === 5042))
    assert.ok(withdrawalState.verification.calls.some((call: { method: string }) => call.method === 'eth_getCode'))
    assert.ok(!withdrawalState.verification.calls.some((call: { method: string }) => call.method === 'eth_call'))
  })

  test(`${endpoint}: ERC-1271 approves the exact message at the seller contract address`, async () => {
    seed(endpoint, contract)
    const body = await proof(endpoint, contract)
    const response = await handler(endpoint)(request(endpoint, body, contract))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'minted')
    const calls = withdrawalState.verification.calls.filter((call: { method: string }) => call.method === 'eth_call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].params[0].to.toLowerCase(), contract.address.toLowerCase())
    assert.ok(withdrawalState.verification.clientChains.every((id: number) => id === 5042))
    assert.equal(state.tables.withdraw_used_nonces[0].seller_wallet, contract.address.toLowerCase())
    if (endpoint === 'withdraw') {
      const row = state.tables.seller_withdrawals[0]
      assert.equal(row.seller_wallet, contract.address.toLowerCase())
      assert.equal(row.network_id, 'eip155:5042')
      assert.equal(row.amount_usdc, 1)
      assert.equal(row.burn_intent.spec.destinationRecipient, pad(contract.address, { size: 32 }))
      assert.equal(row.net_amount_usdc + row.gas_cost_usdc, 1)
      assert.equal(withdrawalState.transferCalls, 1)
      assert.equal(withdrawalState.mintCalls, 1)
    }
  })

  test(`${endpoint}: invalid ERC-1271 signature cannot consume a nonce or change financial state`, async () => {
    seed(endpoint, contract)
    const body = await proof(endpoint, contract)
    await rejectsWithoutFinancialEffects(endpoint, { ...body, signature: '0xdeadbeef' }, contract)
  })

  test(`${endpoint}: owner EOA signature alone cannot impersonate its contract wallet`, async () => {
    seed(endpoint, contract)
    const body = await proof(endpoint, contract, { signer: alice, approveContract: false })
    await rejectsWithoutFinancialEffects(endpoint, body, contract)
    await rejectsWithoutFinancialEffects(endpoint, body, alice, 403)
  })

  test(`${endpoint}: contract rejection cannot fall back to EOA recovery at a delegated address`, async () => {
    seed(endpoint, alice)
    const body = await proof(endpoint, alice)
    withdrawalState.verification.contracts[alice.address.toLowerCase()] = []
    await rejectsWithoutFinancialEffects(endpoint, body, alice)
  })

  test(`${endpoint}: wrong EOA signer fails despite a valid seller session`, async () => {
    seed(endpoint, alice)
    await rejectsWithoutFinancialEffects(endpoint, await proof(endpoint, alice, { signer: bob }), alice)
  })

  for (const seller of [alice, contract]) {
    const kind = seller === alice ? 'EOA' : 'ERC-1271'
    test(`${endpoint}: ${kind} authorization fails on a non-Arc RPC`, async () => {
      seed(endpoint, seller)
      const body = await proof(endpoint, seller)
      withdrawalState.verification.chainId = 1
      await rejectsWithoutFinancialEffects(endpoint, body, seller)
      assert.deepEqual(withdrawalState.verification.calls.map((call: { method: string }) => call.method), ['eth_chainId'])
    })

    for (const failMethod of ['eth_chainId', 'eth_getCode']) {
      test(`${endpoint}: ${kind} ${failMethod} failure rejects even an otherwise valid proof`, async () => {
        seed(endpoint, seller)
        const body = await proof(endpoint, seller)
        withdrawalState.verification.failMethod = failMethod
        await rejectsWithoutFinancialEffects(endpoint, body, seller)
      })
    }

    test(`${endpoint}: ${kind} expired proof fails before RPC or nonce consumption`, async () => {
      seed(endpoint, seller)
      const body = await proof(endpoint, seller, {
        timestamp: new Date(Date.now() - (WITHDRAW_TIMESTAMP_WINDOW_SECONDS + 60) * 1000).toISOString(),
      })
      await rejectsWithoutFinancialEffects(endpoint, body, seller)
      assert.equal(withdrawalState.verification.calls.length, 0)
    })

    test(`${endpoint}: ${kind} proof cannot authorize another message domain`, async () => {
      seed(endpoint, seller)
      const body = await proof(endpoint, seller, { messageOverride: message => message.replace('mahshar.xyz', 'other.invalid') })
      await rejectsWithoutFinancialEffects(endpoint, body, seller)
    })
  }

  for (const mode of ['invalid-magic', 'revert', 'malformed', 'rpc-error']) {
    test(`${endpoint}: ERC-1271 ${mode} fails closed`, async () => {
      seed(endpoint, contract)
      const body = await proof(endpoint, contract)
      if (mode === 'rpc-error') withdrawalState.verification.failMethod = 'eth_call'
      else withdrawalState.verification.contractMode = mode
      await rejectsWithoutFinancialEffects(endpoint, body, contract)
    })
  }

  test(`${endpoint}: missing, expired and revoked contract-wallet sessions reject before verification`, async () => {
    seed(endpoint, contract)
    const body = await proof(endpoint, contract)
    await rejectsWithoutFinancialEffects(endpoint, body, null)
    await rejectsWithoutFinancialEffects(endpoint, body, contract, 401, { expired: true })
    await rejectsWithoutFinancialEffects(endpoint, body, contract, 401, { revoked: true })
    assert.equal(withdrawalState.verification.calls.length, 0)
  })

  test(`${endpoint}: ERC-1271 proof remains bound to amount or withdrawal ID`, async () => {
    seed(endpoint, contract)
    const body = await proof(endpoint, contract)
    const tampered = endpoint === 'withdraw' ? { ...body, amount_usdc: 2 } : { ...body, withdrawal_id: 'another-withdrawal' }
    await rejectsWithoutFinancialEffects(endpoint, tampered, contract)
  })
}

test('ERC-1271 initial withdrawal replay cannot create a second reservation or payment', async () => {
  seed('withdraw', contract)
  const body = await proof('withdraw', contract)
  assert.equal((await withdraw(request('withdraw', body, contract))).status, 200)
  const before = financialSnapshot()
  assert.equal((await withdraw(request('withdraw', body, contract))).status, 401)
  assert.deepEqual(financialSnapshot(), before)
  assert.equal(withdrawalState.transferCalls, 1)
  assert.equal(withdrawalState.mintCalls, 1)
})

test('ERC-1271 confirmation rechecks the proof and ownership on idempotent replay', async () => {
  seed('confirm', contract)
  const body = await proof('confirm', contract)
  assert.equal((await confirm(request('confirm', body, contract))).status, 200)
  const before = financialSnapshot()
  assert.equal((await confirm(request('confirm', body, contract))).status, 200)
  assert.deepEqual(financialSnapshot(), before)
  withdrawalState.verification.contractMode = 'invalid-magic'
  await rejectsWithoutFinancialEffects('confirm', body, contract)
  withdrawalState.verification.contractMode = 'valid'
  state.tables.seller_withdrawals[0].seller_wallet = bob.address.toLowerCase()
  await rejectsWithoutFinancialEffects('confirm', body, contract)
})

test('ERC-1271 authorization does not bypass balance checks', async () => {
  const body = await proof('withdraw', contract)
  const response = await withdraw(request('withdraw', body, contract))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'Insufficient withdrawable balance.')
  assert.equal(state.tables.withdraw_used_nonces.length, 1)
  assert.equal(state.tables.seller_withdrawals.length, 0)
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(withdrawalState.mintCalls, 0)
})

test('ERC-1271 confirmation leaves ambiguous submissions locked without resubmission', async () => {
  seed('confirm', contract)
  const body = await proof('confirm', contract)
  for (const status of ['submission_unknown', 'mint_unknown']) {
    Object.assign(state.tables.seller_withdrawals[0], { status, mint_tx_hash: null, gateway_transfer_id: null })
    const before = structuredClone(state.tables.seller_withdrawals)
    assert.equal((await confirm(request('confirm', body, contract))).status, 409)
    assert.deepEqual(state.tables.seller_withdrawals, before)
  }
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(withdrawalState.mintCalls, 0)
})

test('ERC-1271 confirmation claims a pending attestation once and preserves its destination', async () => {
  seed('confirm', contract)
  Object.assign(state.tables.seller_withdrawals[0], {
    status: 'pending_mint', mint_tx_hash: null,
    attestation: `0x${'ab'.repeat(32)}`, attestation_signature: `0x${'cd'.repeat(65)}`,
    burn_intent: { spec: { destinationRecipient: pad(contract.address, { size: 32 }) } },
  })
  const body = await proof('confirm', contract)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await confirm(request('confirm', body, contract))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'minted')
  }
  assert.equal(state.tables.seller_withdrawals.length, 1)
  assert.equal(state.tables.seller_withdrawals[0].amount_usdc, 1)
  assert.equal(state.tables.seller_withdrawals[0].burn_intent.spec.destinationRecipient, pad(contract.address, { size: 32 }))
  assert.equal(state.tables.withdraw_used_nonces.length, 1)
  assert.equal(withdrawalState.transferCalls, 0)
  assert.equal(withdrawalState.mintCalls, 1)
})
