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
        proxy_url: `https://mahshar.xyz/api/proxy/${r.id}`,
      }
    })

    return NextResponse.json({
      marketplace: 'Mahshar',
      description: 'AI-powered API marketplace with USDC nanopayments via x402 on Arc Testnet and Base mainnet',
      network: 'eip155:5042002',
      networks: [
        {
          network: 'eip155:5042002',
          label: 'Arc Testnet',
          chainId: 5042002,
          usdc_asset: '0x3600000000000000000000000000000000000000',
          payment_domain: {
            name: 'GatewayWalletBatched',
            version: '1',
            chainId: 5042002,
            verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
          },
          gateway_api: 'https://gateway-api-testnet.circle.com',
        },
        {
          network: 'eip155:8453',
          label: 'Base mainnet',
          chainId: 8453,
          usdc_asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payment_domain: {
            name: 'GatewayWalletBatched',
            version: '1',
            chainId: 8453,
            verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee',
          },
          gateway_api: 'https://gateway-api.circle.com',
        },
      ],
      network_note: 'Every 402 response `accepts` array offers BOTH networks above. Pick the entry that matches the chain your Circle Gateway balance is on; sign against that entry\'s payment_domain. The scalar `network`, `payment_domain`, and `usdc_asset` fields on this response describe Arc Testnet only and remain for backward compatibility.',
      payment_protocol: 'x402',
      prerequisite: 'USDC must be pre-deposited into the Circle Gateway (https://gateway-api-testnet.circle.com) before making payments. A raw EOA USDC balance on Arc testnet is not accepted — the facilitator checks Circle Gateway balance, not the token contract. Use the Circle CLI (`circle gateway deposit`) or the cross-chain bridge flow on the Mahshar buyer dashboard to fund your Gateway balance.',
      payment_domain: {
        name: 'GatewayWalletBatched',
        version: '1',
        chainId: 5042002,
        verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      },
      proxy_urls: {
        envelope: 'https://mahshar.xyz/api/proxy',
        envelope_note: 'POST body carries {api_id, buyer_wallet, method?, path?, body?}. The inner `body` is forwarded upstream. Used by the browser client.',
        path_template: 'https://mahshar.xyz/api/proxy/{api_id}',
        path_note: 'POST or GET. The entire request body is forwarded to the seller\'s endpoint as-is (no envelope). Buyer identity is the settled payment signer. This is the format Circle Agent Stack\'s `circle_pay_service` tool speaks natively.',
        circle_agent_stack_compatible: true,
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
      how_to_pay: 'Step 1: POST to /api/proxy/{api_id} (path route, recommended) with the upstream API\'s body as-is, no Payment-Signature header. Or use POST /api/proxy with an envelope body {api_id, buyer_wallet, body}. Step 2: You will receive a 402 with a base64-encoded PAYMENT-REQUIRED header. Decode it (base64 → JSON) — `accepts` is an ARRAY offering both Arc Testnet (eip155:5042002) and Base mainnet (eip155:8453). Pick the entry that matches the chain your Circle Gateway balance is on. Step 3: Construct a TransferWithAuthorization EIP-712 message using the picked entry\'s `extra.verifyingContract` and its `network`\'s chainId (see `networks` on this response), eip712_types, and the values from the picked entry (amount, payTo, asset). Sign it with signTypedData (EIP-712). Step 4: Build the payment payload per payment_signature_schema and base64-encode it. Step 5: Retry the identical request (URL + body) with a Payment-Signature header set to that base64 string.',
      payment_signature_schema: {
        note: 'Construct this object, JSON.stringify it, base64-encode the result, and send as the Payment-Signature request header.',
        shape: {
          x402Version: 2,
          payload: {
            authorization: {
              from: '<buyer wallet address — 0x-prefixed checksummed address>',
              to: '<payTo from your chosen accepts entry>',
              value: '<amount from your chosen accepts entry as a decimal string — micro-USDC, 6-decimal integer>',
              validAfter: '<Unix timestamp as decimal string, e.g. "1234567890">',
              validBefore: '<Unix timestamp as decimal string, e.g. "1235172790">',
              nonce: '<bytes32 hex string with 0x prefix>',
            },
            signature: '<0x-prefixed EIP-712 signature returned by signTypedData>',
          },
          resource: '<the resource object from the 402 PAYMENT-REQUIRED response>',
          accepted: '<the full accepts entry you signed against (the one matching your chain)>',
        },
      },
      examples: {
        curl_probe_402: 'curl -s -i -X POST https://mahshar.xyz/api/proxy/34c7a931-81de-4b8b-81ac-0916b4316989 -H \'content-type: application/json\' -d \'{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"arc"}\'',
        curl_decode_accepts: 'curl -s -X POST https://mahshar.xyz/api/proxy/34c7a931-81de-4b8b-81ac-0916b4316989 -H \'content-type: application/json\' -d \'{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"arc"}\' -D - -o /dev/null | awk \'BEGIN{IGNORECASE=1} /^payment-required:/{sub(/^[^:]+: /, ""); print}\' | tr -d \'\\r\' | base64 -d | jq .',
        note: 'Both examples target the ioscope listing. First returns HTTP 402 with the PAYMENT-REQUIRED header; second decodes the header to show the multi-chain accepts array.',
      },
      error_responses: {
        '402_no_payment': 'No Payment-Signature header was sent — the PAYMENT-REQUIRED response header contains base64-encoded payment instructions. This 402 has an empty JSON body {}.',
        '402_payment_failed': 'A Payment-Signature header was present but verification or settlement failed — check the JSON error field in the body. Common causes: invalid signature, wrong amount, reused nonce, insufficient Circle Gateway balance, or `duplicate_payment` if the tx_hash is a replay of a previously settled payment.',
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
