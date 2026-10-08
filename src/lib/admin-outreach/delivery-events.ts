import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isVerifiedOutreachEmail } from '@/lib/admin-worker/contact-readiness'
import { ingestOutreachDeliveryEvent, type DeliveryEventIngestResult } from './repository'
import { outreachDeliveryEventTypes, type OutreachDeliveryEventType } from './types'

const MAX_WEBHOOK_BYTES = 32 * 1024
const MIN_SECRET_LENGTH = 32
const MAX_SECRET_LENGTH = 256

const brevoEventMapping: Record<string, OutreachDeliveryEventType | undefined> = {
  request: 'sent',
  delivered: 'delivered',
  opened: 'opened',
  unique_opened: 'opened',
  soft_bounce: 'soft_bounce',
  hard_bounce: 'hard_bounce',
  blocked: 'blocked',
}

export type NormalizedBrevoDeliveryEvent = {
  providerMessageId: string
  recipientEmail: string
  eventType: OutreachDeliveryEventType
  providerEventId: string
  occurredAt: string
}

function identifier(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replace(/[\r\n]/g, '').trim()
  return compact.length >= 1 && compact.length <= max ? compact : null
}

export function parseBrevoDeliveryEvent(value: unknown): NormalizedBrevoDeliveryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('admin_outreach_delivery_event_invalid')
  }
  const input = value as Record<string, unknown>
  const eventType = typeof input.event === 'string' ? brevoEventMapping[input.event] : undefined
  const providerMessageId = identifier(input['message-id'], 512)
  const recipientEmail = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const providerEventId = Number.isSafeInteger(input.id) && Number(input.id) >= 0 ? String(input.id) : null
  const eventSeconds = input.ts_event
  const occurredAt = typeof eventSeconds === 'number' && Number.isSafeInteger(eventSeconds) && eventSeconds >= 1577836800
    && eventSeconds <= Math.floor(Date.now() / 1000) + 86_400
    ? new Date(eventSeconds * 1000).toISOString() : null
  if (!eventType || !outreachDeliveryEventTypes.includes(eventType) || !providerMessageId
    || !isVerifiedOutreachEmail(recipientEmail) || !providerEventId || !occurredAt) {
    throw new Error('admin_outreach_delivery_event_invalid')
  }
  return { providerMessageId, recipientEmail, eventType, providerEventId, occurredAt }
}

export function brevoDeliveryWebhookConfigured(): boolean {
  const secret = process.env.BREVO_OUTREACH_WEBHOOK_SECRET?.trim()
  return Boolean(secret && secret.length >= MIN_SECRET_LENGTH && secret.length <= MAX_SECRET_LENGTH)
}

export function authenticateBrevoDeliveryWebhook(request: Request): boolean {
  const secret = process.env.BREVO_OUTREACH_WEBHOOK_SECRET?.trim()
  const header = request.headers.get('authorization')
  if (!secret || secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH
    || !header?.startsWith('Bearer ')) return false
  const suppliedToken = header.slice(7)
  if (suppliedToken.length < MIN_SECRET_LENGTH || suppliedToken.length > MAX_SECRET_LENGTH) return false
  const expected = createHash('sha256').update(secret).digest()
  const supplied = createHash('sha256').update(suppliedToken).digest()
  return timingSafeEqual(expected, supplied)
}

export async function readBoundedBrevoJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    throw new Error('admin_outreach_delivery_event_too_large')
  }
  if (!request.body) throw new Error('admin_outreach_delivery_event_invalid')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    size += chunk.byteLength
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel()
      throw new Error('admin_outreach_delivery_event_too_large')
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('admin_outreach_delivery_event_invalid') }
}

type DeliveryEventDependencies = {
  ingest: (event: NormalizedBrevoDeliveryEvent) => Promise<DeliveryEventIngestResult>
}

const deliveryEventDependencies: DeliveryEventDependencies = { ingest: ingestOutreachDeliveryEvent }

export async function processBrevoDeliveryEvent(event: NormalizedBrevoDeliveryEvent,
  dependencies: DeliveryEventDependencies = deliveryEventDependencies): Promise<DeliveryEventIngestResult> {
  return dependencies.ingest(event)
}

type HandlerDependencies = { process: typeof processBrevoDeliveryEvent }
const handlerDependencies: HandlerDependencies = { process: processBrevoDeliveryEvent }

export async function handleBrevoDeliveryWebhook(request: Request,
  dependencies: HandlerDependencies = handlerDependencies) {
  if (!brevoDeliveryWebhookConfigured()) {
    return Response.json({ error: 'brevo_webhook_not_configured' }, { status: 503 })
  }
  if (!authenticateBrevoDeliveryWebhook(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  try {
    const event = parseBrevoDeliveryEvent(await readBoundedBrevoJson(request))
    const result = await dependencies.process(event)
    return Response.json({ accepted: true, matched: result.matched, duplicate: result.duplicate })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'admin_outreach_delivery_event_unavailable'
    if (message === 'admin_outreach_delivery_event_too_large') {
      return Response.json({ error: 'payload_too_large' }, { status: 413 })
    }
    if (message === 'admin_outreach_delivery_event_invalid') {
      return Response.json({ error: 'invalid_payload' }, { status: 400 })
    }
    console.error('[admin-outreach] Brevo delivery event unavailable', message)
    return Response.json({ error: 'delivery_event_unavailable' }, { status: 429, headers: { 'Retry-After': '600' } })
  }
}
