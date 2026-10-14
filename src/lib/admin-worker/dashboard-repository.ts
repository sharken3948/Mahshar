import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import type { WorkerActivity, WorkerDashboard, WorkerInvitation, WorkerProviderActivity, WorkerProviderDetail } from './dashboard-types'

type Row = Record<string, unknown>
type Result = { data: unknown; error: unknown; count?: number | null }
const PAGE_SIZE = 25
const PROVIDER_SELECT = 'id,canonical_name,canonical_domain,status,created_at,updated_at,worker_leads(id,qualification_status,fit_reason,updated_at)'
const ATTEMPT_SELECT = 'id,provider_id,status,reason_code,recipient_email,subject,body,draft_generator,draft_prepared_at,reserved_at,dispatched_at,created_at,updated_at'
const MESSAGE_SELECT = 'id,status,recipient_email,subject,body,provider_message_id,send_reserved_at,send_uncertain_at,sent_at,created_at,updated_at,admin_outreach_delivery_events(event_type,provider_occurred_at)'
const MESSAGE_SUMMARY_SELECT = 'id,status,provider_message_id,send_reserved_at,send_uncertain_at,sent_at,created_at,updated_at,admin_outreach_delivery_events(event_type,provider_occurred_at)'

function rows(value: unknown): Row[] { return Array.isArray(value) ? value as Row[] : [] }
function string(value: unknown): string | null { return typeof value === 'string' ? value : null }
function checked(result: Result): Row[] {
  if (result.error) throw new Error('worker_dashboard_unavailable')
  return rows(result.data)
}
function count(result: Result): number {
  if (result.error || typeof result.count !== 'number') throw new Error('worker_dashboard_count_unavailable')
  return result.count
}
function label(value: unknown): string { return String(value ?? 'Unknown').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) }
function realAccepted(row: Row): boolean {
  return row.status === 'sent' && !!row.sent_at && typeof row.provider_message_id === 'string'
    && !!row.provider_message_id.trim() && !/^<?simulated:/i.test(row.provider_message_id.trim())
}
function invitationStatus(row: Row): string {
  if (/^<?simulated:/i.test(String(row.provider_message_id ?? '').trim())) return 'Simulated'
  return realAccepted(row) ? 'Sent' : row.status === 'sent' ? 'Unconfirmed' : label(row.status)
}

// Opens/proxy events are not evidence of human engagement or delivery.
function delivery(row: Row): string {
  const events = rows(row.admin_outreach_delivery_events)
  if (invitationStatus(row) === 'Simulated') return 'Simulated · no real delivery confirmed'
  if (!realAccepted(row)) return row.send_uncertain_at ? 'Uncertain · do not resend' : row.send_reserved_at ? 'Reserved' : row.status === 'sent' ? 'Delivery unconfirmed' : 'Not sent'
  for (const [type, text] of [['hard_bounce', 'Hard bounce'], ['blocked', 'Blocked'], ['delivered', 'Delivered'], ['soft_bounce', 'Soft bounce']]) {
    if (events.some(event => event.event_type === type)) return text
  }
  return 'Accepted · delivery unconfirmed'
}

export function acquisitionInvitation(row: Row): WorkerInvitation | null {
  if (typeof row.subject !== 'string' || typeof row.body !== 'string') return null
  return {
    id: String(row.id), source: 'acquisition', recipient: string(row.recipient_email), subject: row.subject, body: row.body,
    status: row.status === 'simulated_sent' ? 'Simulated' : row.status === 'investigating' ? 'Draft' : label(row.status),
    generator: row.draft_generator === 'groq' && typeof row.draft_prepared_at === 'string' ? 'groq' : null,
    prepared_at: row.draft_generator === 'groq' ? string(row.draft_prepared_at) : null,
    reserved_at: string(row.reserved_at), sent_at: string(row.dispatched_at),
    delivery: row.status === 'simulated_sent' ? 'Simulated · no email sent' : row.status === 'uncertain' ? 'Uncertain · do not resend' : 'Not sent',
    events: row.reason_code ? [{ label: label(row.reason_code), at: String(row.updated_at) }] : [],
  }
}

export function outreachInvitation(row: Row): WorkerInvitation {
  const accepted = realAccepted(row)
  return {
    id: String(row.id), source: 'outreach', recipient: string(row.recipient_email), subject: String(row.subject), body: String(row.body),
    status: accepted && delivery(row) === 'Delivered' ? 'Delivered' : invitationStatus(row),
    generator: null, prepared_at: string(row.created_at), reserved_at: string(row.send_reserved_at), sent_at: accepted ? string(row.sent_at) : null,
    delivery: delivery(row), events: rows(row.admin_outreach_delivery_events).map(event => ({
      label: event.event_type === 'opened' ? 'Opened / proxy event · engagement unverified' : label(event.event_type),
      at: String(event.provider_occurred_at),
    })),
  }
}

export function providerActivity(provider: Row, attempt?: Row, messages: Row[] = []): WorkerProviderActivity {
  const leads = rows(provider.worker_leads)
  const qualified = leads.some(lead => lead.qualification_status === 'qualified')
  const review = leads.some(lead => lead.qualification_status === 'review_candidate')
  const rejected = leads.length > 0 && leads.every(lead => lead.qualification_status === 'rejected')
  const message = messages.find(realAccepted) ?? messages[0]
  const draft = attempt ? acquisitionInvitation(attempt) : null
  return {
    id: String(provider.id), name: String(provider.canonical_name), domain: String(provider.canonical_domain),
    qualification: qualified ? 'Qualified' : review ? 'Review required' : rejected ? 'Rejected' : 'Pending',
    reason: provider.status === 'do_not_contact' ? 'Do Not Contact' : provider.status === 'rejected' ? 'Provider rejected'
      : attempt?.reason_code ? label(attempt.reason_code) : rejected ? string(leads[0]?.fit_reason) : null,
    invitation: message ? invitationStatus(message) : draft ? draft.status === 'Simulated' ? 'Prepared · simulated' : 'Prepared' : '—',
    delivery: message ? delivery(message) : draft ? draft.delivery : '—',
    has_invitation: !!message || !!draft,
  }
}

export function parseDashboardPage(url: URL): number | null {
  const value = url.searchParams.get('page') ?? '0'
  return /^(0|[1-9][0-9]{0,4})$/.test(value) ? Number(value) : null
}

export async function getWorkerDashboard(page = 0, db = createServiceClient()): Promise<WorkerDashboard> {
  const [providersResult, qualifiedResult, sentResult, inboundResult, preparedResult] = await Promise.all([
    db.from('worker_providers').select(PROVIDER_SELECT, { count: 'exact' }).order('updated_at', { ascending: false }).order('id').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
    // Parent rows are counted once by PostgREST's inner existence filter, even with several qualified products.
    db.from('worker_providers').select('id,worker_leads!inner(id)', { count: 'exact', head: true }).eq('worker_leads.qualification_status', 'qualified'),
    db.from('admin_outreach_messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').eq('status', 'sent')
      .is('reply_to_message_id', null).not('provider_message_id', 'is', null).not('provider_message_id', 'imatch', '^[[:space:]]*<?simulated:').not('provider_message_id', 'match', '^[[:space:]]*$').not('sent_at', 'is', null),
    db.from('admin_outreach_messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound'),
    db.from('admin_acquisition_attempts').select('id', { count: 'exact', head: true }).eq('draft_generator', 'groq')
      .not('draft_prepared_at', 'is', null).not('subject', 'is', null).not('body', 'is', null),
  ])
  const providers = checked(providersResult)
  const ids = providers.map(provider => String(provider.id))
  const [attemptResult, threadResult] = ids.length ? await Promise.all([
    db.from('admin_acquisition_attempts').select(ATTEMPT_SELECT.replace(',recipient_email,subject,body', ',subject,body')).in('provider_id', ids),
    db.from('admin_outreach_threads').select(`provider_id,admin_outreach_messages(${MESSAGE_SUMMARY_SELECT})`).in('provider_id', ids)
      .eq('admin_outreach_messages.direction', 'outbound').is('admin_outreach_messages.reply_to_message_id', null)
      .order('created_at', { referencedTable: 'admin_outreach_messages', ascending: false }).limit(1, { referencedTable: 'admin_outreach_messages' }),
  ]) : [{ data: [], error: null }, { data: [], error: null }]
  const attempts = checked(attemptResult)
  const threads = checked(threadResult)
  const providerRows = providers.map(provider => {
    const attempt = attempts.find(row => row.provider_id === provider.id)
    const messages = threads.filter(row => row.provider_id === provider.id).flatMap(row => rows(row.admin_outreach_messages))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return providerActivity(provider, attempt, messages)
  })
  const recent = await recentActivity(db)
  return { metrics: { found: count(providersResult), qualified: count(qualifiedResult), prepared: count(preparedResult),
    sent: count(sentResult), replies: null, inbound_received: count(inboundResult) }, providers: providerRows,
    recent: recent.filter(event => Number.isFinite(Date.parse(event.at))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
    page, total: count(providersResult), as_of: new Date().toISOString() }
}

async function recentActivity(db: ReturnType<typeof createServiceClient>): Promise<WorkerActivity[]> {
  const [discovered, investigated, qualified, contacts, messages] = await Promise.all([
    db.from('worker_providers').select('id,canonical_name,created_at').order('created_at', { ascending: false }).limit(10),
    db.from('admin_acquisition_attempts').select('id,status,reason_code,updated_at,worker_providers(canonical_name)').order('updated_at', { ascending: false }).limit(10),
    db.from('worker_leads').select('id,qualification_status,updated_at,worker_providers(canonical_name)').in('qualification_status', ['qualified', 'rejected', 'review_candidate']).order('updated_at', { ascending: false }).limit(10),
    db.from('worker_contacts').select('id,verified_at,worker_providers(canonical_name)').eq('verification_status', 'verified').not('verified_at', 'is', null).order('verified_at', { ascending: false }).limit(10),
    db.from('admin_outreach_messages').select('id,direction,status,provider_message_id,sent_at,created_at,admin_outreach_threads(worker_leads(worker_providers(canonical_name)))').order('created_at', { ascending: false }).limit(10),
  ])
  const name = (row: Row) => string((row.worker_providers as Row | null)?.canonical_name) ?? 'Unknown provider'
  const recent: WorkerActivity[] = [
    ...checked(discovered).map(row => ({ id: `found:${row.id}`, provider: String(row.canonical_name), label: 'Provider discovered', at: String(row.created_at) })),
    ...checked(investigated).map(row => ({ id: `attempt:${row.id}`, provider: name(row), label: row.status === 'simulated_sent' ? 'Invitation simulated · no email sent'
      : `Acquisition ${label(row.status).toLowerCase()}${row.reason_code ? ` · ${label(row.reason_code)}` : ''}`, at: String(row.updated_at) })),
    ...checked(qualified).map(row => ({ id: `lead:${row.id}`, provider: name(row), label: `${label(row.qualification_status)} · last saved lead state`, at: String(row.updated_at) })),
    ...checked(contacts).map(row => ({ id: `contact:${row.id}`, provider: name(row), label: 'Official contact verified · eligibility separate', at: String(row.verified_at) })),
    ...checked(messages).map(row => {
      const thread = row.admin_outreach_threads as Row | null
      const lead = thread?.worker_leads as Row | null
      return { id: `message:${row.id}`, provider: lead ? name(lead) : 'Unmatched inbound',
        label: row.direction === 'inbound' ? 'Inbound message received · sender unverified' : realAccepted(row) ? 'Invitation accepted by sending provider' : 'Outreach message saved',
        at: String(row.sent_at ?? row.created_at) }
    }),
  ]
  return recent
}

export async function getWorkerProviderDetail(id: string, page = 0, db = createServiceClient()): Promise<WorkerProviderDetail | null> {
  const providerResult = await db.from('worker_providers').select(PROVIDER_SELECT).eq('id', id).maybeSingle()
  if (providerResult.error) throw new Error('worker_dashboard_unavailable')
  if (!providerResult.data) return null
  const provider = providerResult.data as unknown as Row
  const [attemptResult, threadResult] = await Promise.all([
    db.from('admin_acquisition_attempts').select(ATTEMPT_SELECT).eq('provider_id', id),
    db.from('admin_outreach_threads').select('id').eq('provider_id', id),
  ])
  const attempt = checked(attemptResult)[0]
  const threadIds = checked(threadResult).map(thread => String(thread.id))
  const result = threadIds.length ? await db.from('admin_outreach_messages').select(MESSAGE_SELECT).in('thread_id', threadIds)
    .eq('direction', 'outbound').is('reply_to_message_id', null).order('created_at', { ascending: false }).order('id')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : { data: [], error: null }
  const messages = checked(result)
  const acquisition = attempt ? acquisitionInvitation(attempt) : null
  return { provider: providerActivity(provider, attempt, messages), invitations: [
    ...(page === 0 && acquisition ? [acquisition] : []), ...messages.slice(0, PAGE_SIZE).map(outreachInvitation),
  ], page, has_more: messages.length > PAGE_SIZE }
}
