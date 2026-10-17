import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { MailListError, markPendingEmailSent } from '@/lib/admin-worker/mail-list-repository'
import { MAIL_UUID } from '@/lib/admin-worker/mail-list-types'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }
export const POST = withAdmin(async (_request: NextRequest, principal, context: Context) => {
  const { id } = await context.params
  if (!MAIL_UUID.test(id)) return NextResponse.json({ error: 'invalid_pending_email' }, { status: 400 })
  try { return NextResponse.json(await markPendingEmailSent(id, principal.wallet)) }
  catch (error) {
    return NextResponse.json({ error: error instanceof MailListError ? error.message : 'pending_email_update_unavailable' },
      { status: error instanceof MailListError ? error.status : 503 })
  }
})
