import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { databaseStore } from '@/lib/free-api-worker/runtime'
import { summary, usableCandidates } from '@/lib/free-api-worker/model'

export const runtime = 'nodejs'
export const GET = withAdmin(async request => {
  const params = new URL(request.url).searchParams
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1') || 1)
  const view = params.get('view') ?? 'usable'
  const search = (params.get('q') ?? '').slice(0, 100).toLowerCase()
  try {
    const store = await databaseStore()
    const [state, all] = await Promise.all([store.state(), store.candidates()])
    const rows = (view === 'usable' ? usableCandidates(all) : all.filter(row => !row.removedAt)).filter(row => (row.lead.name + ' ' + row.lead.providerId).toLowerCase().includes(search))
    return NextResponse.json({ state, summary: summary(all), total: rows.length, page,
      progress: { total: all.length, completed: all.filter(row => row.completedAt).length,
        unfinished: all.filter(row => !row.completedAt && !row.removedAt).length,
        active: all.filter(row => row.leaseUntil && Date.parse(row.leaseUntil) > Date.now()).length, batchSize: 50 },
      nextRetry: all.flatMap(row => !row.completedAt && !row.removedAt && row.retryAt ? [row.retryAt] : []).sort()[0] ?? null,
      candidates: rows.slice((page - 1) * 25, page * 25), pageSize: 25 })
  } catch { return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 }) }
})
