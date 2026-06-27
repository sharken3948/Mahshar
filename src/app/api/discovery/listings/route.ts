import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

interface RawListing {
  id: string;
  name: string;
  description: string;
  category: string;
  price_per_call: number;
  is_active: boolean;
  score: number | null;
  seller_wallet: string;
  endpoint_url: string;
  method: string | null;
  source: string;
  hourly_limit: number | null;
  latency_ms: number | null;
  created_at: string;
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
  const { searchParams } = new URL(request.url);

  const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Math.max(1, isFinite(rawPage) ? rawPage : 1);
  const rawPageSize = parseInt(searchParams.get('page_size') ?? '20', 10);
  const pageSize = Math.min(20, Math.max(1, isFinite(rawPageSize) ? rawPageSize : 20));
  const search = searchParams.get('search') ?? '';
  const category = searchParams.get('category') ?? '';
  const status = searchParams.get('status') ?? '';

  // Unfiltered summary — all discovery listings for this platform
  const { data: allRows } = await supabase
    .from('api_listings')
    .select('id, is_active, category')
    .eq('source', 'discovery')
    .ilike('seller_wallet', platformWallet);

  const allListings = (allRows ?? []) as { id: string; is_active: boolean; category: string }[];
  const allIds = allListings.map(r => r.id);

  const summary = {
    total_all: allListings.length,
    active: allListings.filter(r => r.is_active).length,
    inactive: allListings.filter(r => !r.is_active).length,
    total_calls: 0,
  };

  const categories = Array.from(
    new Set(allListings.map(r => r.category).filter(Boolean)),
  ).sort() as string[];

  if (allIds.length > 0) {
    const { count: callCount } = await supabase
      .from('api_calls')
      .select('id', { count: 'exact', head: true })
      .in('api_id', allIds);
    summary.total_calls = callCount ?? 0;
  }

  // Filtered + paginated query
  let query = supabase
    .from('api_listings')
    .select(
      'id, name, description, category, price_per_call, is_active, score, seller_wallet, endpoint_url, method, source, hourly_limit, latency_ms, created_at',
      { count: 'exact' },
    )
    .eq('source', 'discovery')
    .ilike('seller_wallet', platformWallet)
    .order('created_at', { ascending: false });

  if (search) query = query.ilike('name', `%${search}%`);
  if (category) query = query.eq('category', category);
  if (status === 'active') query = query.eq('is_active', true);
  if (status === 'inactive') query = query.eq('is_active', false);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: listings, count: total, error } = await query.range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pageRows = (listings ?? []) as RawListing[];
  const pageIds = pageRows.map(l => l.id);

  // Crawl queue join for api_docs_url / source_name
  const crawlMap: Record<string, { api_docs_url: string | null; source_name: string | null }> = {};
  if (pageIds.length > 0) {
    const { data: crawlRows } = await supabase
      .from('crawl_queue')
      .select('listing_id, api_docs_url, source_name')
      .in('listing_id', pageIds);
    for (const row of (crawlRows ?? []) as Array<{
      listing_id: string;
      api_docs_url: string | null;
      source_name: string | null;
    }>) {
      if (row.listing_id) {
        crawlMap[row.listing_id] = { api_docs_url: row.api_docs_url, source_name: row.source_name };
      }
    }
  }

  // Call stats for paginated listings
  const callStats: Record<string, { total: number; successful: number }> = {};
  if (pageIds.length > 0) {
    const { data: calls } = await supabase
      .from('api_calls')
      .select('api_id, success')
      .in('api_id', pageIds);
    for (const call of (calls ?? []) as { api_id: string; success: boolean }[]) {
      if (!callStats[call.api_id]) callStats[call.api_id] = { total: 0, successful: 0 };
      callStats[call.api_id].total++;
      if (call.success) callStats[call.api_id].successful++;
    }
  }

  const result = pageRows.map(l => ({
    ...l,
    api_docs_url: crawlMap[l.id]?.api_docs_url ?? null,
    source_name: crawlMap[l.id]?.source_name ?? null,
    total_calls: callStats[l.id]?.total ?? 0,
    successful_calls: callStats[l.id]?.successful ?? 0,
  }));

  return NextResponse.json({
    listings: result,
    total: total ?? 0,
    page,
    page_size: pageSize,
    summary,
    categories,
  });
}
