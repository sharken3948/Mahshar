import { withOperationAuthorization, requireListingOwner } from '@/lib/marketplace/server'
import { matchListingConfiguration } from '@/lib/marketplace/listing-security'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptKey } from '@/lib/crypto'
import { validateEndpointUrl } from '@/lib/url-validation'
import { safeOutboundFetch } from '@/lib/outbound-fetch'
import { enforceRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export const POST = withOperationAuthorization(async (
  request: NextRequest, wallet: string,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params
  const limited = await enforceRateLimit({ request, scope: 'listing-verify', limit: 10, windowSeconds: 60,
    dimensions: [wallet, id], failClosed: true })
  if (limited) return limited
  const supabase = createServiceClient()
  const listing = await requireListingOwner(supabase, id, wallet)

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
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  const startTime = Date.now()

  try {
    const target = new URL(listing.endpoint_url)
    const method = listing.method ?? 'GET'
    const response = await safeOutboundFetch(target.toString(), () => {
      const requestUrl = new URL(target)
      if (listing.auth_type === 'queryparam' && listing.auth_param_name && authKey) requestUrl.searchParams.set(listing.auth_param_name, authKey)
      const requestHeaders: Record<string, string> = { 'content-type': 'application/json' }
      if (listing.auth_type === 'apikey' && authKey) requestHeaders['x-api-key'] = authKey
      else if (listing.auth_type === 'bearer' && authKey) requestHeaders.Authorization = `Bearer ${authKey}`
      return { url: requestUrl, outboundInit: {
        method,
        body: method !== 'GET' && listing.example_request ? listing.example_request : undefined,
        headers: requestHeaders,
        redirect: 'manual',
        signal: controller.signal,
      } }
    }, { timeoutMs: 5000 })

    clearTimeout(timeoutId)
    const latency_ms = Date.now() - startTime

    await response.body?.cancel().catch(() => undefined)
    if (response.ok) {
      const { data, error } = await matchListingConfiguration(supabase
        .from('api_listings').update({ verified_at: new Date().toISOString() })
        .eq('id', id).ilike('seller_wallet', wallet), listing).select('id')
      if (error) return NextResponse.json({ error: 'Verification persistence failed' }, { status: 500 })
      if (!data?.length) return NextResponse.json({ error: 'Listing changed during verification; retry' }, { status: 409 })

      return NextResponse.json({ success: true, verified: true, latency_ms })
    }

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
