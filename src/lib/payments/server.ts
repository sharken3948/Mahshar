import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { PaymentStorageUnavailableError, recoverSettlement, type Attempt, type Store } from './settlement'
import { DeliveryRequestMismatchError } from './delivery'

const storageFailure = () => new PaymentStorageUnavailableError()

export async function settlementStorageReady(db = createServiceClient()): Promise<void> {
  const { error } = await db.from('x402_settlement_attempts').select('id').limit(1)
  if (error) throw storageFailure()
}

export function settlementStore(db = createServiceClient()): Store {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(name, args)
    if (error) {
      if (name === 'x402_delivery_claim' && /delivery request mismatch/i.test(error.message ?? '')) throw new DeliveryRequestMismatchError()
      throw storageFailure()
    }
    return data as Attempt
  }
  return {
    find: async key => {
      const { data, error } = await db.from('x402_settlement_attempts').select('*').eq('authorization_key', key).maybeSingle()
      if (error) throw storageFailure()
      return data as Attempt | null
    },
    prepare: binding => rpc('x402_prepare', { p_binding: binding }),
    claim: async (id, token) => {
      const result = await rpc('x402_claim', { p_id: id, p_token: token })
      return result?.id ? result : null
    },
    confirm: (id, token, transaction) => rpc('x402_confirm', { p_id: id, p_token: token, p_transaction: transaction }),
    unknown: async (id, token, reason) => { await rpc('x402_unknown', { p_id: id, p_token: token, p_reason: reason }) },
    recover: id => rpc('x402_recover', { p_id: id }),
    claimDelivery: (id, token, requestHash) => rpc('x402_delivery_claim', { p_id: id, p_token: token, p_request_hash: requestHash }),
    completeDelivery: (id, token, state, httpStatus, errorCode) => rpc('x402_delivery_complete', {
      p_id: id, p_token: token, p_state: state, p_http_status: httpStatus, p_error_code: errorCode,
    }),
  }
}

/** Trusted server job entry point; never verifies, signs, or settles a payment. */
export async function reconcileIncompleteSettlements(limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recovery limit')
  const db = createServiceClient()
  const { data, error } = await db.from('x402_settlement_attempts').select('*')
    .in('state', ['SETTLEMENT_CONFIRMED', 'SETTLEMENT_UNKNOWN', 'SETTLEMENT_SUBMITTED'])
    .order('updated_at').limit(limit)
  if (error) throw new Error('Payment recovery unavailable')
  const store = settlementStore(db)
  const results = []
  for (const attempt of (data ?? []) as Attempt[]) results.push(await recoverSettlement(store, attempt))
  return results
}
