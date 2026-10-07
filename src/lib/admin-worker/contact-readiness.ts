const OUTREACH_EMAIL = /^[a-z0-9](?:[a-z0-9.!#$%&*+/?^_`{|}~-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

export function isVerifiedOutreachEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && OUTREACH_EMAIL.test(value)
}

export function isOperationalWorkerLead(lead: {
  contactability: string
  actionable: boolean
  email_ready: boolean
  preferred_email: string | null
  preferred_contact_url: string | null
}): boolean {
  if (!lead.actionable) return false
  if (lead.contactability === 'verified_email') {
    return lead.email_ready && isVerifiedOutreachEmail(lead.preferred_email)
  }
  return ['verified_official_contact', 'official_contact_page', 'official_sales_channel'].includes(lead.contactability)
    && Boolean(lead.preferred_contact_url)
}
