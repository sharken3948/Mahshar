import { sql, createServiceClient as workerDB } from './postgres-adapter'
import { createServiceClient as sessionDB } from '../marketplace/fixtures'
export { sql } from './postgres-adapter'
export const outbound = { fail: new Set<string>(), calls: new Map<string, number>(), paidCalls: 0, responses: new Map<string, { status: number; body: string; type?: string }>(),
  beforeListingWrite: null as null | ((value: Record<string, unknown>) => Promise<void>),
  afterListingWrite: null as null | ((value: Record<string, unknown>) => Promise<void>),
  waitForEndpoint: null as null | ((url: string, init: unknown) => Promise<Response | null>),
}
export async function safeOutboundFetch(input: string | URL, init?: unknown) {
  const url = String(input)
  if (!new URL(url).hostname.endsWith('.example.org')) throw new Error('Only synthetic fixture endpoints allowed')
  outbound.calls.set(url, (outbound.calls.get(url) ?? 0) + 1)
  const delayed = await outbound.waitForEndpoint?.(url, init)
  if (delayed) return delayed
  const response = outbound.responses.get(url)
  if (response) return new Response(response.body, { status: response.status, headers: { 'content-type': response.type ?? 'text/html' } })
  return Response.json({ books: [{ title: 'Isolated fixture' }] }, { status: outbound.fail.has(url) ? 503 : 200 })
}
const quote = (value: unknown) => value == null ? 'NULL' : typeof value === 'boolean' || typeof value === 'number' ? String(value)
  : "'" + (typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''") + "'"
const field = (key: string) => { if (!/^\w+$/.test(key)) throw new Error('Unsafe field'); return key }
class ListingQuery {
  private columns = '*'; private predicates: string[] = []; private one = false
  private patch?: Record<string, unknown>; private added?: Record<string, unknown>
  select(columns = '*') { this.columns = columns; return this }
  eq(key: string, value: unknown) { this.predicates.push(`${field(key)}=${quote(value)}`); return this }
  ilike(key: string, value: string) { this.predicates.push(`${field(key)} ILIKE ${quote(value)}`); return this }
  filter(key: string, operator: string, value: unknown) {
    if (operator === 'is') { this.predicates.push(`${field(key)} IS NULL`); return this }
    return this.eq(key, value)
  }
  single() { this.one = true; return this }
  maybeSingle() { return this.single() }
  order() { return this }
  range() { return this }
  limit() { return this }
  insert(value: Record<string, unknown>) { this.added = value; return this }
  update(value: Record<string, unknown>) { this.patch = value; return this }
  async then(resolve: (value: any) => unknown) {
    try {
      if (this.added || this.patch) await outbound.beforeListingWrite?.(this.added ?? this.patch!)
      const where = this.predicates.length ? ' WHERE ' + this.predicates.join(' AND ') : ''
      let query = `SELECT ${this.columns} FROM public.api_listings${where}`
      if (this.added) {
        const entries = Object.entries(this.added).filter(([, value]) => value !== undefined)
        query = `INSERT INTO public.api_listings (${entries.map(([key]) => field(key)).join(',')}) VALUES (${entries.map(([, value]) => quote(value)).join(',')}) RETURNING ${this.columns}`
      } else if (this.patch) query = `UPDATE public.api_listings SET ${Object.entries(this.patch).map(([key,value]) => `${field(key)}=${quote(value)}`).join(',')}${where} RETURNING ${this.columns}`
      const rows = JSON.parse(sql(`WITH result AS (${query}) SELECT coalesce(json_agg(result),'[]') FROM result`))
      if (this.added || this.patch) await outbound.afterListingWrite?.(this.added ?? this.patch!)
      return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null }).then(resolve)
    } catch (error) {
      return Promise.resolve({ data: null, error: { code: 'XX000', message: String((error as { stderr?: unknown }).stderr ?? error) } }).then(resolve)
    }
  }
}
export function createServiceClient() {
  const worker = workerDB(), sessions = sessionDB()
  return { from: (table: string) => table === 'api_listings' ? new ListingQuery() : worker.from(table),
    rpc: (name: string, args: Record<string, unknown>) => name.startsWith('free_worker_') ? worker.rpc(name,args) : sessions.rpc(name,args) }
}
