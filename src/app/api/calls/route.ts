import { withOperationAuthorization } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export const GET = withOperationAuthorization(async (request: NextRequest, wallet: string) => {
  const { searchParams } = new URL(request.url)
  assertWalletClaim(searchParams.get('buyer_wallet'), wallet)

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
