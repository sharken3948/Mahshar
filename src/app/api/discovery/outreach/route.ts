import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withAdmin } from '@/lib/admin-auth';
import { marketplaceOrigin } from '@/lib/marketplace/server';

export const runtime = 'nodejs';

interface DiscoveredApiRow {
  id: string;
  api_name: string | null;
  owner_github: string | null;
  owner_email: string;
}

export const POST = withAdmin(async (request: NextRequest) => {

  if (process.env.MAINNET_MODE !== 'true') {
    return NextResponse.json(
      { error: 'Outreach is disabled until mainnet launch. Set MAINNET_MODE=true to enable.' },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) return NextResponse.json({ error: 'Email delivery is not configured' }, { status: 503 });
  const origin = marketplaceOrigin();

  const { data: candidates } = await supabase
    .from('discovered_apis')
    .select('id, api_name, owner_github, owner_email')
    .eq('invited', false)
    .not('owner_email', 'is', null);

  const rows = (candidates ?? []) as DiscoveredApiRow[];
  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.owner_email) {
      skipped++;
      continue;
    }

    const subject = 'List your API on Mahshar and earn USDC per call';
    const html = [
      `<p>Hi ${row.owner_github ?? 'there'},</p>`,
      `<p>I came across <strong>${row.api_name ?? 'your API'}</strong> on GitHub and wanted to reach out.</p>`,
      `<p>We&rsquo;re building <a href="${origin}">Mahshar</a>, an API marketplace where `,
      `developers monetize their APIs and get paid in USDC for every call &mdash; `,
      `no subscriptions, no contracts, pure pay-per-call.</p>`,
      `<p>You keep full control of your API. Buyers pay per request and you receive USDC `,
      `directly to your wallet.</p>`,
      `<p>Listing takes about 5 minutes: <a href="${origin}/seller">${origin}/seller</a></p>`,
      `<p>Happy to answer any questions.</p>`,
      `<p>Best,<br/>The Mahshar Team</p>`,
    ].join('');

    let emailSent = false;

    {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'api-key': brevoKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Mahshar', email: 'support@mahshar.xyz' },
          to: [{ email: row.owner_email }],
          subject,
          htmlContent: html,
        }),
        signal: AbortSignal.timeout(15000),
      });
      emailSent = res.ok;
    }

    if (emailSent) {
      await supabase
        .from('discovered_apis')
        .update({ invited: true, invited_at: new Date().toISOString() })
        .eq('id', row.id);
      await supabase.from('outreach_log').insert({
        discovered_api_id: row.id,
        email: row.owner_email,
        status: 'sent',
      });
      sent++;
    } else {
      skipped++;
    }
  }

  return NextResponse.json({ sent, skipped });
});
