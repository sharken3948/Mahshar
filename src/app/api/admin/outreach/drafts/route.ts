import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { createOutreachDraft } from '@/lib/admin-outreach/repository'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const POST = withAdmin(async (request: NextRequest) => {
  const input = await request.json().catch(() => null) as { leadId?: unknown } | null
  if (!input || typeof input.leadId !== 'string' || !UUID.test(input.leadId)) {
    return NextResponse.json({ error: 'invalid_lead' }, { status: 400 })
  }
  try { return NextResponse.json(await createOutreachDraft(input.leadId), { status: 201 }) }
  catch (error) {
    console.error('[admin-outreach] draft unavailable', error)
    return NextResponse.json({ error: 'admin_outreach_draft_unavailable' }, { status: 409 })
  }
})
