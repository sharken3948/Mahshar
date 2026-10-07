import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { editOutreachDraft } from '@/lib/admin-outreach/repository'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Context = { params: Promise<{ id: string }> }

export const PATCH = withAdmin(async (request: NextRequest, _principal, context: Context) => {
  const { id } = await context.params
  const input = await request.json().catch(() => null) as { subject?: unknown; body?: unknown } | null
  if (!UUID.test(id) || !input || typeof input.subject !== 'string' || typeof input.body !== 'string'
    || input.subject.trim().length < 1 || input.subject.trim().length > 200
    || input.body.trim().length < 1 || input.body.trim().length > 5000) {
    return NextResponse.json({ error: 'invalid_draft' }, { status: 400 })
  }
  try { return NextResponse.json(await editOutreachDraft(id, input.subject, input.body)) }
  catch (error) {
    console.error('[admin-outreach] draft edit unavailable', error)
    return NextResponse.json({ error: 'admin_outreach_draft_unavailable' }, { status: 409 })
  }
})
