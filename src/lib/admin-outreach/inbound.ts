import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isVerifiedOutreachEmail } from '@/lib/admin-worker/contact-readiness'
import { classifyOutreachReply, suggestOutreachReply, type ReplyClassification, type ReplyContext,
  type SuggestedReply } from './intelligence'
import { finalizeInboundReply, getInboundReplyContext, ingestInboundReply,
  type InboundIngestResult } from './repository'

const MAX_WEBHOOK_BYTES = 64 * 1024
const SUPPORT_EMAIL = 'support@mahshar.xyz'

export type NormalizedInboundReply = {
  providerMessageId: string
  inReplyTo: string | null
  references: string[]
  senderEmail: string
  recipientEmail: typeof SUPPORT_EMAIL
  subject: string
  body: string
  receivedAt: string
}

function compact(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max)
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\r\n]/g, '').trim()
  return cleaned.length >= 1 && cleaned.length <= 512 ? cleaned : null
}

export function parseNormalizedInboundReply(value: unknown): NormalizedInboundReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('admin_outreach_inbound_invalid')
  const input = value as Record<string, unknown>
  const providerMessageId = identifier(input.message_id)
  const inReplyTo = input.in_reply_to === null || input.in_reply_to === undefined ? null : identifier(input.in_reply_to)
  const senderEmail = typeof input.sender_email === 'string' ? input.sender_email.trim().toLowerCase() : ''
  const recipientEmail = typeof input.recipient_email === 'string' ? input.recipient_email.trim().toLowerCase() : ''
  const subject = typeof input.subject === 'string' ? compact(input.subject, 200) : ''
  const body = typeof input.text === 'string' ? compact(input.text, 5000) : ''
  const receivedAt = typeof input.received_at === 'string' && input.received_at.length <= 64
    && Number.isFinite(Date.parse(input.received_at)) ? new Date(input.received_at).toISOString() : null
  if (!providerMessageId || (input.in_reply_to !== null && input.in_reply_to !== undefined && !inReplyTo)
    || !isVerifiedOutreachEmail(senderEmail) || recipientEmail !== SUPPORT_EMAIL
    || !subject || !body || !receivedAt) throw new Error('admin_outreach_inbound_invalid')
  if (!Array.isArray(input.references) || input.references.length > 12) throw new Error('admin_outreach_inbound_invalid')
  const references = [...new Set(input.references.map(identifier))]
  if (references.some(item => !item)) throw new Error('admin_outreach_inbound_invalid')
  return { providerMessageId, inReplyTo, references: references as string[], senderEmail,
    recipientEmail: SUPPORT_EMAIL, subject, body, receivedAt }
}

export async function readBoundedInboundJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) throw new Error('admin_outreach_inbound_too_large')
  if (!request.body) throw new Error('admin_outreach_inbound_invalid')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel()
      throw new Error('admin_outreach_inbound_too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('admin_outreach_inbound_invalid') }
}

export function inboundBridgeConfigured(): boolean {
  return (process.env.OUTREACH_INBOUND_WEBHOOK_SECRET?.trim().length ?? 0) >= 32
}

export function authenticateInboundBridge(request: Request): boolean {
  const secret = process.env.OUTREACH_INBOUND_WEBHOOK_SECRET?.trim()
  const header = request.headers.get('authorization')
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false
  const expected = createHash('sha256').update(secret).digest()
  const supplied = createHash('sha256').update(header.slice(7)).digest()
  return timingSafeEqual(expected, supplied)
}

type InboundContext = ReplyContext & { threadStatus: string }
type ProcessingDependencies = {
  ingest: (reply: NormalizedInboundReply) => Promise<InboundIngestResult>
  context: (messageId: string) => Promise<InboundContext>
  classify: (body: string) => Promise<ReplyClassification>
  suggest: (context: ReplyContext) => Promise<SuggestedReply | null>
  finalize: (messageId: string, classification: ReplyClassification,
    processingState: 'classified' | 'suggested' | 'suggestion_failed', suggestion: SuggestedReply | null) => Promise<unknown>
}

const processingDependencies: ProcessingDependencies = {
  ingest: ingestInboundReply,
  context: getInboundReplyContext,
  classify: classifyOutreachReply,
  suggest: suggestOutreachReply,
  finalize: finalizeInboundReply,
}

export async function processInboundReply(reply: NormalizedInboundReply,
  dependencies: ProcessingDependencies = processingDependencies): Promise<InboundIngestResult> {
  const ingested = await dependencies.ingest(reply)
  if (!ingested.threadId || ingested.processingState === 'unmatched') return ingested
  if (ingested.duplicate && !['received', 'suggestion_failed'].includes(ingested.processingState)) return ingested
  const context = await dependencies.context(ingested.id)
  const classification = await dependencies.classify(reply.body)
  const actionable = ['interested', 'payment_question', 'technical_question', 'other'].includes(classification.classification)
    && !['closed', 'do_not_contact', 'rejected'].includes(context.threadStatus)
  const suggestion = actionable ? await dependencies.suggest(context) : null
  const state = actionable ? suggestion ? 'suggested' : 'suggestion_failed' : 'classified'
  await dependencies.finalize(ingested.id, classification, state, suggestion)
  return { ...ingested, processingState: state }
}
