import type { WorkerQualifiedLeadDto } from '@/lib/admin-worker/types'

export const outreachStatuses = [
  'contact_ready', 'draft', 'sent', 'needs_reply', 'interested', 'rejected', 'do_not_contact', 'closed',
] as const

export type OutreachStatus = typeof outreachStatuses[number]
export type OutreachMessageStatus = 'draft' | 'ready_to_send' | 'sent' | 'failed' | 'received'

export type OutreachMessageDto = {
  id: string
  status: OutreachMessageStatus
  recipient_email: string
  sender_email: string
  subject: string
  body: string
  provider_message_id: string | null
  approved_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export type OutreachLeadDto = WorkerQualifiedLeadDto & {
  provider_id: string
  outreach_status: OutreachStatus
  last_outreach_at: string | null
  last_reply_at: string | null
  draft: OutreachMessageDto | null
  history: OutreachMessageDto[]
}

export type ContactFormLeadDto = Pick<WorkerQualifiedLeadDto,
  'id' | 'provider' | 'product' | 'fit_score' | 'official_contact_url'>

export type OutreachDashboardDto = {
  leads: OutreachLeadDto[]
  contact_form_only: ContactFormLeadDto[]
  counts: Record<OutreachStatus, number> & { contact_form_only: number }
  transport: { outbound: 'configured' | 'not_configured'; sender: 'support@mahshar.xyz' }
  replies: { inbound: 'not_configured' }
  as_of: string
}
