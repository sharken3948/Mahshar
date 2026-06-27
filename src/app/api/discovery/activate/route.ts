import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { proxyRequest } from '@/lib/proxy';

export const runtime = 'nodejs';

interface ActivateListing {
  id: string;
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

  return NextResponse.json({ total_pending_activation: count ?? 0 });
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

  const rawBatch = parseInt(searchParams.get('batch_size') ?? '2', 10);
  const batchSize = Math.min(Math.max(1, isFinite(rawBatch) ? rawBatch : 2), 4);

  const { data: batch } = await supabase
    .from('api_listings')
    .select('id')
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  const rows = (batch ?? []) as ActivateListing[];
  let tested = 0;
  let activated = 0;
  let removed = 0;

  for (let i = 0; i < rows.length; i++) {
    const listing = rows[i];
    tested++;

    // Pre-activate so proxyRequest can find it
    await supabase
      .from('api_listings')
      .update({ is_active: true })
      .eq('id', listing.id);

    // Test via proxy
    let ok = false;
    try {
      const result = await proxyRequest({
        apiId: listing.id,
        buyerWallet: platformWallet,
        paymentType: 'pay-per-call',
        method: 'GET',
        path: '/',
        incomingHeaders: {},
      });
      ok = result.status >= 200 && result.status < 300;
    } catch {
      ok = false;
    }

    if (ok) {
      activated++;
    } else {
      // Null the FK before deleting to avoid constraint violation
      await supabase
        .from('crawl_queue')
        .update({ listing_id: null })
        .eq('listing_id', listing.id);
      await supabase
        .from('api_listings')
        .delete()
        .eq('id', listing.id);
      removed++;
    }

    if (i < rows.length - 1) await new Promise<void>(r => setTimeout(r, 10000));
  }

  const { count: remaining } = await supabase
    .from('api_listings')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet);

  return NextResponse.json({ tested, activated, removed, remaining: remaining ?? 0 });
}
