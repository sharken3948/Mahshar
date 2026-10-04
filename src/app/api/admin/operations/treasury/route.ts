import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getPlatformTreasuryBalance } from '@/lib/admin/treasury-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getPlatformTreasuryBalance()) }
  catch { return NextResponse.json({ error: 'treasury_balance_unavailable' }, { status: 503 }) }
})
