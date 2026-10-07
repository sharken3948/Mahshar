import 'server-only'
import { createHash } from 'node:crypto'

const CONTACT_CLAIM_KEY_MAX_LENGTH = 120
const CONTACT_CLAIM_KEY_PATTERN = /^[a-z0-9:_-]{1,120}$/
const CONTACT_SCOPE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTACT_CLAIM_SCOPES = new Set(['candidate', 'enrich'])
const CONTACT_CLAIM_OPERATIONS = new Set(['page', 'search', 'verify'])
export const CONTACT_CLAIM_FINGERPRINT_LENGTH = 24

export type ContactClaimScope = 'candidate' | 'enrich'
export type ContactClaimOperation = 'page' | 'search' | 'verify'

export type ContactClaimDescriptor = {
  operation: ContactClaimOperation
  value: string
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, CONTACT_CLAIM_FINGERPRINT_LENGTH)
}

export function contactClaimKeySegment(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('worker_contact_claim_value_invalid')
  if (!Number.isInteger(maxLength) || maxLength <= CONTACT_CLAIM_FINGERPRINT_LENGTH + 1) {
    throw new Error('worker_contact_claim_segment_length_invalid')
  }
  const canonical = value.normalize('NFC')
  const readable = canonical.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const readableLength = maxLength - CONTACT_CLAIM_FINGERPRINT_LENGTH - 1
  const prefix = (readable || 'v').slice(0, readableLength).replace(/-+$/g, '') || 'v'
  return `${prefix}-${fingerprint(canonical)}`
}

export function canonicalContactClaimValue(operation: ContactClaimOperation, value: string): string {
  if (!CONTACT_CLAIM_OPERATIONS.has(operation)) throw new Error('worker_contact_claim_operation_invalid')
  if (typeof value !== 'string') throw new Error('worker_contact_claim_value_invalid')
  const canonical = value.normalize('NFC')
  if (operation === 'search') return canonical
  try {
    const url = new URL(canonical)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ''
    return url.toString()
  } catch {
    throw new Error('worker_contact_claim_url_invalid')
  }
}

export function buildContactClaimKey(input: ContactClaimDescriptor & {
  scope: ContactClaimScope
  scopeId: string
}): string {
  if (!input || typeof input !== 'object' || !CONTACT_CLAIM_SCOPES.has(input.scope)) {
    throw new Error('worker_contact_claim_scope_invalid')
  }
  if (!CONTACT_CLAIM_OPERATIONS.has(input.operation)) throw new Error('worker_contact_claim_operation_invalid')
  if (typeof input.scopeId !== 'string' || !CONTACT_SCOPE_ID_PATTERN.test(input.scopeId)) {
    throw new Error('worker_contact_claim_scope_id_invalid')
  }
  const scopeId = input.scopeId.toLowerCase()
  const prefix = `${input.scope}:${scopeId}:${input.operation}`
  const available = CONTACT_CLAIM_KEY_MAX_LENGTH - prefix.length - 1
  const value = canonicalContactClaimValue(input.operation, input.value)
  const key = `${prefix}:${contactClaimKeySegment(value, available)}`
  if (!CONTACT_CLAIM_KEY_PATTERN.test(key)) throw new Error('worker_contact_claim_key_invalid')
  return key
}
