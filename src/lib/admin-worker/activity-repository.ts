import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import type { WorkerActivity, WorkerActivityCursor, WorkerActivityHistory } from './dashboard-types'
import { INVITATION_TEMPLATE_VERSIONS } from './invitation-template'

type Row = Record<string, unknown>
type Db = ReturnType<typeof createServiceClient>
// Only the read surface is needed; avoid coupling dynamic projections to SDK select-parser types.
type ReadQuery = PromiseLike<{ data: unknown; error: unknown }> & {
  not(column: string, operator: 'is', value: null): ReadQuery
  eq(column: string, value: string): ReadQuery
  in(column: string, values: string[]): ReadQuery
  or(filters: string): ReadQuery
  lte(column: string, value: string): ReadQuery
  lt(column: string, value: string): ReadQuery
  order(column: string, options: { ascending: boolean }): ReadQuery
  limit(value: number): ReadQuery
}
const PROVIDER = 'worker_providers(id,canonical_name)'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SOURCES = ['found', 'research', 'lead', 'contact', 'verified', 'draft', 'template', 'reserved', 'attempt', 'message', 'stopped', 'completed', 'failed']

function label(value: unknown) { return String(value ?? 'Unknown').replace(/_/g, ' ') }
function object(value: unknown): Row { return value && typeof value === 'object' ? value as Row : {} }
function provider(row: Row): Row {
  return object(row.worker_providers ?? object(row.worker_leads).worker_providers
    ?? object(object(row.admin_outreach_threads).worker_leads).worker_providers)
}

// Keep database microseconds: Date.parse alone would collapse distinct events.
export function activityTimestamp(value: string) {
  return value.replace(/(?:Z|\+00:00)$/, '').replace(/(T\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/, (_, seconds, fraction = '') => `${seconds}.${fraction.padEnd(6, '0')}`)
}
export function compareWorkerActivity(a: WorkerActivity, b: WorkerActivity) {
  return activityTimestamp(b.at).localeCompare(activityTimestamp(a.at)) || b.id.localeCompare(a.id)
}

export function parseActivityCursor(url: URL): WorkerActivityCursor | null | undefined {
  const at = url.searchParams.get('before')
  const id = url.searchParams.get('id')
  if (at === null && id === null) return null
  if (!at || !id || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(at)
    || !Number.isFinite(Date.parse(at)) || !new RegExp(`^(?:${SOURCES.join('|')}):${UUID}$`, 'i').test(id)) return undefined
  return { at, id: id.toLowerCase() }
}

/** Merge bounded reads with a shared (timestamp, source:id) cursor, including ties. No RPCs or writes. */
export async function getWorkerActivity(cursor: WorkerActivityCursor | null = null, limit = 25, db: Db = createServiceClient(), providerId?: string): Promise<WorkerActivityHistory> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('worker_activity_limit_invalid')
  async function read(key: string, column: string, query: ReadQuery, stage: WorkerActivity['stage'], describe: (row: Row) => string) {
    if (providerId) {
      if (['stopped', 'completed', 'failed'].includes(key)) return []
      const path = key === 'found' ? 'id' : key === 'research' ? 'worker_leads.provider_id'
        : key === 'message' ? 'admin_outreach_threads.worker_leads.provider_id' : 'provider_id'
      query = query.eq(path, providerId)
    }
    query = query.not(column, 'is', null)
    if (cursor) {
      const [source, id] = cursor.id.split(':')
      query = key === source ? query.or(`${column}.lt.${cursor.at},and(${column}.eq.${cursor.at},id.lt.${id})`)
        : key < source ? query.lte(column, cursor.at) : query.lt(column, cursor.at)
    }
    const result = await query.order(column, { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
    if (result.error) throw new Error('worker_activity_unavailable')
    return (result.data as unknown as Row[] ?? []).flatMap(row => {
      if (typeof row[column] !== 'string' || !Number.isFinite(Date.parse(row[column]))) return []
      const api = provider(row)
      return [{ id: `${key}:${row.id}`, at: row[column], stage, label: describe(row),
        provider: String(api.canonical_name ?? row.canonical_name ?? (key === 'stopped' || key === 'completed' || key === 'failed' ? 'Worker' : 'Unknown provider')),
        provider_id: typeof api.id === 'string' ? api.id : key === 'found' ? String(row.id) : null } satisfies WorkerActivity]
    })
  }
  const select = (table: string, fields: string) => db.from(table).select(fields) as unknown as ReadQuery
  const groups = await Promise.all([
    read('found', 'created_at', select('worker_providers', 'id,canonical_name,created_at'), 'Discovery', () => 'Provider discovered'),
    read('research', 'checked_at', select('worker_sources', `id,source_role,checked_at,worker_leads!inner(provider_id,${PROVIDER})`)
      .in('source_role', ['official_site', 'official_docs', 'official_pricing', 'official_github']), 'Research', row => `${label(row.source_role)} evidence saved`),
    read('lead', 'qualified_at', select('worker_leads', `id,qualification_status,qualified_at,${PROVIDER}`)
      .in('qualification_status', ['qualified', 'rejected', 'review_candidate']), 'Qualification', row => `${label(row.qualification_status)} · saved qualification`),
    read('contact', 'contact_researched_at', select('worker_leads', `id,contactability_status,contact_researched_at,${PROVIDER}`), 'Contact', row => `Contact research saved · ${label(row.contactability_status)}`),
    read('verified', 'verified_at', select('worker_contacts', `id,verified_at,${PROVIDER}`).eq('verification_status', 'verified'), 'Contact', () => 'Official contact verified · eligibility separate'),
    read('draft', 'draft_prepared_at', select('admin_acquisition_attempts', `id,draft_prepared_at,${PROVIDER}`)
      .eq('draft_generator', 'groq').not('subject', 'is', null).not('body', 'is', null), 'Groq Drafting', () => 'Groq invitation saved · draft checkpoint'),
    read('template', 'draft_prepared_at', select('admin_acquisition_attempts', `id,draft_prepared_at,${PROVIDER}`)
      .eq('draft_generator', 'template').in('draft_template_version', [...INVITATION_TEMPLATE_VERSIONS])
      .not('draft_variables', 'is', null).not('subject', 'is', null).not('body', 'is', null),
      'Template Rendering', () => 'Standard invitation template saved · immutable draft checkpoint'),
    read('reserved', 'reserved_at', select('admin_acquisition_attempts', `id,reserved_at,${PROVIDER}`), 'Reservation', () => 'Simulated send slot reserved · no email sent'),
    read('attempt', 'updated_at', select('admin_acquisition_attempts', `id,status,reason_code,updated_at,${PROVIDER}`), null,
      row => `${row.status === 'simulated_sent' ? 'Invitation simulated · no email sent' : `Acquisition ${label(row.status)} · last saved state`}${row.reason_code ? ` · ${label(row.reason_code)}` : ''}`),
    read('message', 'updated_at', select('admin_outreach_messages', `id,direction,status,updated_at,admin_outreach_threads!inner(worker_leads!inner(provider_id,${PROVIDER}))`), 'Contact',
      row => row.direction === 'inbound' ? 'Inbound message saved · sender unverified' : `Outreach ${label(row.status)} · last saved message state`),
    read('stopped', 'stopped_at', select('worker_runs', 'id,stopped_at'), 'Stopped', () => 'Worker run stopped'),
    read('completed', 'completed_at', select('worker_runs', 'id,completed_at,completion_reason'), 'Discovery', row => `Discovery batch completed · ${label(row.completion_reason)}`),
    read('failed', 'updated_at', select('worker_runs', 'id,updated_at,error_code').eq('status', 'failed'), null, row => `Worker failed · ${label(row.error_code)}`),
  ])
  const sorted = groups.flat().sort(compareWorkerActivity)
  const events = sorted.slice(0, limit)
  const last = events.at(-1)
  return { events, next_cursor: sorted.length > limit && last ? { at: last.at, id: last.id } : null }
}
