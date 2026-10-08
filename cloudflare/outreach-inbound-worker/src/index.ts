import PostalMime, { type Address, type Email } from 'postal-mime'

const SUPPORT_EMAIL = 'support@mahshar.xyz'
const INBOUND_PATH = '/api/internal/outreach/inbound'
const MAX_RAW_BYTES = 2 * 1024 * 1024
const MAX_BODY_CHARS = 5000
const MAX_SUBJECT_CHARS = 200
const MAX_IDENTIFIER_CHARS = 512
const MAX_REFERENCES = 12
const MIN_SECRET_CHARS = 32
const OUTREACH_EMAIL = /^[a-z0-9](?:[a-z0-9.!#$%&*+/?^_`{|}~-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

export type WorkerEnv = {
  OUTREACH_FORWARD_TO?: string
  OUTREACH_INBOUND_ENDPOINT?: string
  OUTREACH_INBOUND_WEBHOOK_SECRET?: string
}

export type ForwardableEmailMessage = {
  from: string
  to: string
  raw: ReadableStream<Uint8Array>
  rawSize: number
  forward: (recipient: string) => Promise<void>
}

export type WorkerExecutionContext = {
  waitUntil: (promise: Promise<unknown>) => void
}

export type NormalizedInboundPayload = {
  message_id: string
  in_reply_to: string | null
  references: string[]
  sender_email: string
  recipient_email: typeof SUPPORT_EMAIL
  subject: string
  text: string
  received_at: string
}

type SafeLogger = {
  error: (event: string, details?: Record<string, string | number>) => void
}

type Dependencies = {
  fetch: typeof fetch
  now: () => Date
  logger: SafeLogger
}

const defaultDependencies: Dependencies = {
  fetch,
  now: () => new Date(),
  logger: {
    error: (event, details) => console.error(`[outreach-inbound-worker] ${event}`, details ?? {}),
  },
}

function compact(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n')
    .trim().slice(0, max)
}

function normalizeIdentifier(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.replace(/[\r\n]/g, '').trim()
  return normalized.length >= 1 && normalized.length <= MAX_IDENTIFIER_CHARS ? normalized : null
}

export function extractIdentifiers(value: string | undefined, limit = MAX_REFERENCES): string[] {
  if (!value) return []
  const bracketed = value.match(/<[^<>\r\n]{1,510}>/g)
  const candidates = bracketed?.length ? bracketed : value.split(/\s+/)
  return [...new Set(candidates.map(candidate => normalizeIdentifier(candidate)).filter((item): item is string => Boolean(item)))]
    .slice(0, limit)
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const hexadecimal = name[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint) : entity
    }
    return named[name.toLowerCase()] ?? entity
  })
}

export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<([a-z][a-z0-9:-]*)\b(?=[^>]*(?:\shidden(?:\s*=\s*(?:"hidden"|'hidden'|hidden))?(?:\s|\/?>)|\saria-hidden\s*=\s*(?:"true"|'true'|true)|\sstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)[^']*')))[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|blockquote|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' '))
}

export function cleanReplyBody(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const marker = lines.findIndex((line, index) => index > 0 && (
    /^\s*On .+ wrote:\s*$/i.test(line)
    || /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line)
    || /^\s*_{5,}\s*$/.test(line)
    || /^\s*>/.test(line)
    || /^\s*--\s*$/.test(line)
  ))
  return compact((marker >= 0 ? lines.slice(0, marker) : lines).join('\n'), MAX_BODY_CHARS)
}

function mailboxAddress(address: Address | undefined): string | null {
  if (!address || !('address' in address) || typeof address.address !== 'string') return null
  const normalized = address.address.trim().toLowerCase()
  return normalized.length <= 254 && OUTREACH_EMAIL.test(normalized) ? normalized : null
}

function parsedTimestamp(email: Email, fallback: Date): string {
  const candidate = typeof email.date === 'string' && email.date.length <= 64 ? Date.parse(email.date) : Number.NaN
  return new Date(Number.isFinite(candidate) ? candidate : fallback.getTime()).toISOString()
}

export function normalizeParsedEmail(email: Email, now: Date): NormalizedInboundPayload | null {
  const messageId = normalizeIdentifier(email.messageId)
  const senderEmail = mailboxAddress(email.from)
  const subject = compact(email.subject ?? '', MAX_SUBJECT_CHARS)
  const sourceBody = email.text?.trim() ? email.text : email.html ? htmlToPlainText(email.html) : ''
  const text = cleanReplyBody(sourceBody)
  if (!messageId || !senderEmail || !subject || !text) return null
  return {
    message_id: messageId,
    in_reply_to: extractIdentifiers(email.inReplyTo, 1)[0] ?? null,
    references: extractIdentifiers(email.references),
    sender_email: senderEmail,
    recipient_email: SUPPORT_EMAIL,
    subject,
    text,
    received_at: parsedTimestamp(email, now),
  }
}

function configuredForwardDestination(env: WorkerEnv): string {
  const destination = env.OUTREACH_FORWARD_TO?.trim()
  if (!destination || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
    throw new Error('forward_destination_not_configured')
  }
  return destination
}

function configuredWebhookSecret(env: WorkerEnv): string {
  const secret = env.OUTREACH_INBOUND_WEBHOOK_SECRET?.trim()
  if (!secret || secret.length < MIN_SECRET_CHARS) throw new Error('webhook_secret_not_configured')
  return secret
}

function configuredWebhookEndpoint(env: WorkerEnv): string {
  try {
    const endpoint = new URL(env.OUTREACH_INBOUND_ENDPOINT ?? '')
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash
      || endpoint.pathname !== INBOUND_PATH || endpoint.search) throw new Error('invalid')
    return endpoint.toString()
  } catch {
    throw new Error('webhook_endpoint_not_configured')
  }
}

async function parsePayload(message: ForwardableEmailMessage, now: Date): Promise<NormalizedInboundPayload | null> {
  if (!Number.isFinite(message.rawSize) || message.rawSize <= 0 || message.rawSize > MAX_RAW_BYTES) return null
  const parsed = await PostalMime.parse(message.raw, {
    maxHeadersSize: 64 * 1024,
    maxNestingDepth: 20,
    forceRfc822Attachments: true,
  })
  return normalizeParsedEmail(parsed, now)
}

async function postToMahshar(endpoint: string, payload: NormalizedInboundPayload, secret: string,
  dependencies: Dependencies): Promise<void> {
  try {
    const response = await dependencies.fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) dependencies.logger.error('webhook_failed', { status: response.status })
  } catch {
    dependencies.logger.error('webhook_failed', { status: 0 })
  }
}

export function createWorker(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides }
  return {
    async email(message: ForwardableEmailMessage, env: WorkerEnv,
      context: WorkerExecutionContext): Promise<void> {
      if (message.to.trim().toLowerCase() !== SUPPORT_EMAIL) {
        dependencies.logger.error('unexpected_recipient')
        throw new Error('unexpected_recipient')
      }

      const destination = configuredForwardDestination(env)
      try {
        await message.forward(destination)
      } catch {
        dependencies.logger.error('forward_failed')
        throw new Error('forward_failed')
      }

      let secret: string
      let endpoint: string
      try {
        secret = configuredWebhookSecret(env)
        endpoint = configuredWebhookEndpoint(env)
      } catch {
        dependencies.logger.error('webhook_not_configured')
        return
      }

      let payload: NormalizedInboundPayload | null = null
      try {
        payload = await parsePayload(message, dependencies.now())
        if (!payload) dependencies.logger.error('message_not_ingested', { code: 'invalid_or_oversized' })
      } catch {
        dependencies.logger.error('message_not_ingested', { code: 'parse_failed' })
      }
      if (!payload) return
      context.waitUntil(postToMahshar(endpoint, payload, secret, dependencies))
    },
  }
}

export default createWorker()
