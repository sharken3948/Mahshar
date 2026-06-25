import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

interface ListingRow {
  id: string
  name: string
  description: string
  category: string
  price_per_call: number
  payment_model: string
  auth_type: string
  endpoint_url: string
  example_request: string | null
  example_response: string | null
  score: number | null
  verified_at: string | null
  created_at: string
}

interface CallStatsRow {
  api_id: string
  latency_ms: number
  success: boolean
}

export async function GET() {
  try {
    const supabase = createServiceClient()

    // TODO: add pagination if the marketplace grows beyond 50 listings
    const { data: listings, error: listingsError } = await supabase
      .from('api_listings')
      .select('id, name, description, category, price_per_call, payment_model, auth_type, endpoint_url, example_request, example_response, score, verified_at, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(50)

    if (listingsError) {
      console.error('[discover] listings error:', listingsError.message)
      return NextResponse.json({ error: 'Failed to fetch API listings' }, { status: 500 })
    }

    const rows = (listings ?? []) as ListingRow[]

    let callStats: CallStatsRow[] = []
    if (rows.length > 0) {
      const apiIds = rows.map(r => r.id)
      const { data: calls, error: callsError } = await supabase
        .from('api_calls')
        .select('api_id, latency_ms, success')
        .in('api_id', apiIds)

      if (callsError) {
        console.error('[discover] calls error:', callsError.message)
      } else {
        callStats = (calls ?? []) as CallStatsRow[]
      }
    }

    const statsMap = new Map<string, { total: number; successes: number; totalLatency: number }>()
    for (const c of callStats) {
      if (!statsMap.has(c.api_id)) statsMap.set(c.api_id, { total: 0, successes: 0, totalLatency: 0 })
      const s = statsMap.get(c.api_id)!
      s.total++
      if (c.success) s.successes++
      s.totalLatency += c.latency_ms
    }

    const apis = rows.map(r => {
      const s = statsMap.get(r.id)
      const total_calls = s?.total ?? 0
      const success_rate = total_calls > 0 ? Math.round((s!.successes / total_calls) * 100) / 100 : null
      const avg_latency_ms = total_calls > 0 ? Math.round(s!.totalLatency / total_calls) : null

      let example_response: unknown = null
      if (r.example_response) {
        try {
          example_response = JSON.parse(r.example_response)
        } catch {
          example_response = r.example_response
        }
      }

      return {
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        price_per_call_usdc: r.price_per_call,
        payment_model: r.payment_model,
        auth_type: r.auth_type,
        score: r.score,
        verified: r.verified_at !== null,
        example_request: r.example_request,
        example_response,
        total_calls,
        success_rate,
        avg_latency_ms,
      }
    })

    return NextResponse.json({
      marketplace: 'Mahshar',
      description: 'AI-powered API marketplace with USDC nanopayments via x402 on Arc',
      network: 'eip155:5042002',
      payment_protocol: 'x402',
      payment_domain: {
        name: 'GatewayWalletBatched',
        version: '1',
        verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      },
      usdc_asset: '0x3600000000000000000000000000000000000000',
      how_to_pay:
        'POST to /api/proxy with {api_id, buyer_wallet} and no payment-signature header to receive a 402 response with a base64-encoded PAYMENT-REQUIRED header. Decode it (base64 -> JSON), sign a TransferWithAuthorization EIP-712 message using payment_domain and the amount/payTo from the decoded requirements, then retry the same POST with a \'payment-signature\' header containing the base64-encoded payment payload.',
      error_responses: {
        '402': 'Payment required — decode PAYMENT-REQUIRED header for payment instructions, or payment verification/settlement failed',
        '404': 'API not found or inactive',
        '403': 'API is not active',
        '500': 'Internal processing error',
      },
      apis,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[discover] unexpected error:', message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
