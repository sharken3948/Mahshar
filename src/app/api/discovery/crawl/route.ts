import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchPublicApis } from '@/lib/crawler';
import { scoreForDiscovery, isSafeUrl } from '@/lib/discovery';

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

export async function GET(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && request.headers.get('x-admin-key') !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
}

export async function POST(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && request.headers.get('x-admin-key') !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);

  const rawBatch = parseInt(searchParams.get('batch_size') ?? '2', 10);
  const batchSize = Math.min(Math.max(1, isFinite(rawBatch) ? rawBatch : 2), 10);
  const rawOffset = parseInt(searchParams.get('offset') ?? '0', 10);
  const offset = Math.max(0, isFinite(rawOffset) ? rawOffset : 0);

  const platformWallet = process.env.PLATFORM_WALLET;
  if (!platformWallet) {
    return NextResponse.json({ error: 'PLATFORM_WALLET not configured' }, { status: 500 });
  }

  // Seed the queue if there are no pending rows
  const { count: pendingCount } = await supabase
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  if ((pendingCount ?? 0) === 0) {
    try {
      const entries = await fetchPublicApis();
      const seedRows = entries.map(a => ({
        name: a.name,
        description: a.description,
        category: a.category,
        endpoint_url: a.link,
        auth: a.auth,
        https: a.https,
        cors: a.cors,
        status: 'pending',
        api_docs_url: a.api_docs_url,
        source_name: a.source_name,
      }));
      await supabase
        .from('crawl_queue')
        .upsert(seedRows, { onConflict: 'endpoint_url', ignoreDuplicates: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Seed failed: ${msg}` }, { status: 502 });
    }
  }

  // Fetch batch of pending rows
  const { data: batch } = await supabase
    .from('crawl_queue')
    .select('id, name, description, category, endpoint_url, auth, status, score, reject_reason, created_at, api_docs_url, source_name')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .range(offset, offset + batchSize - 1);

  const rows = (batch ?? []) as CrawlQueueRow[];
  let listed = 0;
  let rejected = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let finalStatus = 'rejected';
    let rejectReason: string | null = null;
    let rowScore: number | null = null;
    let listingId: string | null = null;

    // Check 1: auth required — skip without network call
    const auth = (row.auth ?? '').trim();
    if (auth && auth !== 'No') {
      console.log(`[crawl:skip] auth_required — name="${row.name}" url="${row.endpoint_url}" auth="${auth}"`);
      rejectReason = 'auth_required';
      skipped++;
      await supabase
        .from('crawl_queue')
        .update({ status: finalStatus, reject_reason: rejectReason })
        .eq('id', row.id);
      if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
      continue;
    }

    // Check 2: URL safety (HTTPS only, no private/loopback IPs)
    if (!isSafeUrl(row.endpoint_url)) {
      console.log(`[crawl:skip] unsafe_url — name="${row.name}" url="${row.endpoint_url}"`);
      rejectReason = 'unsafe_url';
      skipped++;
      await supabase
        .from('crawl_queue')
        .update({ status: finalStatus, reject_reason: rejectReason })
        .eq('id', row.id);
      if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
      continue;
    }

    // Check 3: live GET test (5s timeout)
    let liveOk = false;
    let latencyMs: number | null = null;
    const liveStart = Date.now();
    try {
      const liveRes = await fetch(row.endpoint_url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      latencyMs = Date.now() - liveStart;
      liveOk = liveRes.status >= 200 && liveRes.status < 300;
    } catch {
      liveOk = false;
    }

    if (!liveOk) {
      rejectReason = 'live_test_failed';
      rejected++;
      await supabase
        .from('crawl_queue')
        .update({ status: finalStatus, reject_reason: rejectReason })
        .eq('id', row.id);
      if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
      continue;
    }

    // Check 4: Groq quality score — retry once after 30s on 429 (free-tier rate limit)
    let scoreResult: { score: number; reason: string };
    try {
      scoreResult = await scoreForDiscovery(row.name, row.description ?? '');
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 429) {
        console.log(`[crawl:429] backing off 30s — name="${row.name}"`);
        await new Promise<void>(r => setTimeout(r, 30000));
        try {
          scoreResult = await scoreForDiscovery(row.name, row.description ?? '');
        } catch {
          rejectReason = 'score_error';
          rejected++;
          await supabase
            .from('crawl_queue')
            .update({ status: finalStatus, reject_reason: rejectReason })
            .eq('id', row.id);
          if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
          continue;
        }
      } else {
        rejectReason = 'score_error';
        rejected++;
        await supabase
          .from('crawl_queue')
          .update({ status: finalStatus, reject_reason: rejectReason })
          .eq('id', row.id);
        if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
        continue;
      }
    }

    rowScore = scoreResult.score;

    if (scoreResult.score < 6) {
      rejectReason = `score_too_low: ${scoreResult.reason}`;
      rejected++;
      await supabase
        .from('crawl_queue')
        .update({ status: finalStatus, score: rowScore, reject_reason: rejectReason })
        .eq('id', row.id);
      if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
      continue;
    }

    // All checks passed — insert into api_listings (inactive until activated)
    const { data: listing } = await supabase
      .from('api_listings')
      .insert({
        name: row.name,
        description: row.description ?? '',
        category: row.category ?? 'Other',
        price_per_call: 0.001,
        payment_model: 'pay-per-call',
        seller_wallet: platformWallet.toLowerCase(),
        auth_type: 'public',
        endpoint_url: row.endpoint_url,
        method: 'GET',
        source: 'discovery',
        hourly_limit: 50,
        is_active: false,
        latency_ms: latencyMs,
        score: rowScore,
      })
      .select('id')
      .single<{ id: string }>();

    if (listing?.id) {
      listingId = listing.id;
      finalStatus = 'listed';
      listed++;
    } else {
      rejectReason = 'insert_failed';
      rejected++;
    }

    await supabase
      .from('crawl_queue')
      .update({ status: finalStatus, score: rowScore, reject_reason: rejectReason, listing_id: listingId })
      .eq('id', row.id);

    if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 500));
  }

  const { count: totalPending } = await supabase
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  return NextResponse.json({
    processed: rows.length,
    listed,
    rejected,
    skipped,
    next_offset: offset + batchSize,
    total_pending: totalPending ?? 0,
  });
}
