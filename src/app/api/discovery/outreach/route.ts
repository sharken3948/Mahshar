import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

interface DiscoveredApiRow {
  id: string;
  api_name: string | null;
  owner_github: string | null;
  owner_email: string;
}

export async function POST(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && request.headers.get('x-admin-key') !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (process.env.MAINNET_MODE !== 'true') {
    return NextResponse.json(
      { error: 'Outreach is disabled until mainnet launch. Set MAINNET_MODE=true to enable.' },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();

  const { data: candidates } = await supabase
    .from('discovered_apis')
    .select('id, api_name, owner_github, owner_email')
    .eq('invited', false)
    .not('owner_email', 'is', null);

  const rows = (candidates ?? []) as DiscoveredApiRow[];
  let sent = 0;
  let skipped = 0;

  const resendKey = process.env.RESEND_API_KEY;

  for (const row of rows) {
    if (!row.owner_email) {
      skipped++;
      continue;
    }

    const subject = 'List your API on Mahshar and earn USDC per call';
    const html = [
      `<p>Hi ${row.owner_github ?? 'there'},</p>`,
      `<p>I came across <strong>${row.api_name ?? 'your API'}</strong> on GitHub and wanted to reach out.</p>`,
      `<p>We&rsquo;re building <a href="https://mahshar.xyz">Mahshar</a>, an API marketplace where `,
      `developers monetize their APIs and get paid in USDC for every call &mdash; `,
      `no subscriptions, no contracts, pure pay-per-call.</p>`,
      `<p>You keep full control of your API. Buyers pay per request and you receive USDC `,
      `directly to your wallet.</p>`,
      `<p>Listing takes about 5 minutes: <a href="https://mahshar.xyz/seller">mahshar.xyz/seller</a></p>`,
      `<p>Happy to answer any questions.</p>`,
      `<p>Best,<br/>The Mahshar Team</p>`,
    ].join('');

    let emailSent = false;

    if (resendKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Mahshar <noreply@mahshar.xyz>',
          to: [row.owner_email],
          subject,
          html,
        }),
        signal: AbortSignal.timeout(15000),
      });
      emailSent = res.ok;
    } else {
      console.log(`[outreach] Would send to ${row.owner_email} — subject: "${subject}"`);
      emailSent = true;
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
}
