import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { proxyRequest } from '@/lib/proxy';
import { withAdmin } from '@/lib/admin-auth';
import { authorizeProxyTarget } from '@/lib/marketplace/proxy-target';

export const runtime = 'nodejs';

interface ActivateListing {
  id: string;
  endpoint_url: string;
  dynamic_path_supported?: boolean;
  path_parameters?: unknown[] | null;
  query_parameters?: unknown[] | null;
  auth_type?: string;
  auth_param_name?: string | null;
}

export const GET = withAdmin(async (request: NextRequest) => {

  const platformWallet = process.env.DISCOVERY_SELLER_WALLET;
  if (!platformWallet) {
    return NextResponse.json({ error: 'DISCOVERY_SELLER_WALLET not configured' }, { status: 500 });
  }

  const supabase = createServiceClient();

  const { count } = await supabase
    .from('api_listings')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet);

  return NextResponse.json({ total_pending_activation: count ?? 0 });
});

export const POST = withAdmin(async (request: NextRequest) => {

  const platformWallet = process.env.DISCOVERY_SELLER_WALLET;
  if (!platformWallet) {
    return NextResponse.json({ error: 'DISCOVERY_SELLER_WALLET not configured' }, { status: 500 });
  }

  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);

  const rawBatch = parseInt(searchParams.get('batch_size') ?? '2', 10);
  const batchSize = Math.min(Math.max(1, isFinite(rawBatch) ? rawBatch : 2), 4);

  const { data: batch } = await supabase
    .from('api_listings')
    .select('id, endpoint_url, dynamic_path_supported, path_parameters, query_parameters, auth_type, auth_param_name')
    .eq('source', 'discovery')
    .eq('is_active', false)
    .ilike('seller_wallet', platformWallet)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  const rows = (batch ?? []) as ActivateListing[];
  let tested = 0;
  let activated = 0;
  let removed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const listing = rows[i];
    tested++;

    // Probe while the row remains private. It is published only after a
    // successful canonical request has been durably logged.
    let ok = false;
    try {
      const canonicalTarget = authorizeProxyTarget(listing, '').toString();
      const result = await proxyRequest({
        apiId: listing.id,
        buyerWallet: platformWallet,
        paymentType: 'pay-per-call',
        method: 'GET',
        dynamicPath: '',
        canonicalTarget,
        incomingHeaders: {},
        requireActive: false,
      });
      ok = result.status >= 200 && result.status < 300;
    } catch {
      ok = false;
    }

    if (ok) {
      const { error: activationError } = await supabase
        .from('api_listings')
        .update({ is_active: true })
        .eq('id', listing.id)
        .eq('is_active', false);
      if (activationError) {
        failed++;
        continue;
      }
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

  return NextResponse.json({ tested, activated, removed, failed, remaining: remaining ?? 0 });
});
