import { withWalletSession, requireListingOwner } from '@/lib/marketplace/server'
import { matchListingVerificationConfiguration } from '@/lib/marketplace/listing-security'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptKey } from '@/lib/crypto'
import { validateEndpointUrl } from '@/lib/url-validation'
import { safeOutboundFetch } from '@/lib/outbound-fetch'
import { enforceRateLimit } from '@/lib/rate-limit'
import { assessRepresentativeResponseSize, MAX_SAFE_SERIALIZED_RESPONSE_BYTES, readResponseBytes,
  ResponseTooLargeError } from '@/lib/proxy-response'
import { validateListingRequestContract } from '@/lib/marketplace/request-contract'
import { buildUpstreamAuthentication } from '@/lib/marketplace/upstream-auth'
import { LISTING_VERIFICATION_TIMEOUT_MS } from '@/lib/marketplace/listing-verification-timeout'

export const runtime = 'nodejs'

export const POST = withWalletSession(async (
  request: NextRequest, wallet: string,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params
  const limited = await enforceRateLimit({ request, scope: 'listing-verify', limit: 10, windowSeconds: 60,
    wallet, dimensions: [id], failClosed: true })
  if (limited) return limited
  const supabase = createServiceClient()
  const listing = await requireListingOwner(supabase, id, wallet)

  const requestContract = validateListingRequestContract(listing)
  if (!requestContract.ok) {
    return NextResponse.json({ error: requestContract.error, field: requestContract.field,
      success: false, verified: false }, { status: 400 })
  }

  if (listing.verified_at) {
    return NextResponse.json({ already_verified: true, success: true })
  }

  const validation = await validateEndpointUrl(listing.endpoint_url)
  if (!validation.valid) {
    return NextResponse.json({ error: 'Invalid endpoint URL', reason: validation.error }, { status: 400 })
  }

  let authKey: string | undefined
  if (listing.encrypted_key && listing.auth_type !== 'public') {
    try {
      authKey = decryptKey(listing.encrypted_key)
    } catch {
      return NextResponse.json({ error: 'Failed to decrypt stored API credentials' }, { status: 500 })
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LISTING_VERIFICATION_TIMEOUT_MS)
  const startTime = Date.now()

  try {
    const target = new URL(requestContract.example.canonical_target)
    const method = requestContract.method
    const response = await safeOutboundFetch(target.toString(), () => {
      const { requestUrl, headers: requestHeaders } = buildUpstreamAuthentication(
        target, listing.auth_type, authKey, listing.auth_param_name,
      )
      return { url: requestUrl, outboundInit: {
        method,
        body: method !== 'GET' && requestContract.example.body !== null
          ? JSON.stringify(requestContract.example.body) : undefined,
        headers: requestHeaders,
        redirect: 'manual',
        signal: controller.signal,
      } }
    }, { timeoutMs: LISTING_VERIFICATION_TIMEOUT_MS })

    clearTimeout(timeoutId)
    const latency_ms = Date.now() - startTime

    if (response.ok) {
      let bytes: Uint8Array
      try { bytes = await readResponseBytes(response.body, MAX_SAFE_SERIALIZED_RESPONSE_BYTES) }
      catch (error) {
        if (error instanceof ResponseTooLargeError) return NextResponse.json({
          error: 'Verification response exceeds Mahshar\'s delivery size limit', success: false, verified: false,
          response_size_blocked: true,
        }, { status: 413 })
        throw error
      }
      const rawBody = new TextDecoder().decode(bytes)
      let representativeBody: unknown = rawBody
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        try { representativeBody = JSON.parse(rawBody) } catch { representativeBody = rawBody }
      }
      const size = assessRepresentativeResponseSize(representativeBody)
      if (size.exceedsLimit) return NextResponse.json({
        error: 'Verification response exceeds Mahshar\'s delivery size limit', success: false, verified: false,
        response_size_bytes: size.serializedBytes, response_size_blocked: true,
      }, { status: 413 })
      const { data, error } = await matchListingVerificationConfiguration(supabase
        .from('api_listings').update({ verified_at: new Date().toISOString() })
        .eq('id', id).ilike('seller_wallet', wallet), listing).select('id')
      if (error) return NextResponse.json({ error: 'Verification persistence failed' }, { status: 500 })
      if (!data?.length) return NextResponse.json({ error: 'Listing changed during verification; retry' }, { status: 409 })

      return NextResponse.json({ success: true, verified: true, latency_ms,
        response_size_bytes: size.serializedBytes,
        response_size_warning: size.warning
          ? 'Verification response is near Mahshar\'s delivery size limit; larger responses may fail.' : null })
    }

    await response.body?.cancel().catch(() => undefined)
    return NextResponse.json({
      error: 'Endpoint failed verification test',
      success: false,
      verified: false,
    })
  } catch {
    clearTimeout(timeoutId)
    return NextResponse.json({
      error: 'Endpoint failed verification test',
      success: false,
      verified: false,
    })
  }
})
