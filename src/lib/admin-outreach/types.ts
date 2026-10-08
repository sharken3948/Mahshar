import type { WorkerQualifiedLeadDto } from '@/lib/admin-worker/types'

export const outreachStatuses = [
  'contact_ready', 'draft', 'sent', 'needs_reply', 'interested', 'rejected', 'do_not_contact', 'closed',
] as const

export type OutreachStatus = typeof outreachStatuses[number]
export type OutreachMessageStatus = 'draft' | 'ready_to_send' | 'sent' | 'failed' | 'received'
export const outreachClassifications = [
  'interested', 'payment_question', 'technical_question', 'not_interested', 'do_not_contact', 'other',
] as const
export type OutreachClassification = typeof outreachClassifications[number]
export type OutreachProcessingState = 'not_applicable' | 'received' | 'unmatched' | 'classified' | 'suggested' | 'suggestion_failed'
export const outreachDeliveryEventTypes = [
  'sent', 'delivered', 'opened', 'soft_bounce', 'hard_bounce', 'blocked',
] as const
export type OutreachDeliveryEventType = typeof outreachDeliveryEventTypes[number]

export type OutreachDeliveryEventDto = {
  id: string
  event_type: OutreachDeliveryEventType
  occurred_at: string
  received_at: string
}

const outreachDeliveryPrecedence: Record<OutreachDeliveryEventType, number> = {
  sent: 1, soft_bounce: 2, delivered: 3, opened: 4, blocked: 5, hard_bounce: 6,
}

export function currentOutreachDeliveryEvent(events: OutreachDeliveryEventDto[]): OutreachDeliveryEventDto | null {
  return events.reduce<OutreachDeliveryEventDto | null>((current, event) => {
    if (!current || outreachDeliveryPrecedence[event.event_type] > outreachDeliveryPrecedence[current.event_type]) return event
    if (outreachDeliveryPrecedence[event.event_type] === outreachDeliveryPrecedence[current.event_type]
      && Date.parse(event.occurred_at) > Date.parse(current.occurred_at)) return event
    return current
  }, null)
}

export type OutreachMessageDto = {
  id: string
  thread_id: string | null
  direction: 'inbound' | 'outbound'
  status: OutreachMessageStatus
  recipient_email: string
  sender_email: string
  subject: string
  body: string
  provider_message_id: string | null
  in_reply_to: string | null
  reference_ids: string[]
  received_at: string | null
  classification: OutreachClassification | null
  classification_confidence: number | null
  classification_reason: string | null
  processing_state: OutreachProcessingState
  matched_by: 'in_reply_to' | 'reference' | 'subject_context' | 'sender_unambiguous' | null
  reply_to_message_id: string | null
  approved_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
  delivery_state: OutreachDeliveryEventType | null
  delivery_event_at: string | null
  delivery_events: OutreachDeliveryEventDto[]
}

export type OutreachInboxItemDto = {
  message: OutreachMessageDto
  match_state: 'matched' | 'unmatched'
  lead_id: string | null
  provider: string | null
  product: string | null
  thread_status: OutreachStatus | null
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
  inbox: OutreachInboxItemDto[]
  contact_form_only: ContactFormLeadDto[]
  counts: Record<OutreachStatus, number> & { inbox: number; unmatched_inbound: number; contact_form_only: number }
  transport: { outbound: 'configured' | 'not_configured'; sender: 'support@mahshar.xyz' }
  replies: { inbound: 'mailbox_bridge_configured' | 'not_configured' }
  as_of: string
}
