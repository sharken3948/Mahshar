import { execFileSync } from 'node:child_process'
import { createServiceClient as sessions } from '../marketplace/fixtures'
import { currentBulkAttempt } from '../../src/lib/free-api-worker/bulk-attempt'

export const boundary = { sleep: null as null | ((date: Date) => Promise<void>), starts: 0, failStart: false, runStep: null as null | ((generation: string) => Promise<import('../../src/lib/free-api-worker/runtime').StepResult>), run: Promise.resolve() as Promise<unknown> }
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
  private columns = '*'; private filters: string[] = []; private singleRow = false
  private offset = 0; private count = 1000; private updateValue: Record<string, unknown> | null = null
  constructor(private table: string) { if (!['free_worker_state', 'free_worker_apis'].includes(table)) throw new Error('Shared table denied') }
  select(columns = '*') { this.columns = columns; return this }
  eq(key: string, value: unknown) { if (!/^\w+$/.test(key)) throw new Error('Unsafe field'); this.filters.push(`${key}=${quote(value)}`); return this }
  order() { return this }
  range(from: number, to: number) { this.offset = from; this.count = to - from + 1; return this }
  single() { this.singleRow = true; return this }
  update(value: Record<string, unknown>) { this.updateValue = value; return this }
  then(resolve: (value: any) => unknown) {
    let data: unknown = null, error: unknown = null
    try {
      const where = this.filters.length ? ' WHERE ' + this.filters.join(' AND ') : ''
      if (this.updateValue) {
        const set = Object.entries(this.updateValue).map(([key, value]) => `${key}=${quote(value)}`).join(',')
        sql(`UPDATE public.${this.table} SET ${set}${where}`)
      } else {
        const query = `SELECT coalesce(json_agg(t),'[]') FROM (SELECT ${this.columns.replace('historical:saved_inventory->original->lead->>id', "saved_inventory->'original'->'lead'->>'id' AS historical")} FROM public.${this.table}${where} ORDER BY id LIMIT ${this.count} OFFSET ${this.offset}) t`
        const rows = JSON.parse(sql(query)); data = this.singleRow ? rows[0] : rows
      }
    } catch { error = { code: 'XX000' } }
    return Promise.resolve({ data, error }).then(resolve)
  }
}
export function createServiceClient() {
  const sessionDB = sessions()
  return {
    from: (table: string) => table.startsWith('free_worker_') ? new Query(table) : sessionDB.from(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (!/^free_worker_(?:admit|control|claim|save|finish|release|import|remove|checkpoint|discovery_save|failed_(?:move|begin|finish)|bulk_(?:read|create|claim|checkpoint|finish|retry))$/.test(name)) throw new Error('Non-Worker RPC denied')
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
