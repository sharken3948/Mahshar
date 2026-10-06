import type { WorkerQualifiedLeadDto } from '@/lib/admin-worker/types'

type QualificationDisplayStatus = WorkerQualifiedLeadDto['status'] | 'rejected' | 'deferred' | 'discovered'

function qualificationStatusLabel(status: QualificationDisplayStatus): string {
  if (status === 'qualified') return 'Qualified'
  if (status === 'technical_qualified') return 'Technical fit · contact pending'
  if (status === 'review_candidate') return 'Review candidate'
  if (status === 'rejected') return 'Low fit'
  return status.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())
}

export function QualificationLabel({ status, reasonCodes }: {
  status: QualificationDisplayStatus
  reasonCodes: string[]
}) {
  const details = reasonCodes.join(', ').replace(/_/g, ' ')
  return <small>{qualificationStatusLabel(status)}{details ? ` · ${details}` : ''} · onboarding verification required</small>
}
