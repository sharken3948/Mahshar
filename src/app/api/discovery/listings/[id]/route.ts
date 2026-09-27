import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { MarketplaceError, normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { credentialProxyAllowed, matchListingConfiguration } from '@/lib/marketplace/listing-security'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

async function discoveryListing(id: string) {
  let owner: string
  try { owner = normalizedWallet(process.env.DISCOVERY_SELLER_WALLET) }
  catch { throw new MarketplaceError('Discovery configuration unavailable', 503) }
  const db = createServiceClient()
  const { data, error } = await db.from('api_listings').select('*').eq('id', id)
    .eq('source', 'discovery').ilike('seller_wallet', owner).maybeSingle()
  if (error) throw new Error('Discovery listing lookup failed')
  if (!data) throw new MarketplaceError('Discovery listing not found', 404)
  return { db, listing: data, owner }
}

// Deliberately excludes ownership, endpoints, credentials and verification fields.
export const PATCH = withAdmin(async (request: NextRequest, _admin, { params }: Context) => {
  const { id } = await params
  const { db, listing, owner } = await discoveryListing(id)
  const body = await request.json().catch(() => null)
  const allowed = ['name', 'description', 'category', 'price_per_call', 'is_active']
  if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) {
    return NextResponse.json({ error: 'Invalid discovery update' }, { status: 400 })
  }
  for (const key of ['name', 'description', 'category']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 10000 || !body[key].trim())) {
      return NextResponse.json({ error: 'Invalid listing text' }, { status: 400 })
    }
  }
  if (body.price_per_call !== undefined && (typeof body.price_per_call !== 'number' || !Number.isFinite(body.price_per_call) || body.price_per_call <= 0)) {
    return NextResponse.json({ error: 'Invalid listing price' }, { status: 400 })
  }
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') return NextResponse.json({ error: 'Invalid activation' }, { status: 400 })
  if (body.is_active === true && !credentialProxyAllowed(listing)) return NextResponse.json({ error: 'Verify the endpoint before activation' }, { status: 409 })
  const { data, error } = await matchListingConfiguration(db.from('api_listings').update(body)
    .eq('id', id).eq('source', 'discovery').ilike('seller_wallet', owner), listing).select('id')
  if (error) throw new Error('Discovery update failed')
  if (!data?.length) return NextResponse.json({ error: 'Listing changed; reload before editing' }, { status: 409 })
  return NextResponse.json({ success: true })
})

export const DELETE = withAdmin(async (_request: NextRequest, _admin, { params }: Context) => {
  const { id } = await params
  const { db, owner } = await discoveryListing(id)
  // Match the existing discovery deletion flow; financial FKs still prevent deletion.
  const { error: unlinkError } = await db.from('crawl_queue').update({ listing_id: null }).eq('listing_id', id)
  if (unlinkError) throw new Error('Discovery deletion failed')
  const { data, error } = await db.from('api_listings').delete().eq('id', id)
    .eq('source', 'discovery').ilike('seller_wallet', owner).select('id')
  if (error) throw new Error('Discovery deletion failed')
  if (!data?.length) return NextResponse.json({ error: 'Listing changed; reload before deleting' }, { status: 409 })
  return NextResponse.json({ success: true })
})
