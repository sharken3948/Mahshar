import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { encryptKey, decryptKey } from '@/lib/crypto'
import { withWalletSession, marketplaceOrigin, sessionTokenHash, requireOperationAuthorizationForPayload } from '@/lib/marketplace/server'
import { readBoundedText, RequestBodyError } from '@/lib/request-body'
import { WALLET_SESSION_COOKIE } from '@/lib/marketplace/session-auth'
import { listingOAuth, oauthHash, oauthRandom, pkceChallenge, revokeOAuthTokens } from '@/lib/marketplace/provider-oauth'
import { oauthConfiguration } from '@/lib/marketplace/provider-auth-config'
import { MarketplaceError, assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { enforceRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }
async function ownedOAuthConfiguration(id: string, wallet: string, requireApproved = true, allowSellerStatus = false, allowInactive = false) {
  const db = createServiceClient()
  const { data: listing, error } = await db.from('api_listings').select('*').eq('id', id).maybeSingle()
  if (error || !listing) throw new MarketplaceError('Listing unavailable', 404)
  if (!['oauth_client_credentials', 'oauth_pkce'].includes(listing.auth_type)) throw new MarketplaceError('OAuth is not configured', 400)
  const config = oauthConfiguration(decryptKey(listing.encrypted_key))
  let approved: ReturnType<typeof listingOAuth> | undefined
  try { approved = listingOAuth(listing) } catch (error) { if (requireApproved) throw error }
  const oauth = { config, profile: approved?.profile, hash: approved?.hash }
  if (oauth.config.account_mode === 'seller' && listing.seller_wallet.toLowerCase() !== wallet && !allowSellerStatus) throw new MarketplaceError('Not account owner', 403)
  if (oauth.config.account_mode === 'buyer' && !allowInactive && !listing.is_active && listing.seller_wallet.toLowerCase() !== wallet) throw new MarketplaceError('Listing unavailable', 404)
  return { db, listing, ...oauth }
}

export const GET = withWalletSession(async (_request: NextRequest, wallet: string, { params }: Context) => {
  const { id } = await params
  const { db, listing, config, hash } = await ownedOAuthConfiguration(id, wallet, false, true, true)
  if (config.account_mode === 'seller' && listing.seller_wallet.toLowerCase() !== wallet) {
    return NextResponse.json({ account_mode: 'seller', status: 'managed_by_seller', expires_at: null })
  }
  if (!hash) return NextResponse.json({ account_mode: config.account_mode, status: 'configuration_unavailable', expires_at: null })
  const { data, error } = await db.from('provider_oauth_accounts').select('status, expires_at')
    .eq('api_id', id).eq('owner_wallet', wallet).eq('account_mode', config.account_mode).eq('config_hash', hash).maybeSingle()
  if (error) throw new MarketplaceError('OAuth status unavailable', 503)
  return NextResponse.json({ account_mode: config.account_mode, status: data?.status ?? 'not_connected', expires_at: data?.expires_at ?? null })
})

export const POST = withWalletSession(async (request: NextRequest, wallet: string, { params }: Context) => {
  const { id } = await params
  const limited = await enforceRateLimit({ request, scope: 'provider-oauth-connect', limit: 6, windowSeconds: 60,
    wallet, dimensions: [id], failClosed: true })
  if (limited) return limited
  const { db, listing, config, profile, hash: previousHash } = await ownedOAuthConfiguration(id, wallet)
  if (!profile || !previousHash) throw new MarketplaceError('OAuth profile unavailable', 503)
  let consentBody: string
  try { consentBody = await readBoundedText(request, 1024) }
  catch (error) {
    if (error instanceof RequestBodyError) throw new MarketplaceError('Invalid consent request body', error.code === 'body_too_large' ? 413 : 400)
    throw error
  }
  if (consentBody.trim() && consentBody.trim() !== '{}') throw new MarketplaceError('Consent accepts no custom parameters', 400)
  const operationWallet = await requireOperationAuthorizationForPayload(request, {})
  assertWalletClaim(operationWallet, wallet)
  let hash = previousHash
  if (config.account_mode === 'seller') {
    const { error: disconnectError } = await db.rpc('mahshar_oauth_disconnect', { p_api_id: id, p_wallet: wallet, p_mode: 'seller' })
    if (disconnectError) throw new MarketplaceError('OAuth connection unavailable', 503)
    // Re-encrypt the unchanged configuration with a new IV. Existing snapshot
    // guards then fence verification and dispatch from the former account too.
    const replacement = encryptKey(decryptKey(listing.encrypted_key))
    const { data: changed, error: changeError } = await db.from('api_listings')
      .update({ encrypted_key: replacement, is_active: false, verified_at: null }).eq('id', id)
      .eq('encrypted_key', listing.encrypted_key).ilike('seller_wallet', wallet).select('id')
    if (changeError || !changed?.length) throw new MarketplaceError('Listing changed; reload before connecting', 409)
    listing.encrypted_key = replacement
    hash = listingOAuth(listing).hash
  }
  if (listing.auth_type === 'oauth_client_credentials') {
    const { error } = await db.from('provider_oauth_accounts').delete().eq('api_id', id).eq('owner_wallet', wallet)
      .eq('account_mode', 'seller').eq('config_hash', previousHash)
    if (error) throw new MarketplaceError('OAuth connection unavailable', 503)
    return NextResponse.json({ enabled: true })
  }
  const state = oauthRandom(), browser = oauthRandom(), verifier = oauthRandom()
  const stateHash = oauthHash(state)
  const { error } = await db.from('provider_oauth_states').insert({ state_hash: stateHash, api_id: id,
    owner_wallet: wallet, account_mode: config.account_mode, config_hash: hash,
    session_hash: sessionTokenHash(request.cookies.get(WALLET_SESSION_COOKIE)!.value), browser_hash: oauthHash(browser),
    encrypted_verifier: encryptKey(verifier), expires_at: new Date(Date.now() + 5 * 60000).toISOString() })
  if (error) throw new MarketplaceError('OAuth consent unavailable', 503)
  const callback = `${marketplaceOrigin()}/api/provider-oauth/${id}/callback`
  const url = new URL(profile!.authorization_endpoint!)
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.client_id,
    redirect_uri: callback, state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
    ...(profile.scopes.length ? { scope: profile.scopes.join(' ') } : {}) })) url.searchParams.set(key, value)
  const response = NextResponse.json({ authorization_url: url.toString() })
  response.cookies.set(`mahshar_oauth_${stateHash.slice(0, 20)}`, browser, { httpOnly: true, secure: marketplaceOrigin().startsWith('https:'),
    sameSite: 'lax', path: `/api/provider-oauth/${id}/callback`, maxAge: 300 })
  return response
})

export const DELETE = withWalletSession(async (request: NextRequest, wallet: string, { params }: Context) => {
  const { id } = await params
  const limited = await enforceRateLimit({ request, scope: 'provider-oauth-disconnect', limit: 6, windowSeconds: 60,
    wallet, dimensions: [id], failClosed: true })
  if (limited) return limited
  const { db, config, profile, hash } = await ownedOAuthConfiguration(id, wallet, false, false, true)
  const { data, error } = await db.rpc('mahshar_oauth_disconnect', { p_api_id: id, p_wallet: wallet, p_mode: config.account_mode })
  if (error) throw new MarketplaceError('Disconnect failed', 503)
  // Only the current approved profile may receive its tokens. Old-profile tokens
  // are erased locally; they must be revoked directly at the former provider.
  const accounts = (data ?? []) as Array<{ encrypted_tokens: string | null; config_hash: string; lease_id?: string | null }>
  const active = accounts.filter(row => row.encrypted_tokens && profile && row.config_hash === hash)
  const revoked = await Promise.all(active.map(row => revokeOAuthTokens(profile!, config, row.encrypted_tokens!)))
  return NextResponse.json({ disconnected: true, provider_revoked: active.length > 0 && revoked.every(Boolean) &&
    accounts.every(row => !row.lease_id && (!row.encrypted_tokens || row.config_hash === hash)) })
})
