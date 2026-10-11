import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export const POST = withAdmin(async (_request: NextRequest) =>
  NextResponse.json({ error: 'legacy_discovery_disabled' }, { status: 410 }));
