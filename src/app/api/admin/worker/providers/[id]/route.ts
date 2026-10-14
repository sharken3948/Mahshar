import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getWorkerProviderDetail, parseDashboardPage } from '@/lib/admin-worker/dashboard-repository'

export const runtime = 'nodejs'
export const GET = withAdmin(async (request: NextRequest) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const page = parseDashboardPage(new URL(request.url))
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || page === null) return NextResponse.json({ error: 'invalid_provider' }, { status: 400 })
  try {
    const detail = await getWorkerProviderDetail(id, page)
    return detail ? NextResponse.json(detail, { headers: { 'Cache-Control': 'private, no-store' } }) : NextResponse.json({ error: 'provider_not_found' }, { status: 404 })
  } catch { return NextResponse.json({ error: 'worker_provider_unavailable' }, { status: 503 }) }
})
