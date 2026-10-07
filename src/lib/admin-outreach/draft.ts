import type { WorkerQualifiedLeadDto } from '@/lib/admin-worker/types'

export const OUTREACH_SENDER = 'support@mahshar.xyz' as const

export type GroundedOutreachDraft = { subject: string; body: string }

type DraftLead = Pick<WorkerQualifiedLeadDto, 'provider' | 'product' | 'preferred_email' | 'email_ready' | 'contactability'>

export function isEmailOutreachEligible(lead: DraftLead): lead is DraftLead & { preferred_email: string } {
  return lead.email_ready && lead.contactability === 'verified_email'
    && typeof lead.preferred_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.preferred_email)
}
function cleanName(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return cleaned || fallback
}

export function generateGroundedOutreachDraft(lead: DraftLead): GroundedOutreachDraft {
  if (!isEmailOutreachEligible(lead)) throw new Error('admin_outreach_lead_not_email_ready')
  const provider = cleanName(lead.provider, 'your team')
  const product = cleanName(lead.product, 'your API')
  return {
    subject: `${product} on Mahshar`,
    body: `Hello ${provider} team,

I'm reaching out from Mahshar, where API providers can offer endpoints through an additional pay-per-call distribution channel.

We found the published information for ${product}. If it is useful for your team, you can start on Mahshar with a single endpoint rather than a broad integration.

Would you be open to a short conversation about whether this is a fit?

Best,
Mahshar
${OUTREACH_SENDER}`,
  }
}
