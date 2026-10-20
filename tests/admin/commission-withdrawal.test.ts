import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { POST as quoteRoute } from '../../src/app/api/admin/operations/gateway-treasury/withdraw/quote/route'
import { POST as withdrawRoute } from '../../src/app/api/admin/operations/gateway-treasury/withdraw/route'
import { POST as reconcileRoute } from '../../src/app/api/admin/operations/gateway-treasury/withdraw/reconcile/route'
import { executeCommissionWithdrawal, hasArcMintGas, quoteCommission, reconcileCommissionWithdrawal,
  type CommissionRow, type CommissionQuote } from '../../src/lib/admin/commission-withdrawal'

const wallet = '0x052650D1764406d702252B20B2294346A594A1ef'
const quote: CommissionQuote = {
  amount_usdc: '1.000000', source_fee_estimate_usdc: '0.003500',
  source_fee_cap_usdc: '0.004700', destination_gas_estimate_usdc: '0.001200',
  mint_value_usdc: '0.995300', max_block_height: '28240516', destination: wallet,
}

function fixture(options: { transfer?: 'accepted' | 'unknown'; preflightFails?: boolean;
  mintFails?: boolean; transferId?: string | null } = {}) {
  let row: CommissionRow | null = null
  const calls = { reserve: 0, sign: 0, submit: 0, mint: 0, receipt: 0, transferStatus: 0 }
  const deps = {
    store: {
      async reserve() {
        calls.reserve++
        row ??= { id: '00000000-0000-4000-8000-000000000001', status: 'reserved',
          amount_usdc: quote.amount_usdc, mint_value_usdc: quote.mint_value_usdc,
          source_fee_cap_usdc: quote.source_fee_cap_usdc,
          destination_gas_estimate_usdc: quote.destination_gas_estimate_usdc }
        return { ...row }
      },
      async get() { return row ? { ...row } : null },
      async transition(_id: string, from: string, update: Record<string, unknown>) {
        if (!row || row.status !== from) return false
        row = { ...row, ...update }
        return true
      },
    },
    services: {
      async preflight() { if (options.preflightFails) throw new Error('Gateway balance changed') },
      async sign(intent: { maxBlockHeight: bigint }) {
        assert.equal(intent.maxBlockHeight, BigInt(quote.max_block_height))
        calls.sign++
        return '0xcc' as const
      },
      async submit() {
        calls.submit++
        if (options.transfer === 'unknown') return {
          status: 502, body: options.transferId ? { transferId: options.transferId } : null,
        }
        return { status: 200, body: { attestation: '0xaa', signature: '0xbb', transferId: 'circle-id' } }
      },
      async mint() { calls.mint++; if (options.mintFails) throw new Error('RPC timeout'); return '0xdd' as const },
      async receipt() { calls.receipt++; return 'success' as const },
      async transferStatus() {
        calls.transferStatus++
        return { status: 'confirmed', attestation: { payload: '0xaa', signature: '0xbb' } }
      },
    },
  }
  return { deps, calls, row: () => row }
}

const input = { idempotencyKey: '00000000-0000-4000-8000-000000000099', quote,
  gatewayAvailable: '2.000000', platform: wallet }

test('read-only Circle estimate separates Gateway fee cap from Arc destination gas', async () => {
  let called = false
  const estimate = await quoteCommission(BigInt(1_000_000), wallet, {
    fetchEstimate: async (_url, init) => {
      called = true
      const [{ spec }] = JSON.parse(String(init?.body))
      assert.equal(spec.sourceDomain, 26)
      assert.equal(spec.destinationDomain, 26)
      assert.equal(spec.value, '1000000')
      assert.equal(spec.destinationRecipient.toLowerCase().slice(-40), wallet.toLowerCase().slice(2))
      return Response.json([{ burnIntent: { maxFee: '3500', maxBlockHeight: '28240516', spec } }])
    },
    getGasPrice: async () => BigInt(7_000_000_000),
  })
  assert.equal(called, true)
  assert.equal(estimate.source_fee_cap_usdc, '0.004700')
  assert.equal(estimate.mint_value_usdc, '0.995300')
  assert.equal(estimate.max_block_height, '28240516')
  assert.notEqual(estimate.destination_gas_estimate_usdc, estimate.source_fee_cap_usdc)
  await assert.rejects(quoteCommission(BigInt(50_000), wallet, {
    fetchEstimate: async () => Response.json([{ burnIntent: { maxFee: '49000',
      maxBlockHeight: '28240516', spec: { value: '50000', sourceDomain: 26, destinationDomain: 26 } } }]),
    getGasPrice: async () => BigInt(7_000_000_000),
  }), /does not cover Gateway source fee/)
  await assert.rejects(quoteCommission(BigInt(1_000_000), '0x0000000000000000000000000000000000000001', {
    fetchEstimate: async () => { throw new Error('must not fetch') }, getGasPrice: async () => BigInt(1),
  }), /destination mismatch/)
})

test('Arc mint gas must be separately available in the platform wallet', () => {
  assert.equal(hasArcMintGas(BigInt(1_199_999_999_999_999), '0.001200'), false)
  assert.equal(hasArcMintGas(BigInt(1_200_000_000_000_000), '0.001200'), true)
})

test('durable path mints once and idempotent repeat never submits another Gateway transfer', async () => {
  const f = fixture()
  const first = await executeCommissionWithdrawal(f.deps, input)
  assert.equal(first.status, 'minted')
  assert.equal(first.mint_tx_hash, '0xdd')
  assert.deepEqual(f.calls, { reserve: 1, sign: 1, submit: 1, mint: 1, receipt: 1, transferStatus: 0 })
  const again = await executeCommissionWithdrawal(f.deps, input)
  assert.equal(again.status, 'minted')
  assert.equal(f.calls.submit, 1)
  assert.equal(f.calls.mint, 1)
})

test('two concurrent attempts with one idempotency key submit exactly once', async () => {
  const f = fixture()
  await Promise.all([
    executeCommissionWithdrawal(f.deps, input),
    executeCommissionWithdrawal(f.deps, input),
  ])
  assert.equal(f.calls.submit, 1)
  assert.equal(f.calls.mint, 1)
})

test('changed balance expires reservation before signing or sending', async () => {
  const f = fixture({ preflightFails: true })
  assert.equal((await executeCommissionWithdrawal(f.deps, input)).status, 'expired')
  assert.equal(f.calls.sign, 0)
  assert.equal(f.calls.submit, 0)
})

test('ambiguous Circle response keeps funds locked and never blindly reposts', async () => {
  const f = fixture({ transfer: 'unknown' })
  assert.equal((await executeCommissionWithdrawal(f.deps, input)).status, 'submission_unknown')
  assert.equal((await executeCommissionWithdrawal(f.deps, input)).status, 'submission_unknown')
  assert.equal((await reconcileCommissionWithdrawal(f.deps, f.row()!.id))?.status, 'submission_unknown')
  assert.equal(f.calls.submit, 1)
  assert.equal(f.calls.mint, 0)
})

test('known Circle transfer ID recovers attestation and mints without resubmitting transfer', async () => {
  const f = fixture({ transfer: 'unknown', transferId: 'circle-known' })
  await executeCommissionWithdrawal(f.deps, input)
  assert.equal((await reconcileCommissionWithdrawal(f.deps, f.row()!.id))?.status, 'minted')
  assert.equal(f.calls.transferStatus, 1)
  assert.equal(f.calls.submit, 1)
  assert.equal(f.calls.mint, 1)
})

test('uncertain Arc mint without a hash requires manual review, never resubmits', async () => {
  const f = fixture({ mintFails: true })
  assert.equal((await executeCommissionWithdrawal(f.deps, input)).status, 'mint_unknown')
  assert.equal((await reconcileCommissionWithdrawal(f.deps, f.row()!.id))?.status, 'mint_unknown')
  assert.equal(f.calls.mint, 1)
})

test('a manually established Arc mint hash can be reconciled by receipt without resending', async () => {
  const f = fixture({ mintFails: true })
  const initial = await executeCommissionWithdrawal(f.deps, input)
  assert.equal(initial.status, 'mint_unknown')
  assert.equal(await f.deps.store.transition(initial.id, 'mint_unknown', { mint_tx_hash: '0xdd' }), true)
  assert.equal((await reconcileCommissionWithdrawal(f.deps, initial.id))?.status, 'minted')
  assert.equal(f.calls.mint, 1)
  assert.equal(f.calls.receipt, 1)
})

test('all commission withdrawal endpoints require Admin authorization', async () => {
  for (const [url, route] of [
    ['quote', quoteRoute], ['withdraw', withdrawRoute], ['reconcile', reconcileRoute],
  ] as const) {
    const request = new NextRequest(`https://mahshar.xyz/api/admin/operations/gateway-treasury/withdraw/${url}`, {
      method: 'POST', body: JSON.stringify({ amount_usdc: '1.0', confirm: true }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://mahshar.xyz' },
    })
    const response = await route(request)
    assert.equal(response.status, 401)
  }
})


test('an interrupted pre-submission operation can be cancelled without any transfer replay', async () => {
  const f = fixture()
  const row = await f.deps.store.reserve()
  await f.deps.store.transition(row.id, 'reserved', { status: 'preparing' })
  assert.equal((await reconcileCommissionWithdrawal(f.deps, row.id))?.status, 'expired')
  assert.equal(f.calls.sign, 0)
  assert.equal(f.calls.submit, 0)
  assert.equal(f.calls.mint, 0)
})

test('pre-submission cancellation fences a concurrently running signer', async () => {
  const f = fixture()
  let begin!: () => void
  let finish!: () => void
  const signing = new Promise<void>(resolve => { begin = resolve })
  const release = new Promise<void>(resolve => { finish = resolve })
  const sign = f.deps.services.sign
  f.deps.services.sign = async intent => { begin(); await release; return sign(intent) }
  const executing = executeCommissionWithdrawal(f.deps, input)
  await signing
  assert.equal((await reconcileCommissionWithdrawal(f.deps, f.row()!.id))?.status, 'expired')
  finish()
  assert.equal((await executing).status, 'expired')
  assert.equal(f.calls.submit, 0)
  assert.equal(f.calls.mint, 0)
})
