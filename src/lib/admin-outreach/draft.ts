import type { WorkerQualifiedLeadDto } from '@/lib/admin-worker/types'
import { getDomainWithoutSuffix } from 'tldts'

export const OUTREACH_SENDER = 'support@mahshar.xyz' as const

export type GroundedOutreachDraft = { subject: string; body: string }

type DraftLead = Pick<WorkerQualifiedLeadDto,
  'provider' | 'provider_domain' | 'product' | 'preferred_email' | 'email_ready' | 'contactability'>

export function isEmailOutreachEligible(lead: DraftLead): lead is DraftLead & { preferred_email: string } {
  return lead.email_ready && lead.contactability === 'verified_email'
    && typeof lead.preferred_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.preferred_email)
}
function cleanName(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return cleaned || fallback
}

function identityKey(value: string): string {
  return value.normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isHostname(value: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)
}

export function providerDisplayName(lead: Pick<DraftLead, 'provider' | 'provider_domain' | 'product'>): string | null {
  const provider = cleanName(lead.provider, '')
  const domain = cleanName(lead.provider_domain, '').toLowerCase().replace(/^www\./, '')
  if (provider && !isHostname(provider) && !/^https?:\/\//i.test(provider) && !provider.includes('@')) return provider

  const domainLabel = getDomainWithoutSuffix(domain)
  if (!domainLabel || ['api', 'apis', 'developer', 'developers', 'service'].includes(domainLabel.toLowerCase())) return null
  const domainKey = identityKey(domainLabel)
  const productWords = cleanName(lead.product, '').match(/[\p{L}\p{N}]+/gu) ?? []
  for (let start = 0; start < productWords.length; start += 1) {
    for (let length = 1; length <= 4 && start + length <= productWords.length; length += 1) {
      const candidate = productWords.slice(start, start + length)
      if (identityKey(candidate.join('')) === domainKey) return candidate.join(' ')
    }
  }
  return null
}

export function generateGroundedOutreachDraft(lead: DraftLead): GroundedOutreachDraft {
  if (!isEmailOutreachEligible(lead)) throw new Error('admin_outreach_lead_not_email_ready')
  const provider = providerDisplayName(lead)
  const product = cleanName(lead.product, 'your API')
  return {
    subject: `${product} on Mahshar`,
    body: `${provider ? `Hello ${provider} team,` : 'Hello,'}

I'm reaching out from Mahshar, a pay-per-call API marketplace on Arc.

Existing endpoints can be made available to users and autonomous agents, with USDC payments handled per request.

We found the published information for ${product}. You can start with a single endpoint rather than a broad integration.

Would you be open to a short conversation to see if this is a fit?

Best,
Mahshar
${OUTREACH_SENDER}`,
  }
}
