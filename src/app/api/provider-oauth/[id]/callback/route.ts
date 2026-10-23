import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { encryptKey, decryptKey } from '@/lib/crypto'
import { requireWalletSession, marketplaceOrigin, sessionTokenHash } from '@/lib/marketplace/server'
import { WALLET_SESSION_COOKIE } from '@/lib/marketplace/session-auth'
import { listingOAuth, oauthHash, requestOAuthTokens, revokeOAuthTokens } from '@/lib/marketplace/provider-oauth'
import { credentialString } from '@/lib/marketplace/provider-auth-config'
import { enforceRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Callback is a cross-site top-level GET. Validate the session, one-time state,
  // and HttpOnly browser binding instead of requiring an Origin header here.
  const url = new URL(request.url), state = url.searchParams.get('state') ?? ''
  const stateHash = oauthHash(state), cookie = `mahshar_oauth_${stateHash.slice(0, 20)}`
  let returnPath = '/dashboard'
  const result = (ok: boolean) => {
    const response = NextResponse.redirect(`${marketplaceOrigin()}${returnPath}?provider_oauth=${ok ? 'connected' : 'failed'}`, 303)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.cookies.set(cookie, '', { httpOnly: true, secure: marketplaceOrigin().startsWith('https:'),
      sameSite: 'lax', path: `/api/provider-oauth/${id}/callback`, maxAge: 0 })
    return response
  }
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return result(false)
    const wallet = await requireWalletSession(request)
    const limited = await enforceRateLimit({ request, scope: 'provider-oauth-callback', limit: 12, windowSeconds: 60,
      wallet, dimensions: [id], failClosed: true })
    if (limited) return result(false)
    const browser = request.cookies.get(cookie)?.value
    if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return result(false)
    const db = createServiceClient()
    const { data: rows, error } = await db.from('provider_oauth_states').update({ used_at: new Date().toISOString() })
      .eq('state_hash', stateHash).eq('api_id', id).eq('owner_wallet', wallet)
      .eq('session_hash', sessionTokenHash(request.cookies.get(WALLET_SESSION_COOKIE)!.value))
      .eq('browser_hash', oauthHash(browser)).is('used_at', null).gt('expires_at', new Date().toISOString()).select('*')
    const pending = rows?.[0]
    if (error || !pending) return result(false)
    if (pending.account_mode === 'buyer') returnPath = `/provider-connections/${id}`
    if (url.searchParams.has('error')) return result(false)
    const code = credentialString(url.searchParams.get('code'), 4096)
    const { data: listing, error: listingError } = await db.from('api_listings').select('*').eq('id', id).maybeSingle()
    if (listingError || !listing || listing.auth_type !== 'oauth_pkce') return result(false)
    const { config, profile, hash } = listingOAuth(listing)
    if (hash !== pending.config_hash || config.account_mode !== pending.account_mode ||
      (config.account_mode === 'seller' && listing.seller_wallet.toLowerCase() !== wallet)) return result(false)
    const verifier = decryptKey(pending.encrypted_verifier)
    if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) return result(false)
    const tokens = await requestOAuthTokens(profile, config, { grant_type: 'authorization_code', code,
      code_verifier: verifier, redirect_uri: `${marketplaceOrigin()}/api/provider-oauth/${id}/callback` })
    const { data: completed, error: completeError } = await db.rpc('mahshar_oauth_complete', {
      p_state: stateHash, p_ciphertext: listing.encrypted_key, p_tokens: encryptKey(JSON.stringify(tokens)),
      p_expires: new Date(tokens.expires_at).toISOString() })
    if (completeError || completed !== true) {
      await revokeOAuthTokens(profile, config, encryptKey(JSON.stringify(tokens)))
      return result(false)
    }
    return result(true)
  } catch { return result(false) }
}
