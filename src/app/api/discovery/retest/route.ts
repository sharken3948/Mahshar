import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

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

  return NextResponse.json({ total_inactive: count ?? 0 });
});

export const POST = withAdmin(async (_request: NextRequest) =>
  NextResponse.json({ error: 'legacy_discovery_disabled' }, { status: 410 }));
