import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { getQualifiedWorkerLeads } from '@/lib/admin-worker/repository'
import { isVerifiedOutreachEmail } from '@/lib/admin-worker/contact-readiness'
import { generateGroundedOutreachDraft, isEmailOutreachEligible } from './draft'
import { outreachTransportConfigured } from './transport'
import { outreachStatuses, type OutreachDashboardDto, type OutreachLeadDto,
  type OutreachClassification, type OutreachInboxItemDto, type OutreachMessageDto,
  type OutreachProcessingState, type OutreachStatus } from './types'
import type { NormalizedInboundReply } from './inbound'
import type { ReplyClassification, SuggestedReply } from './intelligence'

type DbError = { message?: string; code?: string } | null
type DbResult = { data: unknown; error: DbError }
type DbCountResult = DbResult & { count: number | null }

const MESSAGE_SELECT = 'id,thread_id,direction,status,recipient_email,sender_email,subject,body,provider_message_id,in_reply_to,reference_ids,received_at,classification,classification_confidence,classification_reason,processing_state,matched_by,reply_to_message_id,approved_at,sent_at,created_at,updated_at'

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
  const direction = String(row.direction)
  const processingState = String(row.processing_state)
  if (typeof row.id !== 'string' || !['draft','ready_to_send','sent','failed','received'].includes(status)
    || !['inbound','outbound'].includes(direction)
    || !['not_applicable','received','unmatched','classified','suggested','suggestion_failed'].includes(processingState)
    || !isVerifiedOutreachEmail(row.recipient_email) || !isVerifiedOutreachEmail(row.sender_email)
    || typeof row.subject !== 'string' || typeof row.body !== 'string') throw new Error('admin_outreach_message_invalid')
  const references = Array.isArray(row.reference_ids) ? row.reference_ids
    .filter((value): value is string => typeof value === 'string').slice(0, 12).map(value => value.slice(0, 512)) : []
  const classification = ['interested','payment_question','technical_question','not_interested','do_not_contact','other']
    .includes(String(row.classification)) ? row.classification as OutreachClassification : null
  return {
    id: row.id, thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
    direction: direction as OutreachMessageDto['direction'], status: status as OutreachMessageDto['status'], recipient_email: row.recipient_email,
    sender_email: row.sender_email, subject: row.subject.slice(0, 200), body: row.body.slice(0, 5000),
    provider_message_id: typeof row.provider_message_id === 'string' ? row.provider_message_id : null,
    in_reply_to: typeof row.in_reply_to === 'string' ? row.in_reply_to : null, reference_ids: references,
    received_at: timestamp(row.received_at), classification,
    classification_confidence: typeof row.classification_confidence === 'number' ? row.classification_confidence : null,
    classification_reason: typeof row.classification_reason === 'string' ? row.classification_reason.slice(0, 240) : null,
    processing_state: processingState as OutreachProcessingState,
    matched_by: ['in_reply_to','reference','subject_context','sender_unambiguous'].includes(String(row.matched_by))
      ? row.matched_by as OutreachMessageDto['matched_by'] : null,
    reply_to_message_id: typeof row.reply_to_message_id === 'string' ? row.reply_to_message_id : null,
    approved_at: timestamp(row.approved_at), sent_at: timestamp(row.sent_at),
    created_at: timestamp(row.created_at) ?? (() => { throw new Error('admin_outreach_message_invalid') })(),
    updated_at: timestamp(row.updated_at) ?? (() => { throw new Error('admin_outreach_message_invalid') })(),
  }
}

export async function getOutreachDashboard(): Promise<OutreachDashboardDto> {
  const db = createServiceClient()
  const [contactReady, inboxResult, inboxCountResult, unmatchedCountResult, needsReplyCountResult, draftCountResult, sentCountResult] = await Promise.all([
    getQualifiedWorkerLeads(50),
    db.from('admin_outreach_messages').select(MESSAGE_SELECT).eq('direction', 'inbound')
      .order('received_at', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: true }).limit(100),
    db.from('admin_outreach_messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound'),
    db.from('admin_outreach_messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound')
      .is('thread_id', null).eq('processing_state', 'unmatched'),
    db.from('admin_outreach_threads').select('id', { count: 'exact', head: true }).eq('status', 'needs_reply'),
    db.from('admin_outreach_threads').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
    db.from('admin_outreach_threads').select('id', { count: 'exact', head: true }).eq('status', 'sent'),
  ]) as [Awaited<ReturnType<typeof getQualifiedWorkerLeads>>, DbResult, DbCountResult, DbCountResult,
    DbCountResult, DbCountResult, DbCountResult]
  if (inboxResult.error) dbFailure('inbox', inboxResult.error)
  if (inboxCountResult.error) dbFailure('inbox count', inboxCountResult.error)
  if (unmatchedCountResult.error) dbFailure('unmatched inbox count', unmatchedCountResult.error)
  if (needsReplyCountResult.error) dbFailure('needs reply count', needsReplyCountResult.error)
  if (draftCountResult.error) dbFailure('draft count', draftCountResult.error)
  if (sentCountResult.error) dbFailure('sent count', sentCountResult.error)
  const inboxMessages = rows(inboxResult.data)
  const leadIds = contactReady.leads.map(lead => lead.id)
  const identityResult = leadIds.length
    ? await db.from('worker_leads').select('id,provider_id').in('id', leadIds) as DbResult
    : { data: [], error: null }
  if (identityResult.error) dbFailure('lead identities', identityResult.error)
  const identities = rows(identityResult.data)
  const providerIds = [...new Set(identities.flatMap(row => typeof row.provider_id === 'string' ? [row.provider_id] : []))]
  const inboxThreadIds = [...new Set(inboxMessages.flatMap(row => typeof row.thread_id === 'string' ? [row.thread_id] : []))]
  const emptyResult: DbResult = { data: [], error: null }
  const [providersResult, decisionsResult, threadsResult, inboxThreadsResult] = await Promise.all([
    providerIds.length ? db.from('worker_providers').select('id,status').in('id', providerIds) : emptyResult,
    providerIds.length ? db.from('worker_decisions').select('provider_id,lead_id,decision').in('provider_id', providerIds) : emptyResult,
    leadIds.length ? db.from('admin_outreach_threads').select('id,lead_id,provider_id,status,last_outreach_at,last_reply_at,updated_at').in('lead_id', leadIds) : emptyResult,
    inboxThreadIds.length ? db.from('admin_outreach_threads').select('id,lead_id,provider_id,status,last_outreach_at,last_reply_at,updated_at').in('id', inboxThreadIds) : emptyResult,
  ]) as [DbResult, DbResult, DbResult, DbResult]
  if (providersResult.error) dbFailure('providers', providersResult.error)
  if (decisionsResult.error) dbFailure('decisions', decisionsResult.error)
  if (threadsResult.error) dbFailure('threads', threadsResult.error)
  if (inboxThreadsResult.error) dbFailure('inbox threads', inboxThreadsResult.error)
  const providers = new Map(rows(providersResult.data).map(row => [row.id, row.status]))
  const decisions = rows(decisionsResult.data)
  const threads = [...new Map([...rows(threadsResult.data), ...rows(inboxThreadsResult.data)]
    .flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : [])).values()]
  const threadIds = threads.flatMap(row => typeof row.id === 'string' ? [row.id] : [])
  const messagesResult = threadIds.length
    ? await db.from('admin_outreach_messages').select(MESSAGE_SELECT)
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
      history: history.filter(message => ['sent','received','failed'].includes(message.status)).slice(0, 20) }
  })
  const counts = Object.fromEntries([
    ...outreachStatuses.map(status => [status, status === 'needs_reply' ? needsReplyCountResult.count ?? 0
      : status === 'draft' ? draftCountResult.count ?? 0
        : status === 'sent' ? sentCountResult.count ?? 0
          : emailLeads.filter(lead => lead.outreach_status === status).length]),
    ['inbox', inboxCountResult.count ?? inboxMessages.length],
    ['unmatched_inbound', unmatchedCountResult.count ?? inboxMessages.filter(message => message.thread_id === null && message.processing_state === 'unmatched').length],
    ['contact_form_only', allowed.filter(lead => !lead.email_ready && Boolean(lead.official_contact_url)).length],
  ]) as OutreachDashboardDto['counts']
  const leadById = new Map(emailLeads.map(lead => [lead.id, lead]))
  const threadById = new Map(threads.flatMap(thread => typeof thread.id === 'string' ? [[thread.id, thread] as const] : []))
  const inbox: OutreachInboxItemDto[] = inboxMessages.map(row => {
    const message = messageDto(row)
    const matched = message.thread_id !== null && message.processing_state !== 'unmatched'
    const unmatched = message.thread_id === null && message.processing_state === 'unmatched'
    if (!matched && !unmatched) throw new Error('admin_outreach_inbox_match_invalid')
    const thread = message.thread_id ? threadById.get(message.thread_id) : undefined
    const leadId = typeof thread?.lead_id === 'string' ? thread.lead_id : null
    const lead = leadId ? leadById.get(leadId) : undefined
    const threadStatus = outreachStatuses.includes(thread?.status as OutreachStatus) ? thread?.status as OutreachStatus : null
    return { message, match_state: matched ? 'matched' : 'unmatched', lead_id: leadId,
      provider: lead?.provider ?? null, product: lead?.product ?? null, thread_status: threadStatus }
  })
  return {
    leads: emailLeads,
    inbox,
    contact_form_only: allowed.filter(lead => !lead.email_ready && Boolean(lead.official_contact_url)).map(lead => ({
      id: lead.id, provider: lead.provider, product: lead.product, fit_score: lead.fit_score,
      official_contact_url: lead.official_contact_url,
    })),
    counts, transport: { outbound: outreachTransportConfigured() ? 'configured' : 'not_configured', sender: 'support@mahshar.xyz' },
    replies: { inbound: (process.env.OUTREACH_INBOUND_WEBHOOK_SECRET?.trim().length ?? 0) >= 32 ? 'mailbox_bridge_configured' : 'not_configured' },
    as_of: new Date().toISOString(),
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
  const db = createServiceClient()
  const reply = await isReplyDraft(db, messageId)
  const result = await db.rpc(reply ? 'mahshar_admin_outreach_edit_reply_draft' : 'mahshar_admin_outreach_edit_draft', {
    p_message_id: messageId, p_subject: subject, p_body: body,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

export async function approveOutreachDraft(messageId: string, adminWallet: string): Promise<unknown> {
  const db = createServiceClient()
  const reply = await isReplyDraft(db, messageId)
  const result = await db.rpc(reply ? 'mahshar_admin_outreach_approve_reply_draft' : 'mahshar_admin_outreach_approve_draft', {
    p_message_id: messageId, p_admin_wallet: adminWallet.toLowerCase(),
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

export async function getApprovedOutreachMessage(messageId: string): Promise<OutreachMessageDto> {
  const result = await createServiceClient().from('admin_outreach_messages')
    .select('id,direction,status,recipient_email,sender_email,subject,body,provider_message_id,in_reply_to,reference_ids,received_at,classification,classification_confidence,classification_reason,processing_state,matched_by,reply_to_message_id,approved_at,sent_at,created_at,updated_at')
    .eq('id', messageId).single() as DbResult
  if (result.error) dbFailure('approved message', result.error)
  const message = messageDto(rows(result.data)[0] ?? (result.data as Record<string, unknown>))
  if (message.status !== 'ready_to_send') throw new Error('admin_outreach_message_not_approved')
  if (message.reply_to_message_id) {
    const sendable = await createServiceClient().rpc('mahshar_admin_outreach_assert_reply_sendable', {
      p_message_id: message.id,
    }) as DbResult
    if (sendable.error) rpcFailure(sendable.error)
  }
  return message
}

export async function markOutreachSent(messageId: string, providerMessageId: string): Promise<unknown> {
  const db = createServiceClient()
  const reply = await isReplyDraft(db, messageId)
  const result = await db.rpc(reply ? 'mahshar_admin_outreach_mark_reply_sent' : 'mahshar_admin_outreach_mark_sent', {
    p_message_id: messageId, p_provider_message_id: providerMessageId,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return result.data
}

async function isReplyDraft(db: ReturnType<typeof createServiceClient>, messageId: string): Promise<boolean> {
  const result = await db.from('admin_outreach_messages').select('reply_to_message_id').eq('id', messageId).single() as DbResult
  if (result.error) rpcFailure(result.error)
  return Boolean(result.data && typeof result.data === 'object'
    && typeof (result.data as Record<string, unknown>).reply_to_message_id === 'string')
}

export type InboundIngestResult = {
  id: string
  threadId: string | null
  matchedBy: OutreachMessageDto['matched_by']
  processingState: OutreachProcessingState
  duplicate: boolean
}

function inboundResult(value: unknown): InboundIngestResult {
  if (!value || typeof value !== 'object') throw new Error('admin_outreach_inbound_result_invalid')
  const row = value as Record<string, unknown>
  const state = String(row.processingState)
  if (typeof row.id !== 'string' || !['received','unmatched','classified','suggested','suggestion_failed'].includes(state)
    || typeof row.duplicate !== 'boolean') throw new Error('admin_outreach_inbound_result_invalid')
  return { id: row.id, threadId: typeof row.threadId === 'string' ? row.threadId : null,
    matchedBy: ['in_reply_to','reference','subject_context','sender_unambiguous'].includes(String(row.matchedBy))
      ? row.matchedBy as InboundIngestResult['matchedBy'] : null,
    processingState: state as OutreachProcessingState, duplicate: row.duplicate }
}

export async function ingestInboundReply(reply: NormalizedInboundReply): Promise<InboundIngestResult> {
  const result = await createServiceClient().rpc('mahshar_admin_outreach_ingest_inbound', {
    p_provider_message_id: reply.providerMessageId, p_in_reply_to: reply.inReplyTo,
    p_reference_ids: reply.references, p_sender_email: reply.senderEmail, p_recipient_email: reply.recipientEmail,
    p_subject: reply.subject, p_body: reply.body, p_received_at: reply.receivedAt,
  }) as DbResult
  if (result.error) rpcFailure(result.error)
  return inboundResult(result.data)
}

export async function getInboundReplyContext(messageId: string): Promise<{
  provider: string; product: string; inboundSubject: string; inboundBody: string; threadStatus: string
  history: Array<{ direction: 'inbound' | 'outbound'; subject: string; body: string }>
}> {
  const db = createServiceClient()
  const inboundResult = await db.from('admin_outreach_messages').select('thread_id,subject,body')
    .eq('id', messageId).eq('direction', 'inbound').single() as DbResult
  if (inboundResult.error) rpcFailure(inboundResult.error)
  const inbound = inboundResult.data as Record<string, unknown>
  if (typeof inbound.thread_id !== 'string' || typeof inbound.subject !== 'string' || typeof inbound.body !== 'string') {
    throw new Error('admin_outreach_inbound_context_invalid')
  }
  const threadResult = await db.from('admin_outreach_threads').select('id,provider_id,lead_id,status')
    .eq('id', inbound.thread_id).single() as DbResult
  if (threadResult.error) rpcFailure(threadResult.error)
  const thread = threadResult.data as Record<string, unknown>
  if (typeof thread.provider_id !== 'string' || typeof thread.lead_id !== 'string' || typeof thread.status !== 'string') {
    throw new Error('admin_outreach_inbound_context_invalid')
  }
  const [providerResult, leadResult, historyResult] = await Promise.all([
    db.from('worker_providers').select('canonical_name').eq('id', thread.provider_id).single(),
    db.from('worker_leads').select('product_id').eq('id', thread.lead_id).single(),
    db.from('admin_outreach_messages').select('direction,subject,body,created_at').eq('thread_id', inbound.thread_id)
      .in('status', ['sent','received']).order('created_at', { ascending: true }).limit(20),
  ]) as [DbResult, DbResult, DbResult]
  if (providerResult.error) rpcFailure(providerResult.error)
  if (leadResult.error) rpcFailure(leadResult.error)
  if (historyResult.error) rpcFailure(historyResult.error)
  const provider = providerResult.data as Record<string, unknown>
  const lead = leadResult.data as Record<string, unknown>
  if (typeof provider.canonical_name !== 'string' || typeof lead.product_id !== 'string') {
    throw new Error('admin_outreach_inbound_context_invalid')
  }
  const productResult = await db.from('worker_products').select('display_name').eq('id', lead.product_id).single() as DbResult
  if (productResult.error) rpcFailure(productResult.error)
  const product = productResult.data as Record<string, unknown>
  if (typeof product.display_name !== 'string') throw new Error('admin_outreach_inbound_context_invalid')
  const history = rows(historyResult.data).flatMap(row =>
    ['inbound','outbound'].includes(String(row.direction)) && typeof row.subject === 'string' && typeof row.body === 'string'
      ? [{ direction: row.direction as 'inbound' | 'outbound', subject: row.subject, body: row.body }] : [])
  return { provider: provider.canonical_name, product: product.display_name, inboundSubject: inbound.subject,
    inboundBody: inbound.body, threadStatus: thread.status, history }
}

export async function finalizeInboundReply(messageId: string, classification: ReplyClassification,
  processingState: 'classified' | 'suggested' | 'suggestion_failed', suggestion: SuggestedReply | null): Promise<unknown> {
  const result = await createServiceClient().rpc('mahshar_admin_outreach_finalize_inbound', {
    p_message_id: messageId, p_classification: classification.classification,
    p_confidence: classification.confidence, p_reason: classification.reason, p_processing_state: processingState,
    p_suggested_subject: suggestion?.subject ?? null, p_suggested_body: suggestion?.body ?? null,
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
