import 'server-only'

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
