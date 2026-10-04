import { randomUUID } from 'node:crypto'
import type { Attempt, Binding, Store, Requirements, Payment } from '../../src/lib/payments/settlement'
import { DeliveryRequestMismatchError } from '../../src/lib/payments/delivery'
export const payer = '0x' + '11'.repeat(20)
export const seller = '0x' + '22'.repeat(20)
export const apiId = '00000000-0000-4000-8000-000000000001'
export const requirements: Requirements = { scheme: 'exact', network: 'eip155:5042', asset: '0x'+'33'.repeat(20), amount: '1100', payTo: '0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6', maxTimeoutSeconds: 345600, extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x'+'55'.repeat(20) } }
export const payment: Payment = { x402Version: 2, payload: { signature: '0x'+'ab'.repeat(65), authorization: { from: payer, to: requirements.payTo, value: '1100', validAfter: '1', validBefore: '9999999999', nonce: '0x'+'66'.repeat(32) } } }
export class MemoryStore implements Store {
  rows = new Map<string, Attempt>()
  purchases = new Map<string, { id: string; binding: Binding; tx: string }>()
  failPrepare = false; failAccounting = false; failConfirm = false; loseClaimAck = false
  async find(key: string) { return structuredClone([...this.rows.values()].find(a => a.binding.authorization_key === key) ?? null) }
  async prepare(binding: Binding) {
    if (this.failPrepare) throw new Error('DB unavailable')
    const old = [...this.rows.values()].find(a => a.binding.authorization_key === binding.authorization_key)
    if (old) { if (JSON.stringify(old.binding) !== JSON.stringify(binding)) throw new Error('conflict'); return old }
    const a: Attempt = { id: randomUUID(), fingerprint: binding.fingerprint, binding: structuredClone(binding), state: 'PREPARED', delivery_state: 'NOT_STARTED' }
    this.rows.set(a.id, a); return structuredClone(a)
  }
  async claim(id: string, token: string) {
    const a = this.rows.get(id)!
    if (a.state !== 'PREPARED') return null
    a.state = 'SETTLEMENT_SUBMITTED'; a.submission_token = token
    if (this.loseClaimAck) throw new Error('claim acknowledgement lost')
    return structuredClone(a)
  }
  async confirm(id: string, token: string, tx: string | null) {
    if (this.failConfirm) throw new Error('DB unavailable')
    const a = this.rows.get(id)!
    if (a.submission_token !== token) throw new Error('conflict')
    a.state = 'SETTLEMENT_CONFIRMED'; a.transaction_id = tx ?? undefined
    a.settlement_identity = tx ? `circle:${a.binding.network}:${tx}:${a.fingerprint}` : `x402:${a.fingerprint}`
    return structuredClone(a)
  }
  async unknown(id: string, token: string, reason: string) {
    const a = this.rows.get(id)!
    if (a.submission_token === token && a.state === 'SETTLEMENT_SUBMITTED') { a.state = 'SETTLEMENT_UNKNOWN'; a.reason = reason }
  }
  async recover(id: string) {
    const a = this.rows.get(id)!
    if (a.state === 'SETTLEMENT_UNKNOWN') a.state = 'MANUAL_REVIEW'
    if (a.state === 'SETTLEMENT_CONFIRMED') {
      if (this.failAccounting) throw new Error('purchase insert failed')
      if (!this.purchases.has(id)) this.purchases.set(id, { id: randomUUID(), binding: structuredClone(a.binding), tx: a.settlement_identity! })
      a.purchase_id = this.purchases.get(id)!.id; a.state = 'ACCOUNTING_COMPLETE'
    }
    return structuredClone(a)
  }
  async claimDelivery(id: string, token: string, requestHash: string) {
    const a = this.rows.get(id)!
    if (a.state !== 'ACCOUNTING_COMPLETE') throw new Error('accounting incomplete')
    if (a.delivery_request_hash && a.delivery_request_hash !== requestHash) throw new DeliveryRequestMismatchError()
    if (a.delivery_state === 'NOT_STARTED' || a.delivery_state === 'FAILED_RETRYABLE') {
      a.delivery_state = 'IN_PROGRESS'; a.delivery_token = token; a.delivery_request_hash = requestHash
    }
    return structuredClone(a)
  }
  async completeDelivery(id: string, token: string, state: 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'UNKNOWN', httpStatus: number, errorCode: string | null) {
    const a = this.rows.get(id)!
    if (a.delivery_state !== 'IN_PROGRESS' || a.delivery_token !== token) throw new Error('delivery conflict')
    a.delivery_state = state; a.delivery_http_status = httpStatus; a.delivery_error_code = errorCode ?? undefined
    return structuredClone(a)
  }
}
