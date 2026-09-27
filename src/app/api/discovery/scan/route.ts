import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchPaidApis } from '@/lib/crawler';
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

export const POST = withAdmin(async (request: NextRequest) => {

  const supabase = createServiceClient();

  let apis;
  try {
    apis = await fetchPaidApis();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  console.log('[scan] fetchPaidApis returned:', apis.length);

  if (apis.length === 0) {
    return NextResponse.json({ new: 0, existing: 0 });
  }

  const repoUrls = apis.map(a => a.repo_url);
  const { data: existing } = await supabase
    .from('discovered_apis')
    .select('repo_url')
    .in('repo_url', repoUrls);

  const existingUrls = new Set((existing ?? []).map(e => (e as { repo_url: string }).repo_url));
  const newApis = apis.filter(a => !existingUrls.has(a.repo_url));

  console.log('[scan] new entries to insert:', newApis.length);

  if (newApis.length > 0) {
    const { error: insertError } = await supabase.from('discovered_apis').upsert(
      newApis.map(a => ({
        repo_url: a.repo_url,
        api_name: a.api_name,
        owner_github: a.owner_github,
        owner_email: a.owner_email,
        owner_x: a.owner_x,
      })),
      { onConflict: 'repo_url', ignoreDuplicates: true },
    );
    console.log('[scan] insert result:', insertError);
  }

  return NextResponse.json({ new: newApis.length, existing: existingUrls.size });
});
