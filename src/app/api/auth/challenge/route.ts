import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { enforceRateLimit } from '@/lib/rate-limit'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { assertSessionMutationOrigin, marketplaceErrors, marketplaceOrigin, sessionTokenHash } from '@/lib/marketplace/server'
import { LOGIN_CHALLENGE_SECONDS } from '@/lib/marketplace/session-auth'

export const runtime = 'nodejs'

export const POST = marketplaceErrors(async (request: NextRequest) => {
  assertSessionMutationOrigin(request)
  const limited = await enforceRateLimit({ request, scope: 'wallet-login-challenge', limit: 10,
    windowSeconds: 60, failClosed: true })
  if (limited) return limited
  let body: { wallet?: unknown }
  try { body = await readBoundedJson(request, 4 * 1024) }
  catch (error) {
    const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
    return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' }, { status: tooLarge ? 413 : 400 })
  }
  const wallet = normalizedWallet(body.wallet)
  const issuedAt = Math.floor(Date.now() / 1000)
  const deadline = issuedAt + LOGIN_CHALLENGE_SECONDS
  const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`
  const { data, error } = await createServiceClient().from('wallet_auth_challenges').insert({
    wallet, nonce_hash: sessionTokenHash(nonce),
    issued_at: new Date(issuedAt * 1000).toISOString(),
    expires_at: new Date(deadline * 1000).toISOString(),
  }).select('id').single()
  if (error || !data?.id) return NextResponse.json({ error: 'login_challenge_unavailable' }, { status: 503 })
  return NextResponse.json({ challenge_id: data.id, wallet, nonce, issued_at: issuedAt, deadline,
    origin: marketplaceOrigin() }, { headers: { 'Cache-Control': 'no-store' } })
})
