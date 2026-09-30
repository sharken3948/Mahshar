import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getRecentPayments } from '@/lib/admin/operations-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getRecentPayments()) }
  catch { return NextResponse.json({ error: 'recent_payments_unavailable' }, { status: 503 }) }
})
