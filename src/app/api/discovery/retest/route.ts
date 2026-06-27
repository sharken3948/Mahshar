import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { scoreForDiscovery, isSafeUrl } from '@/lib/discovery';

export const runtime = 'nodejs';

interface RetestListing {
  id: string;
  name: string;
  description: string | null;
  endpoint_url: string;
}

export async function GET(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && request.headers.get('x-admin-key') !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const platformWallet = process.env.PLATFORM_WALLET;
  if (!platformWallet) {
    return NextResponse.json({ error: 'PLATFORM_WALLET not configured' }, { status: 500 });
  }

  const supabase = createServiceClient();

  const { count } = await supabase
    .from('api_listings')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet);

  return NextResponse.json({ total_inactive: count ?? 0 });
}

export async function POST(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && request.headers.get('x-admin-key') !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const platformWallet = process.env.PLATFORM_WALLET;
  if (!platformWallet) {
    return NextResponse.json({ error: 'PLATFORM_WALLET not configured' }, { status: 500 });
  }

  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);

  const rawBatch = parseInt(searchParams.get('batch_size') ?? '10', 10);
  const batchSize = Math.min(Math.max(1, isFinite(rawBatch) ? rawBatch : 10), 20);

  const { data: batch } = await supabase
    .from('api_listings')
    .select('id, name, description, endpoint_url')
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  const rows = (batch ?? []) as RetestListing[];
  let tested = 0;
  let reactivated = 0;

  for (const listing of rows) {
    tested++;

    // Safety check before fetching
    if (!isSafeUrl(listing.endpoint_url)) continue;

    // Check 1: live GET test (5s timeout)
    let liveOk = false;
    try {
      const liveRes = await fetch(listing.endpoint_url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      liveOk = liveRes.status >= 200 && liveRes.status < 300;
    } catch {
      liveOk = false;
    }

    if (!liveOk) continue;

    // Check 2: AI quality score
    let scoreResult: { score: number; reason: string };
    try {
      scoreResult = await scoreForDiscovery(listing.name, listing.description ?? '');
    } catch {
      continue;
    }

    if (scoreResult.score < 6) continue;

    // Both checks passed — reactivate
    await supabase
      .from('api_listings')
      .update({ is_active: true })
      .eq('id', listing.id);

    reactivated++;
  }

  const { count: remaining } = await supabase
    .from('api_listings')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet);

  return NextResponse.json({
    tested,
    reactivated,
    still_inactive: tested - reactivated,
    remaining: remaining ?? 0,
  });
}
