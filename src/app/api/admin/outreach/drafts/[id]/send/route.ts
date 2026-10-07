import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getApprovedOutreachMessage, markOutreachSent } from '@/lib/admin-outreach/repository'
import { sendOutreachEmail } from '@/lib/admin-outreach/transport'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Context = { params: Promise<{ id: string }> }

export const POST = withAdmin(async (_request: NextRequest, _principal, context: Context) => {
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'invalid_draft' }, { status: 400 })
  try {
    const message = await getApprovedOutreachMessage(id)
    const delivery = await sendOutreachEmail({ id: message.id, recipient: message.recipient_email,
      subject: message.subject, body: message.body })
    return NextResponse.json(await markOutreachSent(id, delivery.providerMessageId))
  } catch (error) {
    console.error('[admin-outreach] delivery unavailable', error)
    return NextResponse.json({ error: 'admin_outreach_delivery_unavailable' }, { status: 503 })
  }
})
