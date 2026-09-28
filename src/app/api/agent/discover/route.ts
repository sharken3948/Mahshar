import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { agentExecutionContract } from '@/lib/marketplace/agent-contract'
import { enforceRateLimit } from '@/lib/rate-limit'
import { marketplaceOrigin } from '@/lib/marketplace/server'

export const runtime = 'nodejs'

interface ListingRow {
  id: string
  name: string
  description: string
  category: string
  price_per_call: number
  payment_model: string
  auth_type: string
  method: string
  example_request: string | null
  example_response: string | null
  score: number | null
  verified_at: string | null
  created_at: string
  request_schema: Record<string, unknown> | null
  response_schema: Record<string, unknown> | null
  body_required: boolean | null
  dynamic_path_supported: boolean
  path_parameters: unknown[] | null
  query_parameters: unknown[] | null
  endpoint_url: string
  auth_param_name: string | null
}

interface CallStatsRow {
  api_id: string
  total_calls: number
  successful_calls: number
  avg_latency_ms: number | null
}

export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimit({ request, scope: 'agent-discover', limit: 120, windowSeconds: 60, failClosed: false })
    if (limited) return limited
    const supabase = createServiceClient()

    const url = new URL(request.url)
    const publicOrigin = marketplaceOrigin()
    const paymentRecipient = process.env.PLATFORM_WALLET_ADDRESS
    if (!paymentRecipient || !/^0x[\da-f]{40}$/i.test(paymentRecipient)) {
      return NextResponse.json({ error: 'payment_configuration_unavailable' }, { status: 503 })
    }
    const requestedLimit = Number(url.searchParams.get('limit') ?? 50)
    const requestedOffset = Number(url.searchParams.get('offset') ?? 0)
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100 ||
      !Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 10000) {
      return NextResponse.json({ error: 'invalid_pagination' }, { status: 400 })
    }

    const { data: listings, error: listingsError } = await supabase
      .from('api_listings')
      .select('id, name, description, category, price_per_call, payment_model, auth_type, auth_param_name, method, endpoint_url, example_request, example_response, score, verified_at, created_at, request_schema, response_schema, body_required, dynamic_path_supported, path_parameters, query_parameters')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(requestedOffset, requestedOffset + requestedLimit - 1)

    if (listingsError) {
      console.error('[discover] listings error:', listingsError.message)
      return NextResponse.json({ error: 'Failed to fetch API listings' }, { status: 500 })
    }

    const rows = (listings ?? []) as ListingRow[]

    let callStats: CallStatsRow[] = []
    if (rows.length > 0) {
      const apiIds = rows.map(r => r.id)
      const { data: calls, error: callsError } = await supabase
        .rpc('mahshar_agent_listing_stats', { p_api_ids: apiIds })

      if (callsError) {
        console.error('[discover] calls error:', callsError.message)
      } else {
        callStats = (calls ?? []) as CallStatsRow[]
      }
    }

    const statsMap = new Map<string, { total: number; successes: number; avgLatency: number | null }>()
    for (const c of callStats) {
      statsMap.set(c.api_id, {
        total: Number(c.total_calls),
        successes: Number(c.successful_calls),
        avgLatency: c.avg_latency_ms === null ? null : Number(c.avg_latency_ms),
      })
    }

    const apis = rows.flatMap(r => {
      let execution: ReturnType<typeof agentExecutionContract>
      try { execution = agentExecutionContract(r, publicOrigin) }
      catch (error) {
        console.error('[discover] excluded invalid listing contract:', r.id, error instanceof Error ? error.message : String(error))
        return []
      }
      const s = statsMap.get(r.id)
      const total_calls = s?.total ?? 0
      const success_rate = total_calls > 0 ? Math.round((s!.successes / total_calls) * 100) / 100 : null
      const avg_latency_ms = total_calls > 0 && s?.avgLatency !== null ? Math.round(s!.avgLatency!) : null

      let example_response: unknown = null
      if (r.example_response) {
        try {
          example_response = JSON.parse(r.example_response)
        } catch {
          example_response = r.example_response
        }
      }

      const auth = r.auth_type === 'public'
        ? { type: r.auth_type, injected_by: 'none', credential_location: null, seller_credentials_exposed: false }
        : r.auth_type === 'apikey'
          ? { type: r.auth_type, injected_by: 'mahshar', credential_location: 'header x-api-key', seller_credentials_exposed: false }
          : r.auth_type === 'bearer'
            ? { type: r.auth_type, injected_by: 'mahshar', credential_location: 'header Authorization: Bearer', seller_credentials_exposed: false }
            : { type: r.auth_type, injected_by: 'mahshar', credential_location: 'reserved upstream query parameter', seller_credentials_exposed: false }
      return [{
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        price_per_call_usdc: r.price_per_call,
        payment_model: 'x402-pay-per-call',
        auth,
        auth_type: r.auth_type,
        method: execution.method,
        score: r.score,
        verified: r.verified_at !== null,
        example_request: execution.request.example,
        example_response,
        total_calls,
        success_rate,
        avg_latency_ms,
        proxy_url: execution.proxy_url,
        proxy_style: execution.proxy_style,
        request: execution.request,
        response: execution.response,
      }]
    })

    return NextResponse.json({
      marketplace: 'Mahshar',
      description: 'AI-powered API marketplace with USDC nanopayments via x402 on Arc Mainnet',
      network: 'eip155:5042',
      networks: [
        {
          network: 'eip155:5042',
          label: 'Arc Mainnet',
          chainId: 5042,
          usdc_asset: '0x3600000000000000000000000000000000000000',
          payment_domain: {
            name: 'GatewayWalletBatched',
            version: '1',
            chainId: 5042,
            verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
          },
          gateway_api: 'https://gateway-api.circle.com',
        },
      ],
      network_note: 'All payment requirements and domains target Arc Mainnet only.',
      payment_protocol: 'x402',
      payment_recipient: paymentRecipient,
      contract_version: '2.2',
      openapi_url: `${publicOrigin}/api/openapi`,
      prerequisite: 'USDC must be pre-deposited into the Circle Gateway for the selected network before making payments. A raw EOA USDC balance is not accepted — the facilitator checks Circle Gateway balance, not the token contract. Use the matching entry in `networks` for the Gateway API and payment domain; production agents should select Arc Mainnet (`eip155:5042`).',
      payment_domain: {
        name: 'GatewayWalletBatched',
        version: '1',
        chainId: 5042,
        verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
      },
      proxy_urls: {
        envelope: `${publicOrigin}/api/proxy`,
        envelope_note: 'POST body carries {api_id, buyer_wallet, method?, path?, body?}. `path` carries only declared path segments and/or declared ordinary query input; `body` is forwarded only for POST, PUT, or DELETE. Used by the browser client.',
        path_template: `${publicOrigin}/api/proxy/{api_id}`,
        path_note: 'Fixed-path GET and POST listings only, using the configured method. Declared ordinary query inputs are appended to this URL. A method mismatch returns 405. POST JSON is parsed and re-serialized before forwarding. Buyer identity is the settled payment signer.',
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
      how_to_pay: 'Use the selected listing\'s proxy_url, proxy_style, request.outer_method, and request body contract. Probe without Payment-Signature; decode the base64 x402 v2 PAYMENT-REQUIRED header and choose eip155:5042. Sign TransferWithAuthorization using the advertised amount, payTo, asset and EIP-712 domain. Retry the byte-identical URL/body with Payment-Signature. A settled response includes standard PAYMENT-RESPONSE metadata plus payment, delivery_state, attemptId, and purchase_access_token in the JSON wrapper.',
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
        path_probe_template: 'curl -i -X <listing.method> <listing.proxy_url>',
        envelope_probe_template: `curl -i -X POST ${publicOrigin}/api/proxy -H 'content-type: application/json' -d '{"api_id":"<listing.id>","buyer_wallet":"0x<buyer>","method":"<listing.method>","body":{}}'`,
        note: 'Fill templates only from the selected listing metadata. Do not copy a hardcoded listing ID or method.',
      },
      settlement_response: {
        header: 'PAYMENT-RESPONSE',
        encoding: 'base64 JSON',
        schema: { success: true, payer: '<verified payer>', transaction: '<Circle settlement identity or empty string>', network: 'eip155:5042', amount: '<atomic USDC>' },
      },
      recovery: {
        delivery_states: ['NOT_STARTED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'UNKNOWN'],
        safe_retry: 'Replay the exact same Payment-Signature and request only when retryable is true. Mahshar never settles that authorization twice.',
        succeeded_replay: 'Returns delivery_state=SUCCEEDED and retrieve_response=/api/calls/last-response without executing upstream again.',
        purchase_access: { response_field: 'purchase_access_token', retrieval_header: 'x-mahshar-purchase-access', retrieval_route: '/api/calls/last-response' },
        legacy_purchase_access: 'An authenticated browser wallet session may exchange a historical owned purchase for a purchase capability.',
        accounting_reconcile: { route: '/api/payments/reconcile', authorization: 'browser wallet session', note: 'Finalizes durable accounting only; never resettles or executes upstream.' },
      },
      rate_limits: {
        discovery: { limit: 120, window_seconds: 60 },
        ai_match: { limit: 20, window_seconds: 60 },
        unpaid_probe_per_api: { limit: 120, window_seconds: 60 },
        payment_verification_per_api: { limit: 60, window_seconds: 60 },
        response: { status: 429, error: 'rate_limited', header: 'Retry-After' },
      },
      pagination: {
        limit: requestedLimit,
        offset: requestedOffset,
        returned: apis.length,
        next_offset: apis.length === requestedLimit ? requestedOffset + requestedLimit : null,
      },
      error_responses: {
        '402_no_payment': 'No Payment-Signature header was sent — the PAYMENT-REQUIRED response header contains base64-encoded payment instructions. This 402 has an empty JSON body {}.',
        '402_payment_failed': 'Payment verification failed before settlement. Use the machine-readable error field.',
        '409_delivery': 'Payment may already be accounted. Inspect delivery_state and retryable; never authorize a second payment for the same attempt.',
        '429': 'Rate limit exceeded. Honor Retry-After and retry_after_seconds.',
        '502': 'Upstream unreachable, response interrupted/oversized, or redirect rejected. Inspect delivery_state; only FAILED_RETRYABLE is safe to replay.',
        '503': 'Payment, accounting, delivery-state, or rate-limit persistence is unavailable.',
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
