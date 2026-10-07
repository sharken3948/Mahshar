import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { getQualifiedWorkerLeads } from '@/lib/admin-worker/repository'
import { isVerifiedOutreachEmail } from '@/lib/admin-worker/contact-readiness'
import { generateGroundedOutreachDraft, isEmailOutreachEligible } from './draft'
import { outreachTransportConfigured } from './transport'
import { outreachStatuses, type OutreachDashboardDto, type OutreachLeadDto,
  type OutreachMessageDto, type OutreachStatus } from './types'

type DbError = { message?: string; code?: string } | null
type DbResult = { data: unknown; error: DbError }

function dbFailure(scope: string, error: DbError): never {
  console.error(`[admin-outreach] ${scope} unavailable`, error?.code ?? error?.message ?? 'unknown database error')
  throw new Error(error?.message || `${scope}_unavailable`)
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Record<string, unknown>[] : []
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null
}

function messageDto(row: Record<string, unknown>): OutreachMessageDto {
  const status = String(row.status)
  if (typeof row.id !== 'string' || !['draft','ready_to_send','sent','failed','received'].includes(status)
    || !isVerifiedOutreachEmail(row.recipient_email) || !isVerifiedOutreachEmail(row.sender_email)
    || typeof row.subject !== 'string' || typeof row.body !== 'string') throw new Error('admin_outreach_message_invalid')
  return {
    id: row.id, status: status as OutreachMessageDto['status'], recipient_email: row.recipient_email,
    sender_email: row.sender_email, subject: row.subject, body: row.body,
    provider_message_id: typeof row.provider_message_id === 'string' ? row.provider_message_id : null,
    approved_at: timestamp(row.approved_at), sent_at: timestamp(row.sent_at),
    created_at: timestamp(row.created_at) ?? (() => { throw new Error('admin_outreach_message_invalid') })(),
    updated_at: timestamp(row.updated_at) ?? (() => { throw new Error('admin_outreach_message_invalid') })(),
  }
}

export async function getOutreachDashboard(): Promise<OutreachDashboardDto> {
  const db = createServiceClient()
  const contactReady = await getQualifiedWorkerLeads(50)
  const leadIds = contactReady.leads.map(lead => lead.id)
  if (leadIds.length === 0) return {
    leads: [], contact_form_only: [],
    counts: Object.fromEntries([...outreachStatuses.map(status => [status, 0]), ['contact_form_only', 0]]) as OutreachDashboardDto['counts'],
    transport: { outbound: outreachTransportConfigured() ? 'configured' : 'not_configured', sender: 'support@mahshar.xyz' }, replies: { inbound: 'not_configured' },
    as_of: new Date().toISOString(),
  }
  const identityResult = await db.from('worker_leads').select('id,provider_id').in('id', leadIds) as DbResult
  if (identityResult.error) dbFailure('lead identities', identityResult.error)
  const identities = rows(identityResult.data)
  const providerIds = [...new Set(identities.flatMap(row => typeof row.provider_id === 'string' ? [row.provider_id] : []))]
  const [providersResult, decisionsResult, threadsResult] = await Promise.all([
    db.from('worker_providers').select('id,status').in('id', providerIds),
    db.from('worker_decisions').select('provider_id,lead_id,decision').in('provider_id', providerIds),
    db.from('admin_outreach_threads').select('id,lead_id,provider_id,status,last_outreach_at,last_reply_at,updated_at').in('lead_id', leadIds),
  ]) as [DbResult, DbResult, DbResult]
  if (providersResult.error) dbFailure('providers', providersResult.error)
  if (decisionsResult.error) dbFailure('decisions', decisionsResult.error)
  if (threadsResult.error) dbFailure('threads', threadsResult.error)
  const providers = new Map(rows(providersResult.data).map(row => [row.id, row.status]))
  const decisions = rows(decisionsResult.data)
  const threads = rows(threadsResult.data)
  const threadIds = threads.flatMap(row => typeof row.id === 'string' ? [row.id] : [])
  const messagesResult = threadIds.length
    ? await db.from('admin_outreach_messages').select('id,thread_id,status,recipient_email,sender_email,subject,body,provider_message_id,approved_at,sent_at,created_at,updated_at')
      .in('thread_id', threadIds).order('created_at', { ascending: false }) as DbResult
    : { data: [], error: null }
  if (messagesResult.error) dbFailure('messages', messagesResult.error)
  const messages = rows(messagesResult.data)
  const identityByLead = new Map(identities.map(row => [row.id, row.provider_id]))
  const threadByLead = new Map(threads.map(row => [row.lead_id, row]))
  const allowed = contactReady.leads.filter(lead => {
    const providerId = identityByLead.get(lead.id)
    if (typeof providerId !== 'string' || providers.get(providerId) !== 'active') return false
    return !decisions.some(decision => decision.provider_id === providerId
      && (decision.lead_id === null || decision.lead_id === lead.id)
      && ['rejected','do_not_contact'].includes(String(decision.decision)))
  })
  const emailLeads: OutreachLeadDto[] = allowed.filter(isEmailOutreachEligible).map(lead => {
    const providerId = identityByLead.get(lead.id) as string
    const thread = threadByLead.get(lead.id)
    const status = thread && outreachStatuses.includes(thread.status as OutreachStatus)
      ? thread.status as OutreachStatus : 'contact_ready'
    const history = thread ? messages.filter(message => message.thread_id === thread.id).map(messageDto) : []
    return { ...lead, provider_id: providerId, outreach_status: status,
      last_outreach_at: timestamp(thread?.last_outreach_at), last_reply_at: timestamp(thread?.last_reply_at),
      draft: history.find(message => ['draft','ready_to_send'].includes(message.status)) ?? null,
      history: history.filter(message => ['sent','received','failed'].includes(message.status)).slice(0, 10) }
  })
  const counts = Object.fromEntries([
    ...outreachStatuses.map(status => [status, emailLeads.filter(lead => lead.outreach_status === status).length]),
    ['contact_form_only', allowed.filter(lead => !lead.email_ready && Boolean(lead.official_contact_url)).length],
  ]) as OutreachDashboardDto['counts']
  return {
    leads: emailLeads,
    contact_form_only: allowed.filter(lead => !lead.email_ready && Boolean(lead.official_contact_url)).map(lead => ({
      id: lead.id, provider: lead.provider, product: lead.product, fit_score: lead.fit_score,
      official_contact_url: lead.official_contact_url,
    })),
    counts, transport: { outbound: outreachTransportConfigured() ? 'configured' : 'not_configured', sender: 'support@mahshar.xyz' },
    replies: { inbound: 'not_configured' }, as_of: new Date().toISOString(),
  }
}

function rpcFailure(error: DbError): never {
  const message = error?.message ?? 'admin_outreach_mutation_failed'
  throw new Error(message)
}

export async function createOutreachDraft(leadId: string): Promise<unknown> {
  const dashboard = await getOutreachDashboard()
  const lead = dashboard.leads.find(item => item.id === leadId)
  if (!lead || !isEmailOutreachEligible(lead)) throw new Error('admin_outreach_lead_not_email_ready')
  const draft = generateGroundedOutreachDraft(lead)
  const result = await createServiceClient().rpc('mahshar_admin_outreach_save_draft', {
    p_provider_id: lead.provider_id, p_lead_id: lead.id, p_recipient_email: lead.preferred_email,
    p_subject: draft.subject, p_body: draft.body,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

export async function editOutreachDraft(messageId: string, subject: string, body: string): Promise<unknown> {
  const result = await createServiceClient().rpc('mahshar_admin_outreach_edit_draft', {
    p_message_id: messageId, p_subject: subject, p_body: body,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

export async function approveOutreachDraft(messageId: string, adminWallet: string): Promise<unknown> {
  const result = await createServiceClient().rpc('mahshar_admin_outreach_approve_draft', {
    p_message_id: messageId, p_admin_wallet: adminWallet.toLowerCase(),
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

export async function getApprovedOutreachMessage(messageId: string): Promise<OutreachMessageDto> {
  const result = await createServiceClient().from('admin_outreach_messages')
    .select('id,status,recipient_email,sender_email,subject,body,provider_message_id,approved_at,sent_at,created_at,updated_at')
    .eq('id', messageId).single() as DbResult
  if (result.error) dbFailure('approved message', result.error)
  const message = messageDto(rows(result.data)[0] ?? (result.data as Record<string, unknown>))
  if (message.status !== 'ready_to_send') throw new Error('admin_outreach_message_not_approved')
  return message
}

export async function markOutreachSent(messageId: string, providerMessageId: string): Promise<unknown> {
  const result = await createServiceClient().rpc('mahshar_admin_outreach_mark_sent', {
    p_message_id: messageId, p_provider_message_id: providerMessageId,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

export async function setOutreachStatus(leadId: string, status: OutreachStatus): Promise<unknown> {
  if (!outreachStatuses.includes(status)) throw new Error('admin_outreach_status_invalid')
  const lead = (await getOutreachDashboard()).leads.find(item => item.id === leadId)
  if (!lead) throw new Error('admin_outreach_lead_blocked')
  const result = await createServiceClient().rpc('mahshar_admin_outreach_set_status', {
    p_provider_id: lead.provider_id, p_lead_id: leadId, p_status: status,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}
