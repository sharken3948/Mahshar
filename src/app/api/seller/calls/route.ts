import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'

export const runtime = 'nodejs'

interface ApiCallRow {
  id: string
  api_id: string
  buyer_wallet: string
  created_at: string
  latency_ms: number
  success: boolean
}

interface ApiListingRow {
  id: string
  name: string
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sellerWallet = searchParams.get('seller_wallet')

  if (!sellerWallet) {
    return NextResponse.json({ error: 'seller_wallet required' }, { status: 400 })
  }
  if (!isValidWalletAddress(sellerWallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet address' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: listings, error: listingsError } = await supabase
    .from('api_listings')
    .select('id, name')
    .ilike('seller_wallet', sellerWallet)

  if (listingsError) return NextResponse.json({ error: listingsError.message }, { status: 500 })
  if (!listings || listings.length === 0) return NextResponse.json({ groups: [] })

  const rows = listings as ApiListingRow[]
  const apiIds = rows.map(l => l.id)
  const nameMap = Object.fromEntries(rows.map(l => [l.id, l.name]))

  const { data: calls, error: callsError } = await supabase
    .from('api_calls')
    .select('id, api_id, buyer_wallet, created_at, latency_ms, success')
    .in('api_id', apiIds)
    .order('created_at', { ascending: false })

  if (callsError) return NextResponse.json({ error: callsError.message }, { status: 500 })
  if (!calls || calls.length === 0) return NextResponse.json({ groups: [] })

  const map = new Map<string, ApiCallRow[]>()
  for (const call of calls as ApiCallRow[]) {
    if (!map.has(call.api_id)) map.set(call.api_id, [])
    map.get(call.api_id)!.push(call)
  }

  const groups = Array.from(map.entries()).map(([apiId, grp]) => ({
    api_id: apiId,
    api_name: nameMap[apiId] ?? 'Unknown',
    count: grp.length,
    avgLatency: Math.round(grp.reduce((s, c) => s + c.latency_ms, 0) / grp.length),
    successRate: Math.round((grp.filter(c => c.success).length / grp.length) * 100),
    lastCalled: grp[0].created_at,
    calls: grp.map(c => ({
      id: c.id,
      buyer_wallet: c.buyer_wallet,
      created_at: c.created_at,
      latency_ms: c.latency_ms,
      success: c.success,
    })),
  }))

  return NextResponse.json({ groups })
}
