import { NextRequest, NextResponse } from 'next/server';
import { matchApis } from '@/lib/groq';
import { createServiceClient } from '@/lib/supabase/server';
import type { ApiListing } from '@/types';
import { enforceRateLimit } from '@/lib/rate-limit';
import { agentExecutionContract, type AgentListingRow } from '@/lib/marketplace/agent-contract';
import { marketplaceOrigin } from '@/lib/marketplace/server';
import { readBoundedJson, RequestBodyError } from '@/lib/request-body';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit({ request, scope: 'ai-match', limit: 20, windowSeconds: 60, failClosed: true })
  if (limited) return limited
  let body: { query: string };
  try { body = await readBoundedJson<{ query: string }>(request, 16 * 1024) }
  catch (error) {
    const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
    return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' }, { status: tooLarge ? 413 : 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  const { query } = body;

  if (typeof query !== 'string' || !query.trim() || query.length > 2000) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: apis, error } = await supabase
    .from('api_listings')
    .select('id, name, description, category')
    .eq('is_active', true)
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let matchResult
  try {
    matchResult = await matchApis(query, apis as Pick<ApiListing, 'id' | 'name' | 'description' | 'category'>[])
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const { data: matched } = await supabase
    .from('api_listings')
    .select('id, name, description, category, price_per_call, payment_model, score, uptime, auth_type, method, example_request, example_response, request_schema, response_schema, body_required, dynamic_path_supported, path_parameters, query_parameters')
    .in('id', matchResult.api_ids)
    .eq('is_active', true);

  const publicOrigin = marketplaceOrigin()
  const safeMatched = ((matched ?? []) as unknown as Array<AgentListingRow & Record<string, unknown>>).map(row => {
    const execution = agentExecutionContract(row, publicOrigin)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      price_per_call_usdc: row.price_per_call,
      payment_model: 'x402-pay-per-call',
      score: row.score,
      uptime: row.uptime,
      auth: { type: row.auth_type, injected_by: 'mahshar', seller_credentials_exposed: false },
      method: execution.method,
      proxy_url: execution.proxy_url,
      proxy_style: execution.proxy_style,
      request: execution.request,
      response: execution.response,
    }
  })

  return NextResponse.json({
    contract_version: '2.1',
    discovery_url: `${publicOrigin}/api/agent/discover`,
    openapi_url: `${publicOrigin}/api/openapi`,
    network: 'eip155:5042',
    payment_protocol: 'x402',
    apis: safeMatched,
    reasoning: matchResult.reasoning,
  });
}
