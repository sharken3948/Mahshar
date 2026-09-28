import 'server-only'
import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, verifyTypedData } from 'viem'
import { arcMainnet } from '@/lib/chains'
import { createServiceClient } from '@/lib/supabase/server'
import { MarketplaceError, OPERATION_AUTH_DOMAIN, OPERATION_AUTH_HEADER, OPERATION_AUTH_SECONDS,
  OPERATION_AUTH_TYPES, authorizationMessage, decodeAuthorizationProof, requestPayload } from './operation-authorization'
import { WALLET_SESSION_COOKIE } from './session-auth'

export function marketplaceOrigin() {
  const configured = process.env.MARKETPLACE_ORIGIN?.trim()
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('MARKETPLACE_ORIGIN is required in production')
  const origin = configured || 'http://localhost:3000'
  const url = new URL(origin)
  if (url.origin !== origin || (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production'
    && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid marketplace origin')
  return origin
}
export function assertMarketplaceOrigin(request: NextRequest) {
  if (request.headers.get('origin') !== marketplaceOrigin()) throw new MarketplaceError('Origin rejected', 403)
}
export function assertSessionMutationOrigin(request: NextRequest) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) assertMarketplaceOrigin(request)
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new MarketplaceError('Origin rejected', 403)
}
export function sessionTokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
export async function requireWalletSession(request: NextRequest) {
  const token = request.cookies.get(WALLET_SESSION_COOKIE)?.value
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MarketplaceError('Wallet session required')
  const { data, error } = await createServiceClient().from('wallet_sessions')
    .select('wallet, expires_at').eq('token_hash', sessionTokenHash(token)).is('revoked_at', null)
    .gt('expires_at', new Date().toISOString()).maybeSingle()
  if (error) throw new MarketplaceError('Wallet session unavailable', 503)
  if (!data) throw new MarketplaceError('Wallet session expired')
  return String(data.wallet).toLowerCase()
}
export async function requireOperationAuthorization(request: NextRequest) {
  const method = request.method.toUpperCase()
  const bodyText = ['GET', 'HEAD'].includes(method) ? null : await request.clone().text()
  return requireOperationAuthorizationForPayload(request, requestPayload(new URL(request.url), method, bodyText))
}
export async function requireOperationAuthorizationForPayload(request: NextRequest, payload: unknown) {
  const method = request.method.toUpperCase()
  if (!['GET', 'HEAD'].includes(method)) assertMarketplaceOrigin(request)
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new MarketplaceError('Origin rejected', 403)
  const proof = decodeAuthorizationProof(request.headers.get(OPERATION_AUTH_HEADER))
  const now = Math.floor(Date.now() / 1000)
  if (proof.issuedAt > now + 30 || proof.deadline <= now || proof.deadline <= proof.issuedAt
    || proof.deadline - proof.issuedAt > OPERATION_AUTH_SECONDS) throw new MarketplaceError('Operation authorization expired')
  const url = new URL(request.url)
  const message = authorizationMessage({ wallet: proof.wallet, method, url, payload,
    nonce: proof.nonce, issuedAt: proof.issuedAt, deadline: proof.deadline })
  const verification = { address: proof.wallet, domain: OPERATION_AUTH_DOMAIN, types: OPERATION_AUTH_TYPES,
    primaryType: 'MahsharAuthorization' as const, message, signature: proof.signature }
  let valid = await verifyTypedData(verification).catch(() => false)
  if (!valid) valid = await createPublicClient({ chain: arcMainnet,
    transport: http(process.env.ARC_MAINNET_RPC_URL, { timeout: 10000, retryCount: 0 }) }).verifyTypedData(verification).catch(() => false)
  if (!valid) throw new MarketplaceError('Invalid operation authorization')
  const { error } = await createServiceClient().from('withdraw_used_nonces')
    .insert({ nonce: proof.nonce.toLowerCase(), seller_wallet: proof.wallet })
  if (error?.code === '23505') throw new MarketplaceError('Operation authorization has already been used', 409)
  if (error) throw new MarketplaceError('Operation authorization storage unavailable', 503)
  return proof.wallet
}
export function marketplaceErrors<A extends unknown[]>(handler: (request: NextRequest, ...args: A) => Promise<Response>) {
  return async (request: NextRequest, ...args: A) => {
    try { return await handler(request, ...args) } catch (error) {
      const known = error instanceof MarketplaceError
      return NextResponse.json({ error: known ? error.message : 'Request failed' },
        { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store' } })
    }
  }
}
export function withOperationAuthorization<A extends unknown[]>(handler: (request: NextRequest, wallet: string, ...args: A) => Promise<Response>) {
  return marketplaceErrors(async (request: NextRequest, ...args: A) => {
    const wallet = await requireOperationAuthorization(request)
    const response = await handler(request, wallet, ...args)
    response.headers.set('Cache-Control', 'no-store')
    return response
  })
}
export function withWalletSession<A extends unknown[]>(handler: (request: NextRequest, wallet: string, ...args: A) => Promise<Response>) {
  return marketplaceErrors(async (request: NextRequest, ...args: A) => {
    assertSessionMutationOrigin(request)
    const wallet = await requireWalletSession(request)
    const response = await handler(request, wallet, ...args)
    response.headers.set('Cache-Control', 'no-store')
    return response
  })
}
export async function requireListingOwner(db: ReturnType<typeof createServiceClient>, id: string, wallet: string) {
  const { data, error } = await db.from('api_listings').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error('Listing lookup failed')
  if (!data) throw new MarketplaceError('Listing not found', 404)
  if (String(data.seller_wallet).toLowerCase() !== wallet) throw new MarketplaceError('Not listing owner', 403)
  return data
}
