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
      prerequisite: 'USDC must be pre-deposited into the Circle Gateway (https://gateway-api-testnet.circle.com) before making payments. A raw EOA USDC balance on Arc testnet is not accepted — the facilitator checks Circle Gateway balance, not the token contract. Use the Circle CLI (`circle gateway deposit`) or the cross-chain bridge flow on the Mahshar buyer dashboard to fund your Gateway balance.',
      payment_domain: {
        name: 'GatewayWalletBatched',
        version: '1',
        chainId: 5042002,
        verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      },
      eip712_types: {
        TransferWithAuthorization: [
          { name: 'from',        type: 'address' },
          { name: 'to',          type: 'address' },
          { name: 'value',       type: 'uint256' },
          { name: 'validAfter',  type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce',       type: 'bytes32' },
        ],
      },
      usdc_asset: '0x3600000000000000000000000000000000000000',
      amount_decimals: 6,
      amount_note: 'The `amount` field in the 402 PAYMENT-REQUIRED response is in micro-USDC (6 decimal places, matching the USDC token contract). Example: "1100000" = $1.10 USDC. The buyer-facing amount already includes a 10% platform fee on top of the listed price_per_call_usdc. Pass it as BigInt when constructing the EIP-712 message value field.',
      nonce_format: 'bytes32 — 32 cryptographically random bytes, hex-encoded with a 0x prefix. Generate with: crypto.getRandomValues(new Uint8Array(32)) then hex-encode. Each payment must use a unique nonce; reuse will cause settlement failure.',
      validity_window: {
        validAfter: 'Unix timestamp (seconds) before which the authorization is not valid. Recommended: Math.floor(Date.now() / 1000) - 600 to allow 10 minutes of clock-skew grace.',
        validBefore: 'Unix timestamp (seconds) after which the authorization expires. Recommended: Math.floor(Date.now() / 1000) + 604900 (~7 days). Must be passed as BigInt in the EIP-712 message.',
      },
      how_to_pay: 'Step 1: POST to /api/proxy with body {api_id, buyer_wallet} and no Payment-Signature header. buyer_wallet must be the address whose private key will sign — it is stored for analytics but a mismatch with the actual signer only produces a warning, not a rejection. Step 2: You will receive a 402 with a base64-encoded PAYMENT-REQUIRED header. Decode it (base64 → JSON) and read accepts[0] for {amount, payTo, network, asset, extra}. Step 3: Construct a TransferWithAuthorization EIP-712 message using payment_domain (all four fields including chainId), eip712_types, and the values from accepts[0]. Sign it with signTypedData (EIP-712). Step 4: Build the payment payload per payment_signature_schema and base64-encode it. Step 5: Retry the identical POST body with a Payment-Signature header set to that base64 string.',
      payment_signature_schema: {
        note: 'Construct this object, JSON.stringify it, base64-encode the result, and send as the Payment-Signature request header.',
        shape: {
          x402Version: 2,
          payload: {
            authorization: {
              from: '<buyer wallet address — 0x-prefixed checksummed address>',
              to: '<payTo from accepts[0] in the 402 response>',
              value: '<amount from accepts[0] as a decimal string, e.g. "1100000">',
              validAfter: '<Unix timestamp as decimal string, e.g. "1234567890">',
              validBefore: '<Unix timestamp as decimal string, e.g. "1235172790">',
              nonce: '<bytes32 hex string with 0x prefix>',
            },
            signature: '<0x-prefixed EIP-712 signature returned by signTypedData>',
          },
          resource: '<the resource object from the 402 PAYMENT-REQUIRED response>',
          accepted: '<the full accepts[0] object from the 402 PAYMENT-REQUIRED response>',
        },
      },
      error_responses: {
        '402_no_payment': 'No Payment-Signature header was sent — the PAYMENT-REQUIRED response header contains base64-encoded payment instructions. This 402 has an empty JSON body {}.',
        '402_payment_failed': 'A Payment-Signature header was present but verification or settlement failed — check the JSON error field in the body. Common causes: invalid signature, wrong amount, reused nonce, or insufficient Circle Gateway balance.',
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
