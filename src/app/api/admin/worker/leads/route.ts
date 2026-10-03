import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getQualifiedWorkerLeads, parseWorkerLeadsLimit } from '@/lib/admin-worker/repository'

export const runtime = 'nodejs'

export const GET = withAdmin(async (request: NextRequest) => {
  const limit = parseWorkerLeadsLimit(new URL(request.url))
  if (limit === null) return NextResponse.json({ error: 'invalid_limit' }, { status: 400 })
  try { return NextResponse.json(await getQualifiedWorkerLeads(limit)) }
  catch (error) {
    console.error('[admin-worker] qualified leads unavailable', error)
    return NextResponse.json({ error: 'worker_leads_unavailable' }, { status: 503 })
  }
})
