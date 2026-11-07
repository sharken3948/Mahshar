import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { databaseStore } from '@/lib/free-api-worker/runtime'

export const runtime = 'nodejs'
export const GET = withAdmin(async request => {
  const params = new URL(request.url).searchParams
  const page = Math.min(100_000, Math.max(1, Number.parseInt(params.get('page') ?? '1') || 1))
  const requestedView = params.get('view')
  const view = requestedView === 'failed' || requestedView === 'all' ? requestedView : 'usable'
  const search = (params.get('q') ?? '').trim().slice(0, 100)
  const stateDetails = params.get('stateDetails') === 'true'
  try {
    const store = await databaseStore()
    const [state, result] = await Promise.all([
      store.adminState(stateDetails),
      store.candidatePage({ view, search, page, pageSize: 25 }),
    ])
    return NextResponse.json({ state, ...result })
  } catch { return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 }) }
})
