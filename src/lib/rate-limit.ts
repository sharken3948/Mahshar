import 'server-only'
import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

type RateLimitResult = { allowed: boolean; remaining: number; retry_after_seconds: number }
type RateLimitDatabase = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> }

function trustedClientDimension(request: NextRequest): string {
  // Vercel owns this header at the deployment boundary. Outside Vercel we do
  // not trust generic X-Forwarded-For supplied by an arbitrary direct client.
  const configured = process.env.MAHSHAR_TRUSTED_CLIENT_IP_HEADER?.toLowerCase()
  const permitted = new Set(['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'])
  const header = process.env.VERCEL === '1' ? 'x-vercel-forwarded-for' : configured && permitted.has(configured) ? configured : null
  if (header) {
    const forwarded = request.headers.get(header)
    const ip = forwarded?.split(',')[0]?.trim()
    if (ip && /^[\da-f:.]{3,64}$/i.test(ip)) return `ip:${ip}`
  }
  return 'ip:unavailable'
}

export function rateLimitIdentity(request: NextRequest, scope: string, dimensions: string[] = []) {
  const value = ['mahshar-rate-v1', scope, trustedClientDimension(request), ...dimensions].join('|')
  return createHash('sha256').update(value).digest('hex')
}

function hashIdentity(scope: string, identity: string, dimensions: string[] = []) {
  return createHash('sha256').update(['mahshar-rate-v2', scope, identity, ...dimensions].join('|')).digest('hex')
}

export function rateLimitIdentities(request: NextRequest, scope: string, wallet?: string, dimensions: string[] = []) {
  const ip = trustedClientDimension(request)
  const identities: Array<{ kind: 'wallet' | 'ip'; keyHash: string }> = []
  if (wallet !== undefined) {
    const normalized = wallet.trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new Error('Invalid rate-limit wallet')
    identities.push({ kind: 'wallet', keyHash: hashIdentity(scope, `wallet:${normalized}`) })
  }
  if (ip !== 'ip:unavailable' || wallet === undefined) {
    identities.push({ kind: 'ip', keyHash: hashIdentity(scope, ip, dimensions) })
  }
  return identities
}

export async function enforceRateLimit(input: {
  request: NextRequest
  scope: string
  limit: number
  windowSeconds: number
  dimensions?: string[]
  wallet?: string
  failClosed?: boolean
  /** Deterministic test seam; production always uses the service client. */
  database?: RateLimitDatabase
}): Promise<NextResponse | null> {
  try {
    const identities = rateLimitIdentities(input.request, input.scope, input.wallet, input.dimensions)
    const hasTrustedIp = trustedClientDimension(input.request) !== 'ip:unavailable'
    const effectiveLimit = hasTrustedIp || input.wallet !== undefined || (input.dimensions?.length ?? 0) > 0
      ? input.limit : Math.min(10000, input.limit * 10)
    const database = input.database ?? createServiceClient()
    const { data, error } = identities.length === 1
      ? await database.rpc('mahshar_take_rate_limit', {
        p_key_hash: identities[0].keyHash,
        p_limit: effectiveLimit,
        p_window_seconds: input.windowSeconds,
      })
      : await database.rpc('mahshar_take_rate_limits', {
        p_buckets: identities.map(identity => ({
          key_hash: identity.keyHash,
          limit: effectiveLimit,
          window_seconds: input.windowSeconds,
        })),
      })
    if (error) throw error
    const result = (Array.isArray(data) ? data[0] : data) as RateLimitResult | null
    if (!result || result.allowed !== true) {
      const retry = Math.max(1, result?.retry_after_seconds ?? input.windowSeconds)
      return NextResponse.json({ error: 'rate_limited', retry_after_seconds: retry }, {
        status: 429,
        headers: { 'Retry-After': String(retry), 'Cache-Control': 'no-store' },
      })
    }
    return null
  } catch (error) {
    console.error('[rate-limit] backend unavailable', {
      scope: input.scope,
      policy: input.failClosed ? 'fail-closed' : 'fail-open',
      error: error instanceof Error ? error.message : String(error),
    })
    return input.failClosed
      ? NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      : null
  }
}
