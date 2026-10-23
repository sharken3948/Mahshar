import './register.mjs'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
const load = Module._load
const { MemoryStore } = load.call(Module, fileURLToPath(new URL('../x402/fixture.ts', import.meta.url)))
const fixture = load.call(Module, fileURLToPath(new URL('../marketplace/fixtures.ts', import.meta.url)))
export const paidBoundary = { store: new MemoryStore(), payer: fixture.alice.address.toLowerCase(), attempts: new Map() }
export function resetPaid() { paidBoundary.store = new MemoryStore(); paidBoundary.attempts.clear(); paidBoundary.payer = fixture.alice.address.toLowerCase() }
Module._load = function(id, parent, main) {
  if (id === '@/lib/payments/server') return { settlementStore: () => paidBoundary.store }
  if (id === '@/lib/gateway') return {
    paymentInfrastructureStatus: async () => ({ ready: true }),
    build402Response: () => Response.json({}, { status: 402 }),
    paymentResponseHeader: () => Buffer.from(JSON.stringify({ success: true, network: 'eip155:5042', transaction: 'synthetic-no-money' })).toString('base64'),
    verifyAndSettlePayment: async (request, price, seller, apiId) => {
      const key = apiId + request.headers.get('payment-signature')
      const old = paidBoundary.attempts.get(key)
      if (old) return old
      fixture.state.settled++
      const attemptId = randomUUID(), callId = randomUUID(), payer = paidBoundary.payer
      paidBoundary.store.rows.set(attemptId, { id: attemptId, fingerprint: 'a'.repeat(64),
        binding: { payer, api_id: apiId, network: 'eip155:5042' }, state: 'ACCOUNTING_COMPLETE',
        purchase_id: callId, delivery_state: 'NOT_STARTED' })
      fixture.state.tables.purchases.push({ id: callId, buyer_wallet: payer, api_id: apiId, amount_usdc: price })
      const result = { success: true, payer, attemptId, callId }
      paidBoundary.attempts.set(key, result)
      return result
    },
  }
  return load.call(this, id, parent, main)
}
