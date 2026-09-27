import { NextResponse } from 'next/server.js'
import { MemoryStore, payer, seller, apiId } from './fixture'
export const state = { store: new MemoryStore(), storageReady: true, settled: 0, proxied: 0, upstreamStatus: 200, deliveryOutcome: undefined as undefined | 'succeeded' | 'failed_final' | 'failed_retryable' | 'unknown', verified: 0, listingMethod: 'POST', configs: [] as Record<string, unknown>[] }
export const settlementStore = () => state.store
export async function settlementStorageReady() { if (!state.storageReady) throw new Error('storage unavailable') }
export class AppKit { constructor() { throw new Error('Unrelated payout API forbidden in settlement tests') } }
export class GatewayClient { constructor() { throw new Error('Unrelated Gateway payout forbidden in settlement tests') } }
export function createViemAdapterFromPrivateKey() { throw new Error('Payout adapter forbidden in settlement tests') }
export class BatchFacilitatorClient {
  constructor(config: Record<string, unknown>) { state.configs.push(config) }
  async verify(_p: unknown, r: { network: string }) { state.verified++; return { isValid: r.network === 'eip155:5042', payer } }
  async settle(_p: unknown, r: { network: string }) { state.settled++; return { success: true, payer, network: r.network, transaction: 'sdk-canonical-id' } }
}
export function createServiceClient() {
  return { async rpc(name: string) {
    if (name === 'mahshar_take_rate_limit') return { data: [{ allowed: true, remaining: 99, retry_after_seconds: 0 }], error: null }
    throw new Error(`unexpected rpc ${name}`)
  }, from(table: string) {
    const filters: Record<string, string> = {}
    const q = {
      select() { return q }, eq(k: string, v: string) { filters[k] = v; return q },
      async single() { return { data: { id: apiId, name: 'fixture', price_per_call: 0.001, seller_wallet: seller, is_active: true, encrypted_key: null, method: state.listingMethod }, error: null } },
      async maybeSingle() {
        if (table !== 'x402_settlement_attempts') throw new Error('unexpected table')
        const a = state.store.rows.get(filters.id)
        return { data: a && a.binding.payer === filters['binding->>payer'] ? structuredClone(a) : null, error: null }
      },
    }; return q
  } }
}
export async function proxyRequest() {
  state.proxied++
  return {
    status: state.upstreamStatus,
    body: { fixture: true },
    latencyMs: 1,
    deliveryOutcome: state.deliveryOutcome ?? (state.upstreamStatus >= 200 && state.upstreamStatus < 300 ? 'succeeded' : 'failed_final'),
    ...(state.upstreamStatus >= 300 ? { errorCode: 'upstream_http_error' } : {}),
  }
}
export async function writeMemo() {}
export function withWallet(handler: (r: Request, wallet: string) => Promise<Response>) {
  return (r: Request) => {
    const wallet = r.headers.get('x-test-principal')
    return wallet ? handler(r, wallet) : Promise.resolve(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
  }
}
export const withOperationAuthorization = withWallet
