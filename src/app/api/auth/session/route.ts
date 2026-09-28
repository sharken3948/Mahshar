import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, verifyTypedData, type Hex } from 'viem'
import { arcMainnet } from '@/lib/chains'
import { createServiceClient } from '@/lib/supabase/server'
import { enforceRateLimit } from '@/lib/rate-limit'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { MarketplaceError, normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { assertSessionMutationOrigin, marketplaceErrors, marketplaceOrigin, requireWalletSession,
  sessionTokenHash } from '@/lib/marketplace/server'
import { LOGIN_AUTH_DOMAIN, LOGIN_AUTH_TYPES, LOGIN_CHALLENGE_SECONDS, loginMessage, WALLET_SESSION_COOKIE,
  WALLET_SESSION_SECONDS } from '@/lib/marketplace/session-auth'

export const runtime = 'nodejs'

function cookieOptions(expires: Date) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const,
    path: '/', priority: 'high' as const, maxAge: WALLET_SESSION_SECONDS, expires }
}

export const GET = marketplaceErrors(async (request: NextRequest) => {
  const wallet = await requireWalletSession(request)
  const claimed = request.nextUrl.searchParams.get('wallet')
  if (claimed && normalizedWallet(claimed) !== wallet) throw new MarketplaceError('Wallet session does not match', 403)
  const token = request.cookies.get(WALLET_SESSION_COOKIE)!.value
  const { data, error } = await createServiceClient().from('wallet_sessions').select('expires_at')
    .eq('token_hash', sessionTokenHash(token)).maybeSingle()
  if (error || !data) throw new MarketplaceError('Wallet session unavailable', 503)
  return NextResponse.json({ authenticated: true, wallet, expires_at: data.expires_at },
    { headers: { 'Cache-Control': 'no-store' } })
})

export const POST = marketplaceErrors(async (request: NextRequest) => {
  assertSessionMutationOrigin(request)
  const limited = await enforceRateLimit({ request, scope: 'wallet-login-verify', limit: 10,
    windowSeconds: 60, failClosed: true })
  if (limited) return limited
  let body: { challenge_id?: unknown; wallet?: unknown; nonce?: unknown; issued_at?: unknown;
    deadline?: unknown; signature?: unknown }
  try { body = await readBoundedJson(request, 16 * 1024) }
  catch (error) {
    const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
    return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' }, { status: tooLarge ? 413 : 400 })
  }
  const wallet = normalizedWallet(body.wallet)
  if (typeof body.challenge_id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(body.challenge_id)
    || typeof body.nonce !== 'string' || !/^0x[\da-f]{64}$/i.test(body.nonce)
    || !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.deadline)
    || typeof body.signature !== 'string' || !/^0x(?:[\da-f]{2}){64,8192}$/i.test(body.signature)) {
    return NextResponse.json({ error: 'invalid_login_proof' }, { status: 400 })
  }
  const now = Math.floor(Date.now() / 1000)
  if (Number(body.deadline) <= now || Number(body.issued_at) > now + 30
    || Number(body.deadline) - Number(body.issued_at) !== LOGIN_CHALLENGE_SECONDS) {
    return NextResponse.json({ error: 'login_challenge_expired' }, { status: 401 })
  }
  const db = createServiceClient()
  const { data: challenge, error: challengeError } = await db.from('wallet_auth_challenges')
    .select('id, wallet, nonce_hash, issued_at, expires_at, used_at').eq('id', body.challenge_id).maybeSingle()
  if (challengeError) return NextResponse.json({ error: 'login_challenge_unavailable' }, { status: 503 })
  const issuedAt = Math.floor(new Date(challenge?.issued_at ?? 0).getTime() / 1000)
  const deadline = Math.floor(new Date(challenge?.expires_at ?? 0).getTime() / 1000)
  if (!challenge || challenge.used_at || challenge.wallet !== wallet
    || challenge.nonce_hash !== sessionTokenHash(body.nonce)
    || issuedAt !== body.issued_at || deadline !== body.deadline || deadline <= now) {
    return NextResponse.json({ error: challenge?.used_at ? 'login_challenge_used' : 'invalid_login_challenge' }, { status: 401 })
  }
  const verification = {
    address: wallet, domain: LOGIN_AUTH_DOMAIN, types: LOGIN_AUTH_TYPES, primaryType: 'MahsharLogin' as const,
    message: loginMessage({ wallet, origin: marketplaceOrigin(), nonce: body.nonce as Hex,
      issuedAt: body.issued_at as number, deadline: body.deadline as number }),
    signature: body.signature as Hex,
  }
  let valid = await verifyTypedData(verification).catch(() => false)
  if (!valid) valid = await createPublicClient({ chain: arcMainnet,
    transport: http(process.env.ARC_MAINNET_RPC_URL, { timeout: 10_000, retryCount: 0 }) }).verifyTypedData(verification).catch(() => false)
  if (!valid) return NextResponse.json({ error: 'invalid_login_signature' }, { status: 401 })

  const { data: consumed, error: consumeError } = await db.from('wallet_auth_challenges')
    .update({ used_at: new Date().toISOString() }).eq('id', body.challenge_id).eq('wallet', wallet)
    .eq('nonce_hash', sessionTokenHash(body.nonce)).is('used_at', null)
    .gt('expires_at', new Date().toISOString()).select('id').maybeSingle()
  if (consumeError) return NextResponse.json({ error: 'login_challenge_unavailable' }, { status: 503 })
  if (!consumed) return NextResponse.json({ error: 'login_challenge_used' }, { status: 409 })

  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + WALLET_SESSION_SECONDS * 1000)
  const { error: sessionError } = await db.from('wallet_sessions').insert({
    token_hash: sessionTokenHash(token), wallet, expires_at: expires.toISOString(),
  })
  if (sessionError) return NextResponse.json({ error: 'wallet_session_unavailable' }, { status: 503 })
  const response = NextResponse.json({ authenticated: true, wallet, expires_at: expires.toISOString() })
  response.cookies.set(WALLET_SESSION_COOKIE, token, cookieOptions(expires))
  response.headers.set('Cache-Control', 'no-store')
  return response
})

export const DELETE = marketplaceErrors(async (request: NextRequest) => {
  assertSessionMutationOrigin(request)
  const token = request.cookies.get(WALLET_SESSION_COOKIE)?.value
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const { error } = await createServiceClient().from('wallet_sessions')
      .update({ revoked_at: new Date().toISOString() }).eq('token_hash', sessionTokenHash(token)).is('revoked_at', null)
    if (error) return NextResponse.json({ error: 'wallet_session_unavailable' }, { status: 503 })
  }
  const response = NextResponse.json({ authenticated: false })
  response.cookies.set(WALLET_SESSION_COOKIE, '', { ...cookieOptions(new Date(0)), maxAge: 0 })
  response.headers.set('Cache-Control', 'no-store')
  return response
})
