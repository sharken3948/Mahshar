import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'

export type OutreachDelivery = {
  id: string
  recipient: string
  subject: string
  body: string
}

export function outreachTransportConfigured(): boolean {
  return process.env.MAINNET_MODE === 'true' && Boolean(process.env.BREVO_API_KEY?.trim())
}

export async function sendOutreachEmail(
  message: OutreachDelivery,
  request: typeof fetch = fetch,
): Promise<{ providerMessageId: string }> {
  const apiKey = process.env.BREVO_API_KEY?.trim()
  if (process.env.MAINNET_MODE !== 'true' || !apiKey) throw new Error('admin_outreach_transport_unavailable')
  if (![message.id, message.recipient, message.subject, message.body].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('admin_outreach_invitation_integrity_required')
  }
  // A direct adapter call or historical approval cannot bypass current naming proof.
  const integrity = await createServiceClient().rpc('mahshar_admin_outreach_assert_invitation_integrity', {
    p_message_id: message.id, p_recipient: message.recipient, p_subject: message.subject, p_body: message.body,
  })
  if (integrity.error || integrity.data !== true) throw new Error('admin_outreach_invitation_integrity_required')
  const response = await request('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Mahshar', email: 'support@mahshar.xyz' },
      to: [{ email: message.recipient }],
      subject: message.subject,
      textContent: message.body,
      headers: { idempotencyKey: message.id },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('admin_outreach_delivery_failed')
  const result = await response.json().catch(() => null) as { messageId?: unknown } | null
  if (!result || typeof result.messageId !== 'string' || result.messageId.length < 1 || result.messageId.length > 512) {
    throw new Error('admin_outreach_delivery_invalid')
  }
  return { providerMessageId: result.messageId }
}
