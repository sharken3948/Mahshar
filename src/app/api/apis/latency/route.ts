import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('api_calls')
    .select('api_id, latency_ms');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sums: Record<string, { sum: number; count: number }> = {};
  for (const row of data ?? []) {
    if (!sums[row.api_id]) sums[row.api_id] = { sum: 0, count: 0 };
    sums[row.api_id].sum += row.latency_ms;
    sums[row.api_id].count += 1;
  }

  const latencies: Record<string, number> = {};
  for (const [api_id, { sum, count }] of Object.entries(sums)) {
    latencies[api_id] = Math.round(sum / count);
  }

  return NextResponse.json({ latencies });
}
