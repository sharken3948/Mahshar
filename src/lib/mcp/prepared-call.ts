import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { AgentListing } from './discovery-client'

const PURPOSE = 'mahshar-mcp-prepared-call-v1'
export const PREPARED_CALL_TTL_SECONDS = 10 * 60
const MAX_TOKEN_BYTES = 1024

export type PreparedCall = {
  api_id: string
  buyer_wallet: string
  path_values: Record<string, string>
  query_values: Record<string, string>
  body_present: boolean
  body?: unknown
}
type PreparedCallClaims = {
  v: 1
  exp: number
  call: string
  listing: string
}

export type PreparedCallVerification =
  | { ok: true }
  | { ok: false; code: 'prepared_call_invalid' | 'prepared_call_expired' | 'prepared_call_mismatch' | 'listing_contract_changed' }

function secret() {
  const value = process.env.ENCRYPTION_KEY
  if (!value || !/^[\da-f]{64}$/i.test(value)) throw new Error('prepared_call_key_unavailable')
  return createHmac('sha256', Buffer.from(value, 'hex')).update(PURPOSE).digest()
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function digest(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('base64url')
}

function listingContract(listing: AgentListing) {
  return {
    id: listing.id,
    method: listing.method,
    proxy_url: listing.proxy_url,
    proxy_style: listing.proxy_style,
    request: listing.request,
  }
}

function callContract(call: PreparedCall) {
  return {
    api_id: call.api_id,
    buyer_wallet: call.buyer_wallet,
    path_values: call.path_values,
    query_values: call.query_values,
    body_present: call.body_present,
    body_hash: call.body_present ? digest(call.body) : null,
  }
}

function sign(payload: string) {
  return createHmac('sha256', secret()).update(payload).digest()
}

export function issuePreparedCallToken(call: PreparedCall, listing: AgentListing, nowSeconds = Math.floor(Date.now() / 1000)) {
  const claims: PreparedCallClaims = {
    v: 1,
    exp: nowSeconds + PREPARED_CALL_TTL_SECONDS,
    call: digest(callContract(call)),
    listing: digest(listingContract(listing)),
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(payload).toString('base64url')}`
}

export function verifyPreparedCallToken(
  token: string,
  call: PreparedCall,
  listing: AgentListing,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreparedCallVerification {
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) return { ok: false, code: 'prepared_call_invalid' }
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, code: 'prepared_call_invalid' }

  let supplied: Buffer
  try { supplied = Buffer.from(parts[1], 'base64url') } catch { return { ok: false, code: 'prepared_call_invalid' } }
  const expected = sign(parts[0])
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, code: 'prepared_call_invalid' }
  }

  let claims: Partial<PreparedCallClaims>
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Partial<PreparedCallClaims> }
  catch { return { ok: false, code: 'prepared_call_invalid' } }
  if (claims.v !== 1 || !Number.isSafeInteger(claims.exp) || typeof claims.call !== 'string' || typeof claims.listing !== 'string') {
    return { ok: false, code: 'prepared_call_invalid' }
  }
  if ((claims.exp as number) <= nowSeconds) return { ok: false, code: 'prepared_call_expired' }
  if (claims.call !== digest(callContract(call))) return { ok: false, code: 'prepared_call_mismatch' }
  if (claims.listing !== digest(listingContract(listing))) return { ok: false, code: 'listing_contract_changed' }
  return { ok: true }
}
