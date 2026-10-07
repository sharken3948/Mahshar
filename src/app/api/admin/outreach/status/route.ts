import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { setOutreachStatus } from '@/lib/admin-outreach/repository'
import { outreachStatuses, type OutreachStatus } from '@/lib/admin-outreach/types'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const PATCH = withAdmin(async (request: NextRequest) => {
  const input = await request.json().catch(() => null) as { leadId?: unknown; status?: unknown } | null
  if (!input || typeof input.leadId !== 'string' || !UUID.test(input.leadId)
    || typeof input.status !== 'string' || !outreachStatuses.includes(input.status as OutreachStatus)) {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }
  try { return NextResponse.json(await setOutreachStatus(input.leadId, input.status as OutreachStatus)) }
  catch (error) {
    console.error('[admin-outreach] status unavailable', error)
    return NextResponse.json({ error: 'admin_outreach_status_unavailable' }, { status: 409 })
  }
})
