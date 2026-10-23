import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptKey } from '@/lib/crypto'
import { requireWalletSession, assertSessionMutationOrigin } from './server'
import { listingOAuth } from './provider-oauth'

/** Reject a missing connection before accepting payment. Token exchange remains
 * server-side at dispatch, and the settled payer still selects the buyer account. */
export async function providerOAuthPreflight(request: NextRequest, listing: Parameters<typeof listingOAuth>[0], buyerClaim?: unknown) {
  try {
    const { config, hash } = listingOAuth(listing)
    let wallet = listing.seller_wallet.toLowerCase()
    if (config.account_mode === 'buyer') {
      assertSessionMutationOrigin(request)
      wallet = await requireWalletSession(request)
      if (buyerClaim !== undefined && (typeof buyerClaim !== 'string' || buyerClaim.toLowerCase() !== wallet)) throw new Error()
    }
    const { data, error } = await createServiceClient().from('provider_oauth_accounts')
      .select('status, encrypted_tokens, expires_at').eq('api_id', listing.id).eq('owner_wallet', wallet)
      .eq('account_mode', config.account_mode).eq('config_hash', hash).maybeSingle()
    // An enabled Client Credentials connection can be acquired on demand.
    if (!error && listing.auth_type === 'oauth_client_credentials' && (!data || data.status === 'active')) return { ok: true as const, buyerWallet: null }
    if (error || !data || data.status !== 'active' || !data.encrypted_tokens) throw new Error()
    if (!data.expires_at || Date.parse(data.expires_at) <= Date.now() + 60000) {
      const tokens = JSON.parse(decryptKey(data.encrypted_tokens))
      if (!tokens.refresh_token) throw new Error()
    }
    return { ok: true as const, buyerWallet: config.account_mode === 'buyer' ? wallet : null }
  } catch {
    return { ok: false as const, response: NextResponse.json({ error: 'provider_connection_required',
      connection_url: `/provider-connections/${listing.id}` }, { status: 409, headers: { 'Cache-Control': 'no-store' } }) }
  }
}
