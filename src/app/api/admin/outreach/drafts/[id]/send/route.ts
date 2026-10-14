import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getApprovedOutreachMessage, markOutreachSent, markOutreachUncertain, reserveOutreachSend } from '@/lib/admin-outreach/repository'
import { outreachTransportConfigured, sendOutreachEmail } from '@/lib/admin-outreach/transport'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Context = { params: Promise<{ id: string }> }

export const POST = withAdmin(async (_request: NextRequest, _principal, context: Context) => {
  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'invalid_draft' }, { status: 400 })
  let reserved = false
  try {
    const message = await getApprovedOutreachMessage(id)
    if (!outreachTransportConfigured()) throw new Error('admin_outreach_transport_unavailable')
    await reserveOutreachSend(id)
    reserved = true
    const delivery = await sendOutreachEmail({ id: message.id, recipient: message.recipient_email,
      subject: message.subject, body: message.body })
    return NextResponse.json(await markOutreachSent(id, delivery.providerMessageId))
  } catch (error) {
    if (reserved) {
      try { await markOutreachUncertain(id) }
      catch { console.error('[admin-outreach] reserved delivery needs reconciliation') }
    }
    console.error('[admin-outreach] delivery unavailable', error)
    return NextResponse.json({ error: 'admin_outreach_delivery_unavailable' }, { status: 503 })
  }
})
