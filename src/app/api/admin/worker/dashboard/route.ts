import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getWorkerDashboard, parseDashboardPage } from '@/lib/admin-worker/dashboard-repository'

export const runtime = 'nodejs'
export const GET = withAdmin(async (request: NextRequest) => {
  const page = parseDashboardPage(new URL(request.url))
  if (page === null) return NextResponse.json({ error: 'invalid_page' }, { status: 400 })
  try { return NextResponse.json(await getWorkerDashboard(page), { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch { return NextResponse.json({ error: 'worker_dashboard_unavailable' }, { status: 503 }) }
})
