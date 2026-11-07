import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { databaseStore } from '@/lib/free-api-worker/runtime'

export const runtime = 'nodejs'

export const POST = withAdmin(async request => {
  try {
    const body = await request.json() as { ids?: unknown }
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))].slice(0, 25)
      : []
    if (!ids.length) return NextResponse.json({ error: 'invalid_candidates' }, { status: 400 })
    const store = await databaseStore()
    return NextResponse.json({ candidates: await store.candidateDetails(ids) })
  } catch { return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 }) }
})
