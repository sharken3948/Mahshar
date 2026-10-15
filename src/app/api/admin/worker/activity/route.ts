import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getWorkerActivity, parseActivityCursor } from '@/lib/admin-worker/activity-repository'

export const runtime = 'nodejs'
export const GET = withAdmin(async (request: NextRequest) => {
  const cursor = parseActivityCursor(new URL(request.url))
  const providerId = new URL(request.url).searchParams.get('provider') ?? undefined
  if (cursor === undefined) return NextResponse.json({ error: 'invalid_activity_cursor' }, { status: 400 })
  if (providerId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(providerId)) return NextResponse.json({ error: 'invalid_provider' }, { status: 400 })
  try { return NextResponse.json(await getWorkerActivity(cursor, 25, undefined, providerId), { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch { return NextResponse.json({ error: 'worker_activity_unavailable' }, { status: 503 }) }
})
