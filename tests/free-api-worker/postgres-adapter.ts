import { execFileSync } from 'node:child_process'
import { createServiceClient as sessions } from '../marketplace/fixtures'
import { currentBulkAttempt } from '../../src/lib/free-api-worker/bulk-attempt'

export const boundary = { sleep: null as null | ((date: Date) => Promise<void>), starts: 0, failStart: false,
  queries: [] as Array<{ table: string; columns: string; offset: number; rows: number; head: boolean; responseBytes: number }>,
  runStep: null as null | ((generation: string) => Promise<import('../../src/lib/free-api-worker/runtime').StepResult>), run: Promise.resolve() as Promise<unknown> }
export async function start(workflow?: (generation: string) => Promise<unknown>, args?: [string]) {
  boundary.starts++; if (boundary.failStart) throw new Error('Unavailable')
  if (boundary.runStep && workflow && args) boundary.run = Promise.resolve().then(() => workflow(args[0]))
  return { runId: 'isolated-test' }
}
const quote = (value: unknown) => value === null ? 'NULL' : typeof value === 'boolean' ? String(value)
  : "'" + (typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''") + "'"
export function sql(query: string) {
  const attempt = currentBulkAttempt()
  if (attempt) {
    const headers = { 'x-mahshar-bulk-attempt': JSON.stringify({ batch: attempt.batch, candidate: attempt.candidate, token: attempt.token }) }
    query = `BEGIN; SET LOCAL request.headers=${quote(headers)}; ${query}; COMMIT;`
  }
  const socket = process.env.FREE_WORKER_TEST_SOCKET, binary = process.env.FREE_WORKER_TEST_PSQL
  if (!socket?.startsWith('/tmp/mahshar-worker-replacement-') || !binary?.endsWith('/psql')) throw new Error('Disposable PostgreSQL configuration required')
  return execFileSync(binary, ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55476', '-U', 'worker_test', '-d', 'postgres'],
    { input: query, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
class Query {
  private columns = '*'; private filters: string[] = []; private singleRow = false; private orderBy = 'id'
  private offset = 0; private rowCount = 1000; private updateValue: Record<string, unknown> | null = null
  private countRows = false; private head = false
  constructor(private table: string) { if (!['free_worker_state', 'free_worker_apis'].includes(table)) throw new Error('Shared table denied') }
  private field(key: string) {
    const match = key.match(/^(\w+)(->>|->)(\w+)$/)
    if (match) return `${match[1]}${match[2]}'${match[3]}'`
    if (!/^\w+$/.test(key)) throw new Error('Unsafe field')
    return key
  }
  private selection(column: string) {
    if (column === 'historical:saved_inventory->original->lead->>id') return "saved_inventory->'original'->'lead'->>'id' AS historical"
    const alias = column.match(/^(\w+):(\w+)(->>|->)(\w+)$/)
    if (alias) return `${alias[2]}${alias[3]}'${alias[4]}' AS ${alias[1]}`
    return column
  }
  select(columns = '*', options?: { count?: string; head?: boolean }) {
    this.columns = columns; this.countRows = options?.count === 'exact'; this.head = !!options?.head; return this
  }
  eq(key: string, value: unknown) { this.filters.push(`${this.field(key)}=${quote(value)}`); return this }
  is(key: string, value: unknown) { this.filters.push(`${this.field(key)} IS ${value === null ? 'NULL' : quote(value)}`); return this }
  not(key: string, operator: string, value: unknown) {
    if (operator !== 'is') throw new Error('Unsupported operator')
    this.filters.push(`${this.field(key)} IS NOT ${value === null ? 'NULL' : quote(value)}`); return this
  }
  gt(key: string, value: unknown) { this.filters.push(`${this.field(key)}>${quote(value)}`); return this }
  in(key: string, values: unknown[]) { this.filters.push(`${this.field(key)} IN (${values.map(quote).join(',')})`); return this }
  contains(key: string, value: unknown) { this.filters.push(`${this.field(key)} @> ${quote(value)}::jsonb`); return this }
  or(expression: string) {
    const clauses = expression.split(',').map(clause => {
      let match = clause.match(/^(.+?)\.not\.is\.null$/)
      if (match) return `${this.field(match[1])} IS NOT NULL`
      match = clause.match(/^(.+?)\.eq\.(.+)$/)
      if (match) return `${this.field(match[1])}=${quote(match[2])}`
      match = clause.match(/^(.+?)\.ilike\."(.*)"$/)
      if (match) return `${this.field(match[1])} ILIKE ${quote(match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))}`
      throw new Error('Unsupported OR filter')
    })
    this.filters.push(`(${clauses.join(' OR ')})`); return this
  }
  order(key = 'id') { this.orderBy = this.field(key); return this }
  limit(count: number) { this.rowCount = count; return this }
  range(from: number, to: number) { this.offset = from; this.rowCount = to - from + 1; return this }
  single() { this.singleRow = true; return this }
  update(value: Record<string, unknown>) { this.updateValue = value; return this }
  then(resolve: (value: any) => unknown) {
    let data: unknown = null, error: unknown = null, exactCount: number | null = null
    try {
      const measurement = { table: this.table, columns: this.columns, offset: this.offset, rows: this.rowCount, head: this.head, responseBytes: 0 }
      boundary.queries.push(measurement)
      const where = this.filters.length ? ' WHERE ' + this.filters.join(' AND ') : ''
      if (this.updateValue) {
        const set = Object.entries(this.updateValue).map(([key, value]) => `${key}=${quote(value)}`).join(',')
        sql(`UPDATE public.${this.table} SET ${set}${where}`)
      } else {
        if (this.countRows) exactCount = Number(sql(`SELECT count(*) FROM public.${this.table}${where}`))
        if (!this.head) {
          const columns = this.columns === '*' ? '*' : this.columns.split(',').map(column => this.selection(column)).join(',')
          const query = `SELECT coalesce(json_agg(t),'[]') FROM (SELECT ${columns} FROM public.${this.table}${where} ORDER BY ${this.orderBy} LIMIT ${this.rowCount} OFFSET ${this.offset}) t`
          const rows = JSON.parse(sql(query)); data = this.singleRow ? rows[0] : rows
          measurement.responseBytes = Buffer.byteLength(JSON.stringify(data))
        }
      }
    } catch { error = { code: 'XX000' } }
    return Promise.resolve({ data, error, count: exactCount }).then(resolve)
  }
}
export function createServiceClient() {
  const sessionDB = sessions()
  return {
    from: (table: string) => table.startsWith('free_worker_') ? new Query(table) : sessionDB.from(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (!/^free_worker_(?:admit|control|claim|save|finish|release|import|remove|checkpoint|discovery_save|failed_(?:move|begin|finish)|bulk_(?:read|create|claim|checkpoint|finish|retry|pause|resume))$/.test(name)) throw new Error('Non-Worker RPC denied')
      try {
        const values = Object.entries(args).map(([key, value]) => `${key}=>${key === 'p_ids' ? 'ARRAY[' + (value as string[]).map(quote).join(',') + ']::text[]' : quote(value)}`).join(',')
        const call = `public.${name}(${values})`
        const query = name === 'free_worker_claim' ? `SELECT coalesce(json_agg(t),'[]') FROM ${call} t` : `SELECT to_json(${call})`
        const result = sql(query)
        return { data: result ? JSON.parse(result) : null, error: null }
      } catch (error) { if (name.startsWith('free_worker_bulk_')) console.error('Isolated bulk RPC failed:', String((error as { stderr?: unknown }).stderr ?? error)); return { data: null, error: { code: 'XX000', message: name.startsWith('free_worker_failed_') || name.startsWith('free_worker_bulk_') ? String((error as { stderr?: unknown }).stderr ?? error) : String((error as { stderr?: unknown }).stderr ?? error).includes('already_running') ? 'already_running' : String((error as { stderr?: unknown }).stderr ?? error).includes('work_in_flight') ? 'work_in_flight' : 'worker_storage_unavailable' } } }
    },
  }
}
