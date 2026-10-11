import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export const GET = withAdmin(async (request: NextRequest) => {

  const supabase = createServiceClient();
  const { data } = await supabase
    .from('discovered_apis')
    .select('id, api_name, owner_github, owner_email, owner_x, invited, created_at')
    .order('created_at', { ascending: false });
  return NextResponse.json({ apis: data ?? [] });
});

export const POST = withAdmin(async (_request: NextRequest) =>
  NextResponse.json({ error: 'legacy_discovery_disabled' }, { status: 410 }));
