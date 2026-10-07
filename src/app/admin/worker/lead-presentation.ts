import type { WorkerQualifiedLeadDto } from '@/lib/admin-worker/types'

type ContactLead = Pick<WorkerQualifiedLeadDto, 'preferred_email' | 'contactability' | 'contact_evidence'>

export function workerLeadContactLabel(lead: ContactLead): string {
  if (lead.preferred_email) return 'Email'
  if (lead.contactability === 'official_sales_channel'
    || lead.contact_evidence.some(evidence => evidence.preferred && evidence.purpose === 'sales')) return 'Sales'
  if (lead.contact_evidence.some(evidence => evidence.preferred && evidence.purpose === 'support')) return 'Support'
  if (['verified_official_contact', 'official_contact_page'].includes(lead.contactability)) return 'Contact form'
  if (['contact_unavailable', 'none_found'].includes(lead.contactability)) return 'Unavailable'
  return 'Unknown'
}
