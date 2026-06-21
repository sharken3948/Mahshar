import { NextRequest, NextResponse } from 'next/server';
import { matchApis } from '@/lib/groq';
import { createServiceClient } from '@/lib/supabase/server';
import type { ApiListing } from '@/types';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json() as { query: string };
  const { query } = body;

  if (!query) {
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
    .select('id, name, description, category, price_per_call, payment_model, score, uptime, example_request')
    .in('id', matchResult.api_ids);

  return NextResponse.json({ apis: matched, reasoning: matchResult.reasoning });
}
