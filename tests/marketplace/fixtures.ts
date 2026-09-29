import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { OPERATION_AUTH_DOMAIN, OPERATION_AUTH_HEADER, OPERATION_AUTH_SECONDS, OPERATION_AUTH_TYPES,
  authorizationMessage, encodeAuthorizationProof, requestPayload } from '../../src/lib/marketplace/operation-authorization'
import type { Hex } from 'viem'
export const alice = privateKeyToAccount(`0x${'11'.repeat(32)}`)
export const bob = privateKeyToAccount(`0x${'22'.repeat(32)}`)
export const origin = 'https://mahshar.xyz'
export const state = { tables: {} as Record<string, Record<string, any>[]>, upstream: 0, settled: 0,
  rateLimitError: false, rateLimitAllowed: true, failApiCallInsert: false, pruneCalls: 0, pruneResult: 0,
  authPruneCalls: 0, authPruneResult: { challenges: 0, sessions: 0 } }
export function reset() {
  state.upstream = 0; state.settled = 0
  state.rateLimitError = false; state.rateLimitAllowed = true
  state.failApiCallInsert = false
  state.pruneCalls = 0; state.pruneResult = 0
  state.authPruneCalls = 0; state.authPruneResult = { challenges: 0, sessions: 0 }
  state.tables = { api_listings: [], api_calls: [], purchases: [], credit_balances: [], seller_withdrawals: [],
    withdraw_used_nonces: [], wallet_auth_challenges: [], wallet_sessions: [] }
}
export function sessionHeaders(account = alice, options: { expired?: boolean; revoked?: boolean; token?: string } = {}) {
  const token = options.token ?? randomBytes(32).toString('base64url')
  state.tables.wallet_sessions.push({ id: randomUUID(), token_hash: createHash('sha256').update(token).digest('hex'),
    wallet: account.address.toLowerCase(), created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (options.expired ? -60_000 : 8 * 60 * 60 * 1000)).toISOString(),
    revoked_at: options.revoked ? new Date().toISOString() : null })
  return { origin, cookie: `mahshar_session=${token}` }
}
let nonceCounter = 0
export async function operationHeaders(path: string, method = 'GET', body?: unknown, account = alice, options: { issuedAt?: number; nonce?: Hex } = {}) {
  const url = new URL(path, origin)
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000)
  const deadline = issuedAt + OPERATION_AUTH_SECONDS
  const nonce = options.nonce ?? (`0x${(++nonceCounter).toString(16).padStart(64, '0')}` as Hex)
  const message = authorizationMessage({ wallet: account.address.toLowerCase() as `0x${string}`, method, url,
    payload: requestPayload(url, method, body === undefined ? null : JSON.stringify(body)), nonce, issuedAt, deadline })
  const signature = await account.signTypedData({ domain: OPERATION_AUTH_DOMAIN, types: OPERATION_AUTH_TYPES,
    primaryType: 'MahsharAuthorization', message })
  return { origin, [OPERATION_AUTH_HEADER]: encodeAuthorizationProof({
    wallet: account.address.toLowerCase() as `0x${string}`, nonce, issuedAt, deadline, signature,
  }) }
}
class Query {
  predicates: ((r: Record<string, any>) => boolean)[] = []
  columns = '*'; take = Infinity; skip = 0; singleRow = false; mutation?: { kind: string; value?: Record<string, any> }
  constructor(readonly table: string) {}
  select(columns = '*') { this.columns = columns; return this }
  eq(key: string, value: unknown) { this.predicates.push(r => {
    if (r[key] && value && typeof r[key] === 'object') {
      return JSON.stringify(r[key]) === (typeof value === 'string' ? value : JSON.stringify(value))
    }
    return r[key] === value
  }); return this }
  ilike(key: string, value: string) { this.predicates.push(r => String(r[key]).toLowerCase() === value.toLowerCase()); return this }
  filter(key: string, op: string, value: unknown) { return op === 'is' ? this.is(key, value) : this.eq(key, value) }
  is(key: string, value: unknown) { this.predicates.push(r => (r[key] ?? null) === value); return this }
  not(key: string, _op: string, value: unknown) { this.predicates.push(r => (r[key] ?? null) !== value); return this }
  in(key: string, values: unknown[]) { this.predicates.push(r => values.includes(r[key])); return this }
  gte(key: string, value: unknown) { this.predicates.push(r => r[key] >= (value as any)); return this }
  gt(key: string, value: unknown) { this.predicates.push(r => r[key] > (value as any)); return this }
  order(_key: string, _options?: unknown) { return this }
  limit(n: number) { this.take = n; return this }
  range(from: number, to: number) { this.skip = from; this.take = to - from + 1; return this }
  single<T = unknown>() { this.singleRow = true; return this as Query & PromiseLike<{ data: T; error: null }> }
  maybeSingle() { this.singleRow = true; return this }
  update(value: Record<string, any>) { this.mutation = { kind: 'update', value }; return this }
  delete() { this.mutation = { kind: 'delete' }; return this }
  insert(value: Record<string, any>) { this.mutation = { kind: 'insert', value }; return this }
  then(resolve: (value: any) => unknown) {
    let table = state.tables[this.table] ?? []
    if (this.mutation?.kind === 'insert') {
      if (this.table === 'api_calls' && state.failApiCallInsert) {
        return Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected api_calls failure' } }).then(resolve)
      }
      if (this.table === 'withdraw_used_nonces' && table.some(row => row.nonce === this.mutation!.value!.nonce)) {
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate nonce' } }).then(resolve)
      }
      const row = { id: randomUUID(), created_at: new Date().toISOString(), verified_at: null, method: 'GET',
        auth_param_name: null, encrypted_key: null, ...this.mutation.value }
      table.push(row as any); table = [row as any]
    }
    let rows = table.filter(r => this.predicates.every(p => p(r))).slice(this.skip, this.skip + this.take) as Record<string, any>[]
    if (this.mutation?.kind === 'update') rows.forEach(r => Object.assign(r, this.mutation!.value))
    if (this.mutation?.kind === 'delete') state.tables[this.table] = table.filter(r => !rows.includes(r))
    rows = rows.map(r => this.columns === '*' || this.columns.includes('(') ? structuredClone(r)
      : Object.fromEntries(this.columns.split(',').map(k => [k.trim(), structuredClone(r[k.trim()])])))
    return Promise.resolve({ data: this.singleRow ? rows[0] ?? null : rows, error: null }).then(resolve)
  }
}
export function createServiceClient() {
  return { from: (name: string) => new Query(name), rpc: async (name: string, args: Record<string, any>) => {
    if (name === 'mahshar_take_rate_limit') {
      if (state.rateLimitError) return { data: null, error: { message: 'limiter unavailable' } }
      return { data: [{ allowed: state.rateLimitAllowed, remaining: state.rateLimitAllowed ? Number(args.p_limit) - 1 : 0,
        retry_after_seconds: state.rateLimitAllowed ? 0 : 12 }], error: null }
    }
    if (name === 'mahshar_take_rate_limits') {
      if (state.rateLimitError) return { data: null, error: { message: 'limiter unavailable' } }
      const buckets = args.p_buckets as Array<{ limit: number }>
      return { data: [{ allowed: state.rateLimitAllowed,
        remaining: state.rateLimitAllowed ? Math.min(...buckets.map(bucket => Number(bucket.limit) - 1)) : 0,
        retry_after_seconds: state.rateLimitAllowed ? 0 : 12 }], error: null }
    }
    if (name === 'mahshar_agent_listing_stats') {
      const ids = new Set(args.p_api_ids as string[])
      const grouped = new Map<string, { api_id: string; total_calls: number; successful_calls: number; total_latency: number }>()
      for (const row of state.tables.api_calls ?? []) {
        if (!ids.has(row.api_id)) continue
        const value = grouped.get(row.api_id) ?? { api_id: row.api_id, total_calls: 0, successful_calls: 0, total_latency: 0 }
        value.total_calls++
        if (row.success) value.successful_calls++
        value.total_latency += Number(row.latency_ms)
        grouped.set(row.api_id, value)
      }
      return { data: [...grouped.values()].map(value => ({ ...value, avg_latency_ms: value.total_latency / value.total_calls })), error: null }
    }
    if (name === 'mahshar_prune_api_call_responses') {
      state.pruneCalls++
      if (Number(args.p_limit) !== 1000) return { data: null, error: { message: 'invalid prune bound' } }
      return { data: state.pruneResult, error: null }
    }
    if (name === 'mahshar_prune_wallet_auth') {
      state.authPruneCalls++
      if (Number(args.p_limit) !== 1000) return { data: null, error: { message: 'invalid prune bound' } }
      return { data: state.authPruneResult, error: null }
    }
    if (name === 'mahshar_reserve_seller_withdrawal') {
      const wallet = String(args.p_seller_wallet).toLowerCase()
      const listingIds = new Set((state.tables.api_listings ?? []).filter(row => String(row.seller_wallet).toLowerCase() === wallet).map(row => row.id))
      const earned = (state.tables.purchases ?? []).filter(row => listingIds.has(row.api_id))
        .reduce((sum, row) => sum + Number(row.seller_share_usdc ?? 0), 0)
      const consumed = (state.tables.seller_withdrawals ?? []).filter(row => String(row.seller_wallet).toLowerCase() === wallet &&
        ['pending_mint', 'submission_unknown', 'mint_unknown', 'minted', 'failed'].includes(row.status))
        .reduce((sum, row) => sum + Number(row.amount_usdc), 0)
      if (Number(args.p_amount_usdc) > earned - consumed) return { data: null, error: { message: 'insufficient withdrawal balance' } }
      const row = { id: randomUUID(), seller_wallet: wallet, network_id: args.p_network_id, amount_usdc: args.p_amount_usdc,
        net_amount_usdc: args.p_amount_usdc, gas_cost_usdc: 0, burn_intent: {}, status: 'pending_mint', created_at: new Date().toISOString() }
      state.tables.seller_withdrawals.push(row)
      return { data: row, error: null }
    }
    throw new Error(`Unexpected test RPC: ${name}`)
  } }
}
