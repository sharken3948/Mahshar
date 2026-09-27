import { createHash, randomUUID } from 'node:crypto'

export type Requirements = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra?: Record<string, unknown> }
export type Authorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }
export type Payment = { x402Version: number; payload: { authorization: Authorization; signature: string }; [key: string]: unknown }
export type Binding = {
  fingerprint: string; authorization_key: string; proof_hash: string; api_id: string; payer: string;
  seller: string; network: string; asset: string; pay_to: string; nonce: string;
  amount_atomic: string; seller_atomic: string; platform_atomic: string;
  authorization: Authorization; requirements: Requirements;
}
export type State = 'PREPARED' | 'SETTLEMENT_SUBMITTED' | 'SETTLEMENT_CONFIRMED' | 'ACCOUNTING_COMPLETE' | 'SETTLEMENT_UNKNOWN' | 'MANUAL_REVIEW'
export type DeliveryState = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'UNKNOWN'
export type Attempt = { id: string; fingerprint: string; binding: Binding; state: State; submission_token?: string; purchase_id?: string; settlement_identity?: string; transaction_id?: string; reason?: string; delivery_state?: DeliveryState; delivery_request_hash?: string; delivery_token?: string; delivery_started_at?: string; delivery_completed_at?: string; delivery_http_status?: number; delivery_error_code?: string }
export interface Store {
  find(key: string): Promise<Attempt | null>
  prepare(binding: Binding): Promise<Attempt>
  claim(id: string, token: string): Promise<Attempt | null>
  confirm(id: string, token: string, transaction: string | null): Promise<Attempt>
  unknown(id: string, token: string, reason: string): Promise<void>
  recover(id: string): Promise<Attempt>
  claimDelivery(id: string, token: string, requestHash: string): Promise<Attempt>
  completeDelivery(id: string, token: string, state: Exclude<DeliveryState, 'NOT_STARTED' | 'IN_PROGRESS'>, httpStatus: number, errorCode: string | null): Promise<Attempt>
}
export type SettlementResult = { success: boolean; payer?: string; error?: string; callId?: string; attemptId?: string; replayed?: boolean; status?: number; network?: string; transaction?: string; amount?: string }
export type Facilitator = {
  verify(payment: Payment, requirements: Requirements): Promise<{ isValid: boolean; payer?: string; invalidReason?: string }>
  settle(payment: Payment, requirements: Requirements): Promise<{ success: boolean; payer?: string; network?: string; transaction?: string; errorReason?: string }>
}
export class PaymentStorageUnavailableError extends Error {
  constructor() {
    super('Payment persistence unavailable')
    this.name = 'PaymentStorageUnavailableError'
  }
}
const address = (v: unknown): string => {
  if (typeof v !== 'string' || !/^0x[\da-f]{40}$/i.test(v)) throw new Error('invalid_payment_address')
  return v.toLowerCase()
}
const integer = (v: unknown): string => {
  if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) throw new Error('invalid_payment_integer')
  return BigInt(v).toString()
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function parsePayment(encoded: string): Payment {
  if (encoded.length > 32768) throw new Error('invalid_payment')
  const p = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Payment
  if (p?.x402Version !== 2 || !p.payload?.authorization || typeof p.payload.signature !== 'string' || !/^0x[\da-f]+$/i.test(p.payload.signature)) throw new Error('invalid_payment')
  // Validate but retain the original SDK payload for cryptographic verification.
  canonicalAuthorization(p)
  return p
}
function canonicalAuthorization(p: Payment): Authorization {
  const a = p.payload.authorization
  if (typeof a.nonce !== 'string' || !/^0x[\da-f]{64}$/i.test(a.nonce)) throw new Error('invalid_payment_nonce')
  return { from: address(a.from), to: address(a.to), value: integer(a.value), validAfter: integer(a.validAfter), validBefore: integer(a.validBefore), nonce: a.nonce.toLowerCase() }
}
export function paymentIdentity(p: Payment, r: Requirements) {
  const a = canonicalAuthorization(p)
  const domain = [r.network, address(r.asset), address(r.extra?.verifyingContract), r.extra?.name, r.extra?.version]
  return { authorization: a,
    authorization_key: hash(['mahshar-x402-authorization-v1', domain, a.from, a.nonce]),
    fingerprint: hash(['mahshar-x402-payment-v1', domain, a]),
    proof_hash: hash(['mahshar-x402-proof-v1', a, p.payload.signature.toLowerCase()]),
  }
}

export async function recoverSettlement(store: Store, attempt: Attempt): Promise<SettlementResult> {
  try {
    const recovered = await store.recover(attempt.id)
    if (recovered.state === 'ACCOUNTING_COMPLETE' && recovered.purchase_id) return { success: true, payer: recovered.binding.payer, callId: recovered.purchase_id, attemptId: recovered.id, replayed: true, network: recovered.binding.network, transaction: recovered.transaction_id ?? '', amount: recovered.binding.amount_atomic }
    return { success: false, error: recovered.state === 'MANUAL_REVIEW' ? 'settlement_manual_review' : 'settlement_pending', attemptId: attempt.id, status: 409 }
  } catch {
    return { success: false, error: 'payment_accounting_unavailable', attemptId: attempt.id, status: 503 }
  }
}

/** A DB claim is the only permission to invoke the irreversible SDK method. */
export async function settleDurably(input: {
  payment: Payment; apiId: string; seller: string; sellerAtomic: string;
  candidates: Requirements[]; facilitator: (network: string) => Facilitator; store: Store;
}): Promise<SettlementResult> {
  const { payment, store } = input
  let attempt: Attempt | null = null
  try {
    // Before /verify: used authorizations may no longer verify, but confirmed
    // local evidence can still be accounted. Listing and proof must match.
    for (const r of input.candidates) {
      const identity = paymentIdentity(payment, r)
      const existing = await store.find(identity.authorization_key)
      if (!existing) continue
      attempt = existing
      if (existing.fingerprint !== identity.fingerprint || existing.binding.proof_hash !== identity.proof_hash || existing.binding.api_id !== input.apiId || existing.binding.seller !== address(input.seller)) {
        return { success: false, error: 'payment_binding_conflict', status: 409 }
      }
      if (existing.state !== 'PREPARED') return recoverSettlement(store, existing)
      break
    }
    const candidates = attempt ? [attempt.binding.requirements] : input.candidates
    let verified: Requirements | undefined
    for (const r of candidates) {
      const identity = paymentIdentity(payment, r)
      if (identity.authorization.to !== address(r.payTo) || identity.authorization.value !== r.amount) continue
      let v: Awaited<ReturnType<Facilitator['verify']>>
      try { v = await input.facilitator(r.network).verify(payment, r) }
      catch { return { success: false, error: 'payment_verification_service_unavailable', status: 503 } }
      if (v.isValid === true && v.payer && address(v.payer) === identity.authorization.from) { verified = r; break }
    }
    if (!verified) return { success: false, error: 'verification_failed', status: 402 }
    if (!attempt) {
      const identity = paymentIdentity(payment, verified)
      const sellerAtomic = BigInt(integer(input.sellerAtomic))
      const amount = BigInt(verified.amount)
      if (sellerAtomic <= BigInt(0) || sellerAtomic > amount || amount > BigInt('9999999999')) return { success: false, error: 'invalid_amount', status: 400 }
      attempt = await store.prepare({ ...identity, api_id: input.apiId, payer: identity.authorization.from,
        seller: address(input.seller), network: verified.network, asset: address(verified.asset), pay_to: address(verified.payTo),
        nonce: identity.authorization.nonce, amount_atomic: amount.toString(), seller_atomic: sellerAtomic.toString(),
        platform_atomic: (amount - sellerAtomic).toString(), requirements: verified })
    }
    const token = randomUUID()
    const claimed = await store.claim(attempt.id, token)
    if (!claimed) return recoverSettlement(store, attempt)
    let result: Awaited<ReturnType<Facilitator['settle']>>
    try { result = await input.facilitator(verified.network).settle(payment, verified) }
    catch {
      await store.unknown(attempt.id, token, 'settlement_transport_uncertain').catch(() => undefined)
      return { success: false, error: 'settlement_unknown', attemptId: attempt.id, status: 409 }
    }
    if (result.success !== true || (result.payer && result.payer.toLowerCase() !== attempt.binding.payer) || (result.network && result.network !== verified.network)) {
      await store.unknown(attempt.id, token, result.success === false ? 'facilitator_rejected_or_authorization_used' : 'settlement_result_conflict').catch(() => undefined)
      return { success: false, error: 'settlement_requires_review', attemptId: attempt.id, status: 409 }
    }
    // No signature or payment payload is stored; the immutable binding survives
    // even if this acknowledgement or confirmation write is lost.
    try {
      const transaction = typeof result.transaction === 'string' && result.transaction.trim() ? result.transaction.trim() : null
      attempt = await store.confirm(attempt.id, token, transaction)
    } catch {
      return { success: false, error: 'settlement_confirmation_pending', attemptId: attempt.id, status: 503 }
    }
    const recovered = await recoverSettlement(store, attempt)
    return recovered.success ? { ...recovered, replayed: false } : recovered
  } catch (error) {
    return {
      success: false,
      error: error instanceof PaymentStorageUnavailableError ? 'payment_storage_unavailable' : 'payment_processing_unavailable',
      attemptId: attempt?.id,
      status: 503,
    }
  }
}
