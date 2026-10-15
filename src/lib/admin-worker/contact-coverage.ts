export type ContactResearchState = 'verified_email' | 'form_available' | 'manual_required' | 'unresolved' | 'no_contact_found'

export function contactResearchDue(lead: {
  email_ready?: unknown; commercial_api?: unknown; contact_research_state?: unknown
  contact_checked_at?: unknown; contact_researched_at?: unknown
}, nowMs = Date.now()): boolean {
  if (lead.email_ready === true) return false
  // One bounded pass upgrades old commercial no-email investigations to the
  // richer evidence format; subsequent attempts use the normal freshness window.
  if (lead.commercial_api === true && lead.contact_research_state == null) return true
  const checked = lead.contact_checked_at ?? lead.contact_researched_at
  if (typeof checked !== 'string' || !Number.isFinite(Date.parse(checked))) return true
  const days = lead.contact_research_state === 'unresolved' ? 1 : lead.commercial_api === true ? 7 : 30
  return nowMs - Date.parse(checked) >= days * 86_400_000
}

export function contactCoverageLabel(state: unknown, legacy?: unknown): string {
  switch (state) {
    case 'verified_email': return 'Verified email · sending permission separate'
    case 'form_available': return 'Official form available'
    case 'manual_required': return 'CAPTCHA / manual review required'
    case 'no_contact_found': return 'No contact found in bounded research'
    case 'unresolved': return 'Contact research unresolved'
    default: return String(legacy ?? 'Not confirmed').replace(/_/g, ' ')
  }
}
