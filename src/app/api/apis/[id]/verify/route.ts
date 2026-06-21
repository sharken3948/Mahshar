import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptKey } from '@/lib/crypto'
import { validateEndpointUrl } from '@/lib/url-validation'
import type { AuthType } from '@/types'

export const runtime = 'nodejs'

interface ListingRow {
  endpoint_url: string
  auth_type: AuthType
  encrypted_key: string | null
  price_per_call: number
  example_request: string | null
  example_response: string | null
  verified_at: string | null
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = createServiceClient()

  const { data: listing, error } = await supabase
    .from('api_listings')
    .select('endpoint_url, auth_type, encrypted_key, price_per_call, example_request, example_response, verified_at')
    .eq('id', id)
    .single<ListingRow>()

  if (error || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
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

  const headers: Record<string, string> = {}
  if (listing.auth_type === 'apikey' && authKey) {
    headers['x-api-key'] = authKey
  } else if (listing.auth_type === 'bearer' && authKey) {
    headers['Authorization'] = `Bearer ${authKey}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  const startTime = Date.now()

  try {
    const response = await fetch(listing.endpoint_url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    const latency_ms = Date.now() - startTime

    if (response.ok) {
      await supabase
        .from('api_listings')
        .update({ verified_at: new Date().toISOString() })
        .eq('id', id)

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
}
