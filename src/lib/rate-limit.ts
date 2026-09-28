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

export async function enforceRateLimit(input: {
  request: NextRequest
  scope: string
  limit: number
  windowSeconds: number
  dimensions?: string[]
  failClosed?: boolean
  /** Deterministic test seam; production always uses the service client. */
  database?: RateLimitDatabase
}): Promise<NextResponse | null> {
  try {
    const hasTrustedIp = trustedClientDimension(input.request) !== 'ip:unavailable'
    const effectiveLimit = hasTrustedIp || (input.dimensions?.length ?? 0) > 0
      ? input.limit : Math.min(10000, input.limit * 10)
    const { data, error } = await (input.database ?? createServiceClient()).rpc('mahshar_take_rate_limit', {
      p_key_hash: rateLimitIdentity(input.request, input.scope, input.dimensions),
      p_limit: effectiveLimit,
      p_window_seconds: input.windowSeconds,
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
  } catch {
    return input.failClosed
      ? NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      : null
  }
}
