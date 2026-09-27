import { marketplaceErrors } from '@/lib/marketplace/server'
import { normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export const GET = marketplaceErrors(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url)
  const wallet = normalizedWallet(searchParams.get('buyer_wallet'))

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('api_calls')
    .select('id, api_id, created_at, latency_ms, success, payment_type, api_listings(name, method)')
    .eq('buyer_wallet', wallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ calls: data })
})
