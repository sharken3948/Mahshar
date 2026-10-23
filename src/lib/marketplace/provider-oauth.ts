import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { encryptKey, decryptKey } from '@/lib/crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { safeOutboundFetch } from '@/lib/outbound-fetch'
import { readResponseBytes } from '@/lib/proxy-response'
import { marketplaceOrigin } from './server'
import { approvedOAuthProfile, type OAuthProfile } from './provider-oauth-profiles'
import { credentialString, oauthConfiguration, ProviderAuthError, type OAuthConfiguration } from './provider-auth-config'

export const oauthHash = (value: string) => createHash('sha256').update(value).digest('hex')
export const pkceChallenge = (value: string) => createHash('sha256').update(value).digest('base64url')
export const oauthRandom = () => randomBytes(32).toString('base64url')
type Listing = { id: string; seller_wallet: string; auth_type: string; endpoint_url: string; encrypted_key: string | null }
type Tokens = { access_token: string; refresh_token?: string; expires_at: number }
type Account = { id: string; encrypted_tokens: string | null; expires_at: string | null; status: string;
  lease_id: string | null; revision: number }
export function listingOAuth(listing: Listing) {
  if (!listing.encrypted_key) throw new ProviderAuthError()
  const config = oauthConfiguration(decryptKey(listing.encrypted_key))
  const profile = approvedOAuthProfile(config.provider, listing.endpoint_url,
    listing.auth_type === 'oauth_client_credentials' ? 'client_credentials' : 'authorization_code')
  if (profile.client_auth !== 'none' && !config.client_secret) throw new ProviderAuthError()
  if (listing.auth_type === 'oauth_client_credentials' && config.account_mode !== 'seller') throw new ProviderAuthError()
  return { config, profile, hash: oauthHash(JSON.stringify({ ciphertext: listing.encrypted_key, profile })) }
}
function clientForm(profile: OAuthProfile, config: OAuthConfiguration, form: URLSearchParams) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (profile.client_auth === 'client_secret_basic') {
    const component = (value: string) => new URLSearchParams([['x', value]]).toString().slice(2)
    headers.authorization = `Basic ${Buffer.from(`${component(config.client_id)}:${component(credentialString(config.client_secret))}`).toString('base64')}`
  } else {
    form.set('client_id', config.client_id)
    if (profile.client_auth === 'client_secret_post') form.set('client_secret', credentialString(config.client_secret))
  }
  return headers
}
export async function requestOAuthTokens(profile: OAuthProfile, config: OAuthConfiguration, fields: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
  try {
    const form = new URLSearchParams(fields)
    const headers = clientForm(profile, config, form)
    const response = await safeOutboundFetch(profile.token_endpoint, { method: 'POST', headers, body: form.toString(),
      redirect: 'manual', signal: AbortSignal.timeout(10000) }, { timeoutMs: 10000 })
    if (!response.ok) { await response.body?.cancel(); throw new ProviderAuthError() }
    const raw = new TextDecoder().decode(await readResponseBytes(response.body, 32768))
    const token = JSON.parse(raw)
    if (typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' ||
      typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in < 61 ||
      token.expires_in > 31 * 86400) throw new ProviderAuthError()
    const access = credentialString(token.access_token)
    if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(access)) throw new ProviderAuthError()
    const refresh = token.refresh_token === undefined ? previousRefresh : credentialString(token.refresh_token)
    if (token.scope !== undefined && (typeof token.scope !== 'string' ||
      token.scope.split(' ').filter(Boolean).some((scope: string) => !profile.scopes.includes(scope)))) throw new ProviderAuthError()
    return { access_token: access, ...(refresh ? { refresh_token: refresh } : {}), expires_at: Date.now() + token.expires_in * 1000 }
  } catch { throw new ProviderAuthError() }
}

/** DB leases serialize token acquisition and rotating refresh across processes. No process-global token cache. */
export async function accessTokenForListing(listing: Listing, actorWallet: string): Promise<Tokens> {
  const { config, profile, hash } = listingOAuth(listing)
  const owner = config.account_mode === 'seller' ? listing.seller_wallet.toLowerCase() : actorWallet.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new ProviderAuthError()
  const db = createServiceClient(), lease = randomUUID()
  for (let attempt = 0; attempt < 40; attempt++) {
    const { data, error } = await db.rpc('mahshar_oauth_claim', { p_api_id: listing.id, p_wallet: owner,
      p_mode: config.account_mode, p_config_hash: hash, p_ciphertext: listing.encrypted_key,
      p_create: listing.auth_type === 'oauth_client_credentials', p_lease: lease })
    const row = data?.[0] as Account | undefined
    if (error || !row || row.status !== 'active') throw new ProviderAuthError()
    if (row.encrypted_tokens && row.expires_at && Date.parse(row.expires_at) > Date.now() + 60000) {
      return JSON.parse(decryptKey(row.encrypted_tokens)) as Tokens
    }
    if (row.lease_id !== lease) {
      await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }
    let tokens: Tokens
    try {
      const previous = row.encrypted_tokens ? JSON.parse(decryptKey(row.encrypted_tokens)) as Tokens : undefined
      const fields: Record<string, string> = listing.auth_type === 'oauth_client_credentials'
        ? { grant_type: 'client_credentials', ...(profile.scopes.length ? { scope: profile.scopes.join(' ') } : {}) }
        : { grant_type: 'refresh_token', refresh_token: credentialString(previous?.refresh_token),
          redirect_uri: `${marketplaceOrigin()}/api/provider-oauth/${listing.id}/callback` }
      tokens = await requestOAuthTokens(profile, config, fields, previous?.refresh_token)
    } catch {
      await db.rpc('mahshar_oauth_finish', { p_id: row.id, p_lease: lease, p_revision: row.revision,
        p_ciphertext: listing.encrypted_key, p_tokens: null, p_expires: null })
      throw new ProviderAuthError()
    }
    const { data: finished, error: finishError } = await db.rpc('mahshar_oauth_finish', { p_id: row.id, p_lease: lease,
      p_revision: row.revision, p_ciphertext: listing.encrypted_key, p_tokens: encryptKey(JSON.stringify(tokens)),
      p_expires: new Date(tokens.expires_at).toISOString() })
    if (finishError || finished !== true) {
      await revokeOAuthTokens(profile, config, encryptKey(JSON.stringify(tokens)))
      throw new ProviderAuthError()
    }
    return tokens
  }
  throw new ProviderAuthError()
}

export async function revokeOAuthTokens(profile: OAuthProfile, config: OAuthConfiguration, encrypted: string) {
  if (!profile.revocation_endpoint) return false
  try {
    const tokens = JSON.parse(decryptKey(encrypted)) as Tokens
    // Revoke both: RFC 7009 does not require access-token revocation to revoke the refresh token.
    for (const [token, hint] of [[tokens.refresh_token, 'refresh_token'], [tokens.access_token, 'access_token']]) {
      if (!token) continue
      const form = new URLSearchParams({ token, token_type_hint: hint! })
      const headers = clientForm(profile, config, form)
      const response = await safeOutboundFetch(profile.revocation_endpoint, { method: 'POST', headers,
        body: form.toString(), redirect: 'manual', signal: AbortSignal.timeout(10000) }, { timeoutMs: 10000 })
      await response.body?.cancel()
      if (!response.ok) return false
    }
    return true
  } catch { return false }
}
