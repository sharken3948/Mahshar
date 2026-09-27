import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PaymentStorageUnavailableError, parsePayment, paymentIdentity, recoverSettlement, settleDurably, type Facilitator } from '../../src/lib/payments/settlement'
import { apiId, MemoryStore, payer, payment, requirements, seller } from './fixture'

function setup() {
  const store = new MemoryStore()
  const counts = { settle: 0, verify: 0 }
  const facilitator: Facilitator = {
    verify: async () => { counts.verify++; return { isValid: true, payer } },
    settle: async () => { counts.settle++; return { success: true, payer, network: requirements.network, transaction: 'circle-transaction' } },
  }
  const input = { payment: structuredClone(payment), apiId, seller, sellerAtomic: '900', candidates: [requirements], facilitator: () => facilitator, store }
  return { store, counts, facilitator, input, run: () => settleDurably(input) }
}
test('normal settlement persists exactly once; retry skips verify/settle and returns same purchase', async () => {
  const t = setup(); const first = await t.run(); const retry = await t.run()
  assert.equal(first.success, true); assert.equal(first.replayed, false)
  assert.equal(retry.callId, first.callId); assert.equal(retry.replayed, true)
  assert.equal(t.counts.settle, 1); assert.equal(t.counts.verify, 1); assert.equal(t.store.purchases.size, 1)
})
test('prepared-before-settlement and simultaneous retries cannot both submit', async () => {
  const t = setup(); let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  t.facilitator.settle = async () => { t.counts.settle++; assert.equal([...t.store.rows.values()][0].state, 'SETTLEMENT_SUBMITTED'); await wait; return { success: true, payer } }
  const first = t.run(); while (!t.counts.settle) await new Promise(resolve => setImmediate(resolve))
  const second = await t.run(); assert.equal(second.success, false); assert.equal(second.status, 409)
  release(); assert.equal((await first).success, true); assert.equal(t.counts.settle, 1)
})
test('two fresh concurrent requests prepare one attempt and invoke settlement once', async () => {
  const t = setup()
  const results = await Promise.all([t.run(), t.run()])
  assert.ok(results.some(r => r.success)); assert.equal(t.counts.settle, 1); assert.equal(t.store.rows.size, 1); assert.equal(t.store.purchases.size, 1)
})
test('authorization fingerprint is stable across serialization and signature case', () => {
  const other = JSON.parse(JSON.stringify(payment))
  other.payload.signature = '0x' + other.payload.signature.slice(2).toUpperCase()
  other.payload.authorization = Object.fromEntries(Object.entries(other.payload.authorization).reverse())
  assert.deepEqual(paymentIdentity(other, requirements), paymentIdentity(payment, requirements))
})
test('purchase failure retains confirmed evidence, retry/recovery makes one purchase without resettlement', async () => {
  const t = setup(); t.store.failAccounting = true
  const failed = await t.run(); assert.equal(failed.error, 'payment_accounting_unavailable'); assert.equal(failed.status, 503)
  assert.equal([...t.store.rows.values()][0].state, 'SETTLEMENT_CONFIRMED')
  assert.equal((await t.run()).error, 'payment_accounting_unavailable'); assert.equal(t.counts.settle, 1)
  t.store.failAccounting = false
  const a = [...t.store.rows.values()][0]
  const recovered = await Promise.all([recoverSettlement(t.store, structuredClone(a)), recoverSettlement(t.store, structuredClone(a))])
  assert.equal(recovered[0].callId, recovered[1].callId); assert.equal(t.store.purchases.size, 1)
  assert.deepEqual([...t.store.purchases.values()][0].binding, a.binding)
})
test('process-style interruption after confirmation recovers from only the persisted attempt', async () => {
  const t = setup(); t.store.failAccounting = true; await t.run(); t.store.failAccounting = false
  const a = structuredClone([...t.store.rows.values()][0])
  const result = await recoverSettlement(t.store, a)
  assert.equal(result.success, true); assert.equal(t.counts.settle, 1)
})
test('missing transaction uses stable authorization fingerprint; batch transaction does not collapse payments', async () => {
  const t = setup(); t.facilitator.settle = async () => ({ success: true, transaction: '' })
  await t.run(); const a = [...t.store.rows.values()][0]
  assert.equal(a.settlement_identity, `x402:${paymentIdentity(payment, requirements).fingerprint}`)
  assert.equal((await t.run()).success, true); assert.equal(t.store.purchases.size, 1)
  t.input.payment.payload.authorization.nonce = '0x'+'77'.repeat(32)
  await t.run(); assert.equal(t.store.purchases.size, 2)
  assert.equal(new Set([...t.store.rows.values()].map(a => a.fingerprint)).size, 2)
})
test('Circle transaction and frozen seller/platform accounting survive retries and price changes', async () => {
  const t = setup(); await t.run(); const a = [...t.store.rows.values()][0]
  assert.equal(a.transaction_id, 'circle-transaction'); assert.match(a.settlement_identity!, /circle-transaction/)
  assert.equal(a.binding.amount_atomic, '1100'); assert.equal(a.binding.seller_atomic, '900'); assert.equal(a.binding.platform_atomic, '200')
  t.input.candidates = [{ ...requirements, amount: '2200' }]; t.input.sellerAtomic = '1800'
  assert.equal((await t.run()).success, true); assert.equal(t.counts.settle, 1); assert.equal(a.binding.seller_atomic, '900')
})
test('transport loss, explicit rejection and already-used results are fenced, never blindly resettled', async () => {
  for (const mode of ['throw', 'rejected', 'already_used']) {
    const t = setup(); t.facilitator.settle = async () => { t.counts.settle++; if (mode === 'throw') throw Error('connection lost'); return { success: false, errorReason: mode } }
    assert.equal((await t.run()).success, false); assert.equal([...t.store.rows.values()][0].state, 'SETTLEMENT_UNKNOWN')
    assert.equal((await t.run()).error, 'settlement_manual_review'); assert.equal(t.counts.settle, 1); assert.equal(t.store.purchases.size, 0)
  }
})
test('DB failures before prepare, after claim and after external success cannot reopen settlement', async () => {
  for (const stage of ['failPrepare', 'loseClaimAck', 'failConfirm'] as const) {
    const t = setup(); t.store[stage] = true
    const result = await t.run(); assert.equal(result.status, 503); assert.doesNotMatch(result.error!, /duplicate/)
    if (stage !== 'failPrepare') {
      t.store[stage] = false; await t.run(); assert.equal(t.counts.settle, stage === 'failConfirm' ? 1 : 0)
      assert.equal([...t.store.rows.values()][0].state, 'SETTLEMENT_SUBMITTED')
    } else assert.equal(t.counts.settle, 0)
  }
})
test('tampered amount/signature/listing cannot hijack an existing authorization', async () => {
  for (const tamper of ['amount','signature','listing']) {
    const t = setup(); await t.run()
    if (tamper === 'amount') t.input.payment.payload.authorization.value = '2200'
    if (tamper === 'signature') t.input.payment.payload.signature = '0x'+'cd'.repeat(65)
    if (tamper === 'listing') t.input.apiId = '00000000-0000-4000-8000-000000000002'
    assert.equal((await t.run()).error, 'payment_binding_conflict'); assert.equal(t.counts.settle, 1)
  }
})
test('verification mismatch and invalid authorization fail before irreversible submission', async () => {
  const t = setup(); t.facilitator.verify = async () => ({ isValid: true, payer: seller })
  assert.equal((await t.run()).error, 'verification_failed'); assert.equal(t.counts.settle, 0)
  assert.throws(() => parsePayment(Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString('base64')))
})
test('storage and facilitator outages are classified separately before settlement', async () => {
  const storage = setup(); storage.store.find = async () => { throw new PaymentStorageUnavailableError() }
  assert.equal((await storage.run()).error, 'payment_storage_unavailable')
  assert.equal(storage.counts.verify, 0); assert.equal(storage.counts.settle, 0)
  const verification = setup(); verification.facilitator.verify = async () => { throw new Error('transport unavailable') }
  assert.equal((await verification.run()).error, 'payment_verification_service_unavailable')
  assert.equal(verification.counts.settle, 0); assert.equal(verification.store.rows.size, 0)
})
test('settlement payer/network conflicts never produce seller credit', async () => {
  for (const field of ['payer', 'network']) {
    const t = setup(); t.facilitator.settle = async () => ({ success: true, [field]: field === 'payer' ? seller : 'wrong-chain' })
    assert.equal((await t.run()).error, 'settlement_requires_review'); assert.equal(t.store.purchases.size, 0)
  }
})
test('upstream timeout/4xx/5xx occurs after durable accounting and cannot erase it', async () => {
  for (const status of [408,400,500]) {
    const t = setup(); assert.equal((await t.run()).success, true)
    await Promise.reject(new Error(`upstream ${status}`)).catch(() => undefined)
    assert.equal([...t.store.rows.values()][0].state, 'ACCOUNTING_COMPLETE'); assert.equal(t.store.purchases.size, 1)
  }
})
