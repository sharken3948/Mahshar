import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { brevoAcquisitionEnabled } from '@/lib/admin-worker/acquisition-delivery-config'

export class OutreachTransportError extends Error {
  constructor(public readonly kind: 'blocked' | 'rejected' | 'ambiguous', public readonly code: string) {
    super(code)
  }
}

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
  if (process.env.MAINNET_MODE !== 'true' || !apiKey) throw new OutreachTransportError('blocked', 'admin_outreach_transport_unavailable')
  if (![message.id, message.recipient, message.subject, message.body].every(value => typeof value === 'string' && value.length > 0)) {
    throw new OutreachTransportError('blocked', 'admin_outreach_invitation_integrity_required')
  }
  // A direct adapter call or historical approval cannot bypass current naming proof.
  const integrity = await createServiceClient().rpc('mahshar_admin_outreach_begin_transport', {
    p_message_id: message.id, p_recipient: message.recipient, p_subject: message.subject, p_body: message.body,
    p_acquisition_enabled: brevoAcquisitionEnabled(),
  })
  if (integrity.error || integrity.data !== true) throw new OutreachTransportError('blocked', 'admin_outreach_invitation_integrity_required')
  let response: Response
  try { response = await request('https://api.brevo.com/v3/smtp/email', {
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
  }) } catch { throw new OutreachTransportError('ambiguous', 'admin_outreach_delivery_unavailable') }
  const result = await response.json().catch(() => null) as { messageId?: unknown; messageIds?: unknown } | null
  if (!response.ok) {
    const code = (result as { code?: unknown } | null)?.code
    const rejected = [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(response.status)
      && typeof code === 'string' && ['invalid_parameter', 'missing_parameter', 'unauthorized', 'permission_denied',
        'not_enough_credits', 'out_of_range', 'method_not_allowed', 'not_found', 'too_many_requests'].includes(code)
      && result?.messageId === undefined && result?.messageIds === undefined
    throw new OutreachTransportError(rejected ? 'rejected' : 'ambiguous', rejected ? `brevo_${response.status}_${code}` : 'admin_outreach_delivery_failed')
  }
  if (response.status !== 201 || !result || typeof result.messageId !== 'string' || !result.messageId.trim()
    || result.messageId.length > 512 || /^<?simulated:/i.test(result.messageId)) {
    throw new OutreachTransportError('ambiguous', 'admin_outreach_delivery_invalid')
  }
  return { providerMessageId: result.messageId }
}
