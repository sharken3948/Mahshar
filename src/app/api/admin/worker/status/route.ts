import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getWorkerStatus } from '@/lib/admin-worker/repository'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getWorkerStatus()) }
  catch (error) {
    console.error('[admin-worker] status unavailable', error)
    return NextResponse.json({ error: 'worker_status_unavailable' }, { status: 503 })
  }
})

