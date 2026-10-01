import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getWorkerRuns, parseWorkerRunsLimit } from '@/lib/admin-worker/repository'

export const runtime = 'nodejs'

export const GET = withAdmin(async (request: NextRequest) => {
  const limit = parseWorkerRunsLimit(new URL(request.url))
  if (limit === null) return NextResponse.json({ error: 'invalid_limit' }, { status: 400 })
  try { return NextResponse.json(await getWorkerRuns(limit)) }
  catch (error) {
    console.error('[admin-worker] runs unavailable', error)
    return NextResponse.json({ error: 'worker_runs_unavailable' }, { status: 503 })
  }
})
