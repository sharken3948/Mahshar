import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
const PRUNE_LIMIT = 1000

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < 32) return false
  const supplied = request.headers.get('authorization')
  if (!supplied?.startsWith('Bearer ')) return false
  const candidate = Buffer.from(supplied.slice(7))
  const expected = Buffer.from(secret)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
    console.error('[response-prune] CRON_SECRET is missing or too short')
    return NextResponse.json({ error: 'maintenance_unavailable' }, { status: 503,
      headers: { 'Cache-Control': 'no-store' } })
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401,
      headers: { 'Cache-Control': 'no-store' } })
  }
  const db = createServiceClient()
  const { data, error } = await db.rpc('mahshar_prune_api_call_responses', { p_limit: PRUNE_LIMIT })
  if (error) {
    console.error(`[response-prune] RPC failed: ${error.message}`)
    return NextResponse.json({ error: 'prune_failed' }, { status: 503,
      headers: { 'Cache-Control': 'no-store' } })
  }
  const deleted = Number(data)
  if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > PRUNE_LIMIT) {
    console.error('[response-prune] RPC returned an invalid deletion count')
    return NextResponse.json({ error: 'prune_failed' }, { status: 503,
      headers: { 'Cache-Control': 'no-store' } })
  }
  const { data: authData, error: authError } = await db.rpc('mahshar_prune_wallet_auth', { p_limit: PRUNE_LIMIT })
  const authCounts = authData as { challenges?: unknown; sessions?: unknown } | null
  const challenges = Number(authCounts?.challenges)
  const sessions = Number(authCounts?.sessions)
  if (authError || !Number.isSafeInteger(challenges) || challenges < 0 || challenges > PRUNE_LIMIT
    || !Number.isSafeInteger(sessions) || sessions < 0 || sessions > PRUNE_LIMIT) {
    console.error(`[response-prune] wallet auth pruning failed: ${authError?.message ?? 'invalid count'}`)
    return NextResponse.json({ error: 'prune_failed' }, { status: 503,
      headers: { 'Cache-Control': 'no-store' } })
  }
  console.info(`[response-prune] cleared ${deleted} expired response bodies, ${challenges} challenges, and ${sessions} sessions`)
  return NextResponse.json({ ok: true, cleared_response_bodies: deleted,
    cleared_wallet_challenges: challenges, cleared_wallet_sessions: sessions, limit: PRUNE_LIMIT }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
