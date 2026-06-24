import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { validateEndpointUrl } from '@/lib/url-validation'
import { isValidWalletAddress } from '@/lib/wallet-validation'

export const runtime = 'nodejs'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json() as {
    seller_wallet: string
    is_active?: boolean
    price_per_call?: number
    name?: string
    category?: string
    description?: string
    endpoint_url?: string
    auth_type?: string
  }

  const { seller_wallet, ...fields } = body

  if (!seller_wallet) {
    return NextResponse.json({ error: 'seller_wallet is required' }, { status: 400 })
  }
  if (!isValidWalletAddress(seller_wallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet address' }, { status: 400 })
  }

  if (fields.endpoint_url !== undefined) {
    const urlValidation = await validateEndpointUrl(fields.endpoint_url)
    if (!urlValidation.valid) {
      return NextResponse.json({ error: 'Invalid endpoint URL', reason: urlValidation.error }, { status: 400 })
    }
  }

  if (fields.price_per_call !== undefined) {
    if (typeof fields.price_per_call !== 'number' || !isFinite(fields.price_per_call) || fields.price_per_call <= 0) {
      return NextResponse.json({ error: 'price_per_call must be a positive number' }, { status: 400 })
    }
  }

  const patch: Record<string, unknown> = {}
  if (fields.is_active !== undefined) patch.is_active = fields.is_active
  if (fields.price_per_call !== undefined) patch.price_per_call = fields.price_per_call
  if (fields.name !== undefined) patch.name = fields.name
  if (fields.category !== undefined) patch.category = fields.category
  if (fields.description !== undefined) patch.description = fields.description
  if (fields.endpoint_url !== undefined) {
    patch.endpoint_url = fields.endpoint_url
    patch.verified_at = null  // H4: changing URL invalidates prior verification
  }
  if (fields.auth_type !== undefined) patch.auth_type = fields.auth_type

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('api_listings')
    .update(patch)
    .eq('id', id)
    .ilike('seller_wallet', seller_wallet)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Not found or not authorized' }, { status: 403 })
  return NextResponse.json({ success: true })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json().catch(() => ({})) as { seller_wallet?: string }
  const { seller_wallet } = body

  if (!seller_wallet) {
    return NextResponse.json({ error: 'seller_wallet is required' }, { status: 400 })
  }
  if (!isValidWalletAddress(seller_wallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet address' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('api_listings')
    .delete()
    .eq('id', id)
    .ilike('seller_wallet', seller_wallet)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Not found or not authorized' }, { status: 403 })
  return NextResponse.json({ success: true })
}
