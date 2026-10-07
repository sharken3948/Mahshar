import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getOutreachDashboard } from '@/lib/admin-outreach/repository'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getOutreachDashboard()) }
  catch (error) {
    console.error('[admin-outreach] dashboard unavailable', error)
    return NextResponse.json({ error: 'admin_outreach_unavailable' }, { status: 503 })
  }
})
