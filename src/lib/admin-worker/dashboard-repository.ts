import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { activityTimestamp, getWorkerActivity } from './activity-repository'
import type { WorkerDashboard, WorkerInvitation, WorkerProviderActivity, WorkerProviderDetail } from './dashboard-types'
import { contactCoverageLabel } from './contact-coverage'
import { INVITATION_TEMPLATE_VERSIONS } from './invitation-template'

type Row = Record<string, unknown>
type Result = { data: unknown; error: unknown; count?: number | null }
const PAGE_SIZE = 25
const PROVIDER_SELECT = 'id,canonical_name,canonical_domain,status,created_at,updated_at,worker_leads(id,qualification_status,fit_reason,contactability_status,contact_research_state,email_ready,updated_at)'
const ATTEMPT_SELECT = 'id,provider_id,status,reason_code,recipient_email,subject,body,draft_generator,draft_prepared_at,draft_template_version,draft_variables,reserved_at,dispatched_at,created_at,updated_at'
const HISTORY_SELECT = 'id,reason_code,updated_at'
const DELIVERY_SELECT = 'acquisition_attempt_id,acquisition_dispatch_started_at,acquisition_failure_at,acquisition_failure_code'
const MESSAGE_SELECT = `id,status,recipient_email,subject,body,provider_message_id,send_reserved_at,send_uncertain_at,sent_at,created_at,updated_at,${DELIVERY_SELECT},admin_acquisition_attempts(draft_generator,draft_template_version,draft_prepared_at),admin_outreach_delivery_events(event_type,provider_occurred_at)`
const MESSAGE_SUMMARY_SELECT = `id,status,provider_message_id,send_reserved_at,send_uncertain_at,sent_at,created_at,updated_at,${DELIVERY_SELECT},admin_outreach_delivery_events(event_type,provider_occurred_at)`

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
  if (!realAccepted(row) && row.acquisition_failure_at) return row.acquisition_failure_code === 'dispatch_blocked' ? 'Dispatch blocked' : 'Brevo rejected'
  return realAccepted(row) ? 'Sent' : row.status === 'sent' ? 'Unconfirmed' : label(row.status)
}

// Opens/proxy events are not evidence of human engagement or delivery.
function delivery(row: Row): string {
  const events = rows(row.admin_outreach_delivery_events)
  if (invitationStatus(row) === 'Simulated') return 'Simulated · no real delivery confirmed'
  if (!realAccepted(row)) {
    if (row.acquisition_failure_at) return `${row.acquisition_failure_code === 'dispatch_blocked' ? 'Dispatch blocked' : 'Brevo rejected'} · no automatic retry`
    if (row.send_uncertain_at || row.acquisition_dispatch_started_at) return 'Uncertain · do not resend'
    return row.send_reserved_at ? 'Reserved' : row.status === 'sent' ? 'Delivery unconfirmed' : 'Not sent'
  }
  for (const [type, text] of [['hard_bounce', 'Hard bounce'], ['blocked', 'Blocked'], ['delivered', 'Delivered'], ['soft_bounce', 'Soft bounce']]) {
    if (events.some(event => event.event_type === type)) return text
  }
  return 'Accepted · delivery unconfirmed'
}

export function acquisitionInvitation(row: Row): WorkerInvitation | null {
  if (typeof row.subject !== 'string' || typeof row.body !== 'string') return null
  const generator = row.draft_generator === 'groq' && typeof row.draft_prepared_at === 'string' ? 'groq'
    : row.draft_generator === 'template' && INVITATION_TEMPLATE_VERSIONS.includes(row.draft_template_version as typeof INVITATION_TEMPLATE_VERSIONS[number])
      && typeof row.draft_prepared_at === 'string' && row.draft_variables != null ? 'template' : null
  return {
    id: String(row.id), source: 'acquisition', recipient: string(row.recipient_email), subject: row.subject, body: row.body,
    status: row.status === 'simulated_sent' ? 'Simulated' : row.status === 'investigating' ? 'Draft' : label(row.status),
    generator, template_version: generator === 'template' ? string(row.draft_template_version) : null,
    prepared_at: generator ? string(row.draft_prepared_at) : null,
    reserved_at: string(row.reserved_at), sent_at: string(row.dispatched_at),
    delivery: row.status === 'simulated_sent' ? 'Simulated · no email sent' : row.status === 'uncertain' ? 'Uncertain · do not resend' : 'Not sent',
    events: row.reason_code ? [{ label: label(row.reason_code), at: String(row.updated_at) }] : [],
  }
}

export function outreachInvitation(row: Row): WorkerInvitation {
  const accepted = realAccepted(row)
  const draft = row.acquisition_attempt_id && row.admin_acquisition_attempts ? row.admin_acquisition_attempts as Row : null
  const template = draft && draft.draft_generator === 'template' && draft.draft_template_version === 'mahshar-provider-invitation-v2'
  return {
    id: String(row.id), source: 'outreach', recipient: string(row.recipient_email), subject: String(row.subject), body: String(row.body),
    status: accepted && delivery(row) === 'Delivered' ? 'Delivered' : invitationStatus(row),
    ...(row.acquisition_attempt_id ? { transport: 'brevo' as const } : {}),
    generator: template ? 'template' : null, template_version: template ? string(draft.draft_template_version) : null,
    prepared_at: template ? string(draft.draft_prepared_at) : string(row.created_at), reserved_at: string(row.send_reserved_at), sent_at: accepted ? string(row.sent_at) : null,
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
  const historical = attempt?.status === 'skipped' && attempt.reason_code ? attempt
    : rows(attempt?.admin_acquisition_attempt_history)[0]
  return {
    id: String(provider.id), name: String(provider.canonical_name), domain: String(provider.canonical_domain),
    qualification: qualified ? 'Qualified' : review ? 'Review required' : rejected ? 'Rejected' : 'Pending',
    reason: provider.status === 'do_not_contact' ? 'Do Not Contact' : provider.status === 'rejected' ? 'Provider rejected'
      : rejected ? string(leads[0]?.fit_reason) : null,
    historical_skip: historical ? { reason: label(historical.reason_code), at: String(historical.updated_at) } : null,
    invitation: message ? invitationStatus(message) : draft ? draft.status === 'Simulated' ? 'Prepared · simulated' : 'Prepared' : '—',
    delivery: message ? delivery(message) : draft ? draft.delivery : '—',
    has_invitation: !!message || !!draft,
    discovered_at: string(provider.created_at), latest_activity_at: string(provider.updated_at),
    contact: leads.some(lead => lead.email_ready === true) ? 'Email ready'
      : leads.some(lead => lead.contact_research_state === 'manual_required') ? contactCoverageLabel('manual_required')
      : leads.some(lead => lead.contact_research_state === 'form_available') ? contactCoverageLabel('form_available')
      : leads.some(lead => ['verified_email', 'verified_official_contact', 'official_contact_page', 'official_sales_channel'].includes(String(lead.contactability_status))) ? 'Official contact available'
        : leads.some(lead => ['none_found', 'contact_unavailable'].includes(String(lead.contactability_status))) ? 'Contact unavailable' : 'Not confirmed',
  }
}

export function parseDashboardPage(url: URL): number | null {
  const value = url.searchParams.get('page') ?? '0'
  return /^(0|[1-9][0-9]{0,4})$/.test(value) ? Number(value) : null
}

// A provider's own updated_at does not change when research, drafts or delivery change.
// Read only timestamp/identity projections, stopping each ordered stream after enough
// distinct providers (including timestamp ties) to determine the requested page.
async function latestProviderActivity(page: number, db: ReturnType<typeof createServiceClient>) {
  const needed = (page + 1) * PAGE_SIZE
  const streams = [
    { table: 'worker_providers', select: 'id,updated_at', at: 'updated_at', id: (row: Row) => row.id },
    { table: 'worker_leads', select: 'id,provider_id,updated_at', at: 'updated_at', id: (row: Row) => row.provider_id },
    { table: 'worker_sources', select: 'id,checked_at,worker_leads!inner(provider_id)', at: 'checked_at', id: (row: Row) => (row.worker_leads as Row | null)?.provider_id },
    { table: 'worker_contacts', select: 'id,provider_id,updated_at', at: 'updated_at', id: (row: Row) => row.provider_id },
    { table: 'admin_acquisition_attempts', select: 'id,provider_id,updated_at', at: 'updated_at', id: (row: Row) => row.provider_id },
    { table: 'admin_outreach_messages', select: 'id,updated_at,admin_outreach_threads!inner(provider_id)', at: 'updated_at', id: (row: Row) => (row.admin_outreach_threads as Row | null)?.provider_id },
    { table: 'admin_outreach_delivery_events', select: 'id,provider_occurred_at,admin_outreach_messages!inner(admin_outreach_threads!inner(provider_id))', at: 'provider_occurred_at', id: (row: Row) => ((row.admin_outreach_messages as Row | null)?.admin_outreach_threads as Row | null)?.provider_id },
  ]
  const groups = await Promise.all(streams.map(async stream => {
    const found = new Map<string, string>()
    for (let offset = 0; ; offset += 100) {
      const batch = checked(await db.from(stream.table).select(stream.select).not(stream.at, 'is', null)
        .order(stream.at, { ascending: false }).order('id', { ascending: false }).range(offset, offset + 99))
      for (const row of batch) {
        const id = stream.id(row), at = string(row[stream.at])
        if (typeof id === 'string' && at && Number.isFinite(Date.parse(at)) && !found.has(id)) found.set(id, at)
      }
      if (batch.length < 100) break
      const cutoff = [...found.values()][needed - 1]
      const last = string(batch.at(-1)?.[stream.at])
      if (cutoff && last && activityTimestamp(last) < activityTimestamp(cutoff)) break
    }
    return found
  }))
  const latest = new Map<string, string>()
  for (const group of groups) for (const [id, at] of group) {
    if (!latest.has(id) || activityTimestamp(at) > activityTimestamp(latest.get(id)!)) latest.set(id, at)
  }
  return [...latest].map(([id, at]) => ({ id, at }))
    .sort((a, b) => activityTimestamp(b.at).localeCompare(activityTimestamp(a.at)) || b.id.localeCompare(a.id))
    .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
}

export async function getWorkerDashboard(page = 0, db = createServiceClient()): Promise<WorkerDashboard> {
  const [providersResult, qualifiedResult, sentResult, inboundResult, preparedResult, templateResult, latest] = await Promise.all([
    db.from('worker_providers').select('id', { count: 'exact', head: true }),
    // Parent rows are counted once by PostgREST's inner existence filter, even with several qualified products.
    db.from('worker_providers').select('id,worker_leads!inner(id)', { count: 'exact', head: true }).eq('worker_leads.qualification_status', 'qualified'),
    db.from('admin_outreach_messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').eq('status', 'sent')
      .is('reply_to_message_id', null).not('provider_message_id', 'is', null).not('provider_message_id', 'imatch', '^[[:space:]]*<?simulated:').not('provider_message_id', 'match', '^[[:space:]]*$').not('sent_at', 'is', null),
    db.from('admin_outreach_messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound'),
    db.from('admin_acquisition_attempts').select('id', { count: 'exact', head: true }).eq('draft_generator', 'groq')
      .not('draft_prepared_at', 'is', null).not('subject', 'is', null).not('body', 'is', null),
    db.from('admin_acquisition_attempts').select('id', { count: 'exact', head: true }).eq('draft_generator', 'template')
      .in('draft_template_version', [...INVITATION_TEMPLATE_VERSIONS]).not('draft_variables', 'is', null)
      .not('draft_prepared_at', 'is', null).not('subject', 'is', null).not('body', 'is', null),
    latestProviderActivity(page, db),
  ])
  const ids = latest.map(item => item.id)
  const providers = ids.length ? checked(await db.from('worker_providers').select(PROVIDER_SELECT).in('id', ids)) : []
  const [attemptResult, threadResult] = ids.length ? await Promise.all([
    db.from('admin_acquisition_attempts').select(`${ATTEMPT_SELECT.replace(',recipient_email,subject,body', ',subject,body')},admin_acquisition_attempt_history(${HISTORY_SELECT})`).in('provider_id', ids)
      .order('updated_at', { referencedTable: 'admin_acquisition_attempt_history', ascending: false }).limit(1, { referencedTable: 'admin_acquisition_attempt_history' }),
    db.from('admin_outreach_threads').select(`provider_id,admin_outreach_messages(${MESSAGE_SUMMARY_SELECT})`).in('provider_id', ids)
      .eq('admin_outreach_messages.direction', 'outbound').is('admin_outreach_messages.reply_to_message_id', null)
      .order('created_at', { referencedTable: 'admin_outreach_messages', ascending: false }).limit(1, { referencedTable: 'admin_outreach_messages' }),
  ]) : [{ data: [], error: null }, { data: [], error: null }]
  const attempts = checked(attemptResult)
  const threads = checked(threadResult)
  const providerRows = latest.flatMap(item => {
    const provider = providers.find(row => row.id === item.id)
    if (!provider) return []
    const attempt = attempts.find(row => row.provider_id === provider.id)
    const messages = threads.filter(row => row.provider_id === provider.id).flatMap(row => rows(row.admin_outreach_messages))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return [{ ...providerActivity(provider, attempt, messages), latest_activity_at: item.at }]
  })
  const activity = await getWorkerActivity(null, 3, db)
  return { metrics: { found: count(providersResult), qualified: count(qualifiedResult), prepared: count(preparedResult) + count(templateResult),
    prepared_groq: count(preparedResult), prepared_template: count(templateResult),
    sent: count(sentResult), replies: null, inbound_received: count(inboundResult) }, providers: providerRows,
    recent: activity.events, activity_next_cursor: activity.next_cursor,
    page, total: count(providersResult), as_of: new Date().toISOString() }
}


export async function getWorkerProviderDetail(id: string, page = 0, db = createServiceClient()): Promise<WorkerProviderDetail | null> {
  const providerResult = await db.from('worker_providers').select(PROVIDER_SELECT).eq('id', id).maybeSingle()
  if (providerResult.error) throw new Error('worker_dashboard_unavailable')
  if (!providerResult.data) return null
  const provider = providerResult.data as unknown as Row
  const [attemptResult, threadResult, researchResult, activity, contactsResult, historyResult] = await Promise.all([
    db.from('admin_acquisition_attempts').select(`${ATTEMPT_SELECT},admin_acquisition_attempt_history(${HISTORY_SELECT})`).eq('provider_id', id)
      .order('updated_at', { referencedTable: 'admin_acquisition_attempt_history', ascending: false }).limit(1, { referencedTable: 'admin_acquisition_attempt_history' }),
    db.from('admin_outreach_threads').select('id').eq('provider_id', id),
    db.from('worker_leads').select('id,qualification_status,fit_reason,qualified_at,contactability_status,contact_research_state,contact_checked_at,contact_researched_at,preferred_contact_url,preferred_email,traction_summary,worker_sources(id,source_role,url,factual_summary,checked_at)')
      .eq('provider_id', id).order('updated_at', { ascending: false }).order('id').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    getWorkerActivity(null, 25, db, id),
    db.from('worker_contacts').select('id,contact_type,value,purpose,source_url,form_state,verified_at')
      .eq('provider_id', id).eq('verification_status', 'verified').order('verified_at', { ascending: false }).order('id')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    db.from('admin_acquisition_attempt_history').select(HISTORY_SELECT).eq('provider_id', id)
      .order('updated_at', { ascending: false }).order('id').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
  ])
  const attempt = checked(attemptResult)[0]
  const threadIds = checked(threadResult).map(thread => String(thread.id))
  const result = threadIds.length ? await db.from('admin_outreach_messages').select(MESSAGE_SELECT).in('thread_id', threadIds)
    .eq('direction', 'outbound').is('reply_to_message_id', null).order('created_at', { ascending: false }).order('id')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : { data: [], error: null }
  const messages = checked(result)
  const acquisition = attempt ? acquisitionInvitation(attempt) : null
  const research = checked(researchResult)
  const contacts = checked(contactsResult)
  const history = checked(historyResult)
  return { provider: providerActivity(provider, attempt, messages), invitations: [
    ...(page === 0 && acquisition ? [acquisition] : []), ...messages.slice(0, PAGE_SIZE).map(outreachInvitation),
  ], page, has_more: messages.length > PAGE_SIZE || research.length > PAGE_SIZE || contacts.length > PAGE_SIZE || history.length > PAGE_SIZE, activity,
    acquisition_history: history.slice(0, PAGE_SIZE).map(row => ({ id: String(row.id), reason: label(row.reason_code), at: String(row.updated_at) })),
    contacts: contacts.slice(0, PAGE_SIZE).map(row => ({ id: String(row.id), type: String(row.contact_type),
      value: String(row.value), purpose: label(row.purpose), source_url: String(row.source_url),
      form_state: row.form_state === 'available' || row.form_state === 'manual_required' ? row.form_state : null,
      verified_at: String(row.verified_at) })),
    research: research.slice(0, PAGE_SIZE).map(row => ({ id: String(row.id), qualification: label(row.qualification_status),
      summary: string(row.fit_reason), qualified_at: string(row.qualified_at), contact: label(row.contactability_status),
      contact_state: string(row.contact_research_state), contact_url: string(row.preferred_contact_url),
      contact_researched_at: string(row.contact_checked_at) ?? string(row.contact_researched_at), email: string(row.preferred_email), traction: string(row.traction_summary),
      evidence: rows(row.worker_sources).map(source => ({ id: String(source.id), role: label(source.source_role),
        url: String(source.url), summary: string(source.factual_summary), checked_at: String(source.checked_at) })),
    })) }
}
