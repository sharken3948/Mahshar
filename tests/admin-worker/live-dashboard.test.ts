import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { activityTimestamp, compareWorkerActivity, getWorkerActivity, parseActivityCursor } from '../../src/lib/admin-worker/activity-repository'
import { getWorkerDashboard, getWorkerProviderDetail } from '../../src/lib/admin-worker/dashboard-repository'
import type { WorkerActivity, WorkerActivityCursor } from '../../src/lib/admin-worker/dashboard-types'

type Row = Record<string, any>
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const at = '2026-10-15T10:00:00.000001+00:00'
const api = (n: number) => ({ id: uuid(n), canonical_name: `Provider ${n}`, canonical_domain: `p${n}.example`, created_at: at, updated_at: at, worker_leads: [] })

// Exercise actual SDK query serialization. Network, writes, RPCs and realtime are forbidden.
function database(tables: Record<string, Row[]>) {
  const queries: URL[] = []
  const values = (row: Row, path: string): any[] => {
    const [key, ...rest] = path.split('.')
    const value = row[key]
    return rest.length ? (Array.isArray(value) ? value : [value]).flatMap(item => item ? values(item, rest.join('.')) : []) : [value]
  }
  const compare = (a: any, b: any) => String(a).includes('T') ? activityTimestamp(String(a)).localeCompare(activityTimestamp(String(b))) : String(a ?? '').localeCompare(String(b ?? ''))
  const client = createClient('https://fixture.supabase.co', 'fixture-only', {
    realtime: { transport: class { constructor() { throw new Error('Realtime forbidden') } } as unknown as typeof WebSocket },
    global: { fetch: async (input, init) => {
      assert.ok(['GET', 'HEAD'].includes(init?.method ?? 'GET'))
      const url = new URL(String(input)); queries.push(url)
      assert.ok(!url.pathname.includes('/rpc/'))
      let data = [...(tables[url.pathname.split('/').pop()!] ?? [])]
      for (const [key, filter] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue
        if (key === 'or') {
          const match = /^\((\w+)\.lt\.(.*),and\(\1\.eq\.(.*),id\.lt\.([^,)]+)\)\)$/.exec(filter)
          assert.ok(match, `supported cursor filter: ${filter}`)
          data = data.filter(row => compare(row[match[1]], match[2]) < 0 || compare(row[match[1]], match[3]) === 0 && compare(row.id, match[4]) < 0)
        } else {
          data = data.filter(row => values(row, key).some(value => {
            if (filter === 'not.is.null') return value !== null && value !== undefined
            if (filter === 'is.null') return value === null || value === undefined
            if (filter.startsWith('in.')) return filter.slice(4, -1).split(',').includes(String(value))
            if (filter.startsWith('eq.')) return String(value) === filter.slice(3)
            if (filter.startsWith('lte.')) return compare(value, filter.slice(4)) <= 0
            if (filter.startsWith('lt.')) return compare(value, filter.slice(3)) < 0
            if (filter.startsWith('not.imatch.') || filter.startsWith('not.match.')) return false // No sent messages in these fixtures.
            throw new Error(`Unsupported test filter ${filter}`)
          }))
        }
      }
      const order = url.searchParams.get('order')?.split(',') ?? []
      data.sort((a, b) => {
        for (const part of order) {
          const [key, direction] = part.split('.')
          const difference = compare(a[key], b[key]) * (direction === 'desc' ? -1 : 1)
          if (difference) return difference
        }
        return 0
      })
      const total = data.length
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 1000)
      data = data.slice(offset, offset + limit)
      return new Response(init?.method === 'HEAD' ? null : JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Content-Range': `${offset}-${Math.max(offset, offset + data.length - 1)}/${total}` },
      })
    } },
  })
  return { client, queries }
}

test('activity cursor validation prevents filter injection and preserves timestamp precision', () => {
  assert.equal(parseActivityCursor(new URL('https://fixture/')), null)
  for (const query of ['before=x', 'id=x', 'before=2026-10-15&id=found:x', `before=${encodeURIComponent(at)}&id=found:${uuid(1)},or(id.gt.0)`]) {
    assert.equal(parseActivityCursor(new URL(`https://fixture/?${query}`)), undefined)
  }
  assert.deepEqual(parseActivityCursor(new URL(`https://fixture/?${new URLSearchParams({ before: at, id: `found:${uuid(1)}` })}`)), { at, id: `found:${uuid(1)}` })
})

test('history pages include timestamp ties once, keep microsecond order and read bounded queries', async () => {
  const providers = Array.from({ length: 41 }, (_, i) => api(i + 1))
  const { client, queries } = database({ worker_providers: providers,
    worker_runs: [{ id: uuid(99), stopped_at: at }, { id: uuid(98), completed_at: at, completion_reason: 'source_exhausted' }],
    worker_contacts: [{ id: uuid(97), verified_at: at, verification_status: 'verified', worker_providers: api(1) }],
  })
  let cursor: WorkerActivityCursor | null = null
  const events: WorkerActivity[] = []
  do {
    const result = await getWorkerActivity(cursor, 25, client)
    events.push(...result.events); cursor = result.next_cursor
  } while (cursor)
  assert.equal(events.length, 44)
  assert.equal(new Set(events.map(event => event.id)).size, 44)
  assert.deepEqual(events, [...events].sort(compareWorkerActivity))
  assert.ok(events.some(event => event.stage === 'Stopped' && event.provider_id === null))
  assert.ok(queries.every(url => Number(url.searchParams.get('limit')) === 26))
  const earlier = { ...events[0], at: '2026-10-15T10:00:00.000001Z' }
  const later = { ...earlier, at: '2026-10-15T10:00:00.000002Z' }
  assert.ok(compareWorkerActivity(later, earlier) < 0)
})

test('draft activity requires persisted Groq provenance; research and reservation use their own timestamps', async () => {
  const { client } = database({ admin_acquisition_attempts: [
    { id: uuid(1), provider_id: uuid(2), status: 'reserved', updated_at: at, reserved_at: at, draft_generator: 'groq', draft_prepared_at: at, subject: 'Saved', body: 'Saved', worker_providers: api(2) },
    { id: uuid(3), status: 'simulated_sent', updated_at: at, subject: 'Legacy', body: 'Legacy' },
  ], worker_leads: [{ id: uuid(4), qualified_at: at, qualification_status: 'rejected', contact_researched_at: at, contactability_status: 'contact_unavailable', worker_providers: api(2) }],
  worker_sources: [{ id: uuid(5), source_role: 'official_docs', checked_at: at, worker_leads: { worker_providers: api(2) } }] })
  const result = await getWorkerActivity(null, 25, client)
  assert.equal(result.events.filter(event => event.stage === 'Groq Drafting').length, 1)
  assert.ok(result.events.some(event => event.stage === 'Reservation' && event.at === at))
  assert.ok(result.events.some(event => event.stage === 'Qualification' && event.label.includes('rejected')))
  assert.ok(result.events.some(event => event.stage === 'Contact' && event.label.includes('unavailable')))
  assert.ok(result.events.some(event => event.stage === 'Research'))
  assert.ok(!JSON.stringify(result).includes('Legacy'))
})

test('providers appear once, ordered by latest related activity, and every provider is paginated', async () => {
  const providers = Array.from({ length: 31 }, (_, i) => ({ ...api(i + 1), updated_at: '2026-10-01T00:00:00Z' }))
  // More than one read window of activity for one provider cannot starve older providers.
  const leads = Array.from({ length: 105 }, (_, i) => ({ id: uuid(1000 + i), provider_id: uuid(1), updated_at: at }))
  leads.push({ id: uuid(1200), provider_id: uuid(2), updated_at: '2026-10-16T00:00:00Z' })
  const { client, queries } = database({ worker_providers: providers, worker_leads: leads })
  const first = await getWorkerDashboard(0, client), second = await getWorkerDashboard(1, client)
  const ids = [...first.providers, ...second.providers].map(provider => provider.id)
  assert.equal(first.total, 31)
  assert.deepEqual(ids.slice(0, 2), [uuid(2), uuid(1)])
  assert.equal(ids.length, 31)
  assert.equal(new Set(ids).size, 31)
  assert.ok(queries.some(url => url.pathname.endsWith('worker_leads') && url.searchParams.get('offset') === '100'))
  assert.equal(first.providers[0].discovered_at, at)
})

test('provider View returns saved research text and scoped timeline without Worker lifecycle events', async () => {
  const provider = api(1)
  const lead = { id: uuid(2), provider_id: provider.id, updated_at: at, qualified_at: at, qualification_status: 'qualified', fit_reason: 'Exact <research> text',
    contactability_status: 'contact_unavailable', contact_researched_at: at, worker_providers: provider,
    worker_sources: [{ id: uuid(3), source_role: 'official_docs', url: 'https://p1.example/docs', factual_summary: 'Exact saved evidence', checked_at: at }] }
  const { client, queries } = database({ worker_providers: [provider, api(4)], worker_leads: [lead], worker_runs: [{ id: uuid(9), stopped_at: at }] })
  const result = await getWorkerProviderDetail(provider.id, 0, client)
  assert.equal(result?.research[0].summary, lead.fit_reason)
  assert.equal(result.research[0].evidence[0].summary, 'Exact saved evidence')
  assert.ok(result.activity.events.every(event => event.provider_id === provider.id))
  assert.ok(!queries.some(url => url.pathname.endsWith('worker_runs')))
})
