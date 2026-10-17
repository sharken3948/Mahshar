import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getPendingEmails } from '@/lib/admin-worker/mail-list-repository'
import { MAIL_UUID } from '@/lib/admin-worker/mail-list-types'

export const runtime = 'nodejs'
export const GET = withAdmin(async (request: NextRequest) => {
  const after = new URL(request.url).searchParams.get('after')
  if (after !== null && !MAIL_UUID.test(after)) return NextResponse.json({ error: 'invalid_cursor' }, { status: 400 })
  try { return NextResponse.json(await getPendingEmails(after)) }
  catch { return NextResponse.json({ error: 'pending_emails_unavailable' }, { status: 503 }) }
})
