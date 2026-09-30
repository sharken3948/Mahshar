import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getSettlementSnapshot } from '@/lib/admin/operations-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getSettlementSnapshot()) }
  catch { return NextResponse.json({ error: 'settlement_snapshot_unavailable' }, { status: 503 }) }
})
