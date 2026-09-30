import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getSystemHealth } from '@/lib/admin/system-health-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getSystemHealth()) }
  catch { return NextResponse.json({ error: 'system_health_unavailable' }, { status: 503 }) }
})
