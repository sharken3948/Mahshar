import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

interface CrawlQueueRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  endpoint_url: string;
  auth: string | null;
  status: string;
  score: number | null;
  reject_reason: string | null;
  created_at: string;
  api_docs_url: string | null;
  source_name: string | null;
}

export const GET = withAdmin(async (request: NextRequest) => {

  const supabase = createServiceClient();

  const { data } = await supabase
    .from('crawl_queue')
    .select('id, name, endpoint_url, status, score, reject_reason, created_at, source_name')
    .order('created_at', { ascending: false });

  const rows = (data ?? []) as Pick<
    CrawlQueueRow,
    'id' | 'name' | 'endpoint_url' | 'status' | 'score' | 'reject_reason' | 'created_at' | 'source_name'
  >[];

  const by_source: Record<string, number> = {};
  for (const r of rows) {
    const key = r.source_name ?? 'unknown';
    by_source[key] = (by_source[key] ?? 0) + 1;
  }

  const stats = {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    listed: rows.filter(r => r.status === 'listed').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
    by_source,
  };

  return NextResponse.json({ stats, rows: rows.slice(0, 20) });
});

export const POST = withAdmin(async (_request: NextRequest) =>
  NextResponse.json({ error: 'legacy_discovery_disabled' }, { status: 410 }));
