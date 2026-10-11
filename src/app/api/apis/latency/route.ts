import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { validateListingRequestContract } from '@/lib/marketplace/request-contract';

export const runtime = 'nodejs';

const LISTING_PAGE_SIZE = 100;
// Match the existing Agent discovery pagination envelope: 101 pages of at most
// 100 listings. A separate one-row sentinel detects inventory beyond this bound.
const MAX_ACTIVE_LISTINGS = 10_100;
const PUBLIC_ELIGIBILITY_COLUMNS = [
  'id',
  'endpoint_url',
  'auth_type',
  'auth_param_name',
  'method',
  'example_request',
  'request_schema',
  'body_required',
  'dynamic_path_supported',
  'path_parameters',
  'query_parameters',
].join(', ');

type Database = ReturnType<typeof createServiceClient>;
type ListingRow = Parameters<typeof validateListingRequestContract>[0] & { id: string };
type ListingStatsRow = { api_id: string; avg_latency_ms: number | string | null };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unavailable() {
  return NextResponse.json({ error: 'Failed to fetch latency statistics' }, { status: 500 });
}

async function addPageLatencies(database: Database, rows: ListingRow[], latencies: Record<string, number>) {
  const apiIds = rows
    .filter(row => validateListingRequestContract(row).ok)
    .map(row => row.id);

  if (apiIds.length === 0) return true;

  const { data, error } = await database.rpc('mahshar_agent_listing_stats', { p_api_ids: apiIds });
  if (error) return false;

  const eligible = new Set(apiIds);
  for (const row of (data ?? []) as ListingStatsRow[]) {
    if (!eligible.has(row.api_id) || row.avg_latency_ms === null) continue;
    const average = Number(row.avg_latency_ms);
    if (Number.isFinite(average)) latencies[row.api_id] = Math.round(average);
  }
  return true;
}

async function latencyResponse(database: Database = createServiceClient()) {
  const latencies: Record<string, number> = {};
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let listingCount = 0;

  while (listingCount < MAX_ACTIVE_LISTINGS) {
    let query = database
      .from('api_listings')
      .select(PUBLIC_ELIGIBILITY_COLUMNS)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .limit(LISTING_PAGE_SIZE);
    if (cursor !== null) query = query.gt('id', cursor);

    const { data, error } = await query;
    if (error) return unavailable();
    const rows = (data ?? []) as unknown as ListingRow[];
    if (rows.length > LISTING_PAGE_SIZE) return unavailable();
    if (rows.length === 0) return NextResponse.json({ latencies });

    for (const row of rows) {
      if (!UUID_PATTERN.test(row.id) || seenIds.has(row.id)) return unavailable();
      seenIds.add(row.id);
    }

    if (!await addPageLatencies(database, rows, latencies)) return unavailable();
    listingCount += rows.length;
    if (rows.length < LISTING_PAGE_SIZE) return NextResponse.json({ latencies });

    const nextCursor = rows[rows.length - 1].id;
    if (nextCursor === cursor) return unavailable();
    cursor = nextCursor;
  }

  const { data: sentinel, error: sentinelError } = await database
    .from('api_listings')
    .select('id')
    .eq('is_active', true)
    .gt('id', cursor!)
    .order('id', { ascending: true })
    .limit(1);
  if (sentinelError || (sentinel?.length ?? 0) > 0) return unavailable();

  return NextResponse.json({ latencies });
}

export async function GET() {
  return latencyResponse();
}
