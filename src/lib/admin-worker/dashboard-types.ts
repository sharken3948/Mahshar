export type WorkerInvitation = {
  id: string
  source: 'acquisition' | 'outreach'
  recipient: string | null
  subject: string
  body: string
  status: string
  prepared_at: string | null
  generator: 'groq' | null
  reserved_at: string | null
  sent_at: string | null
  delivery: string
  events: { label: string; at: string }[]
}

export type WorkerProviderActivity = {
  id: string
  name: string
  domain: string
  qualification: string
  reason: string | null
  invitation: string
  delivery: string
  has_invitation: boolean
}

export type WorkerActivity = { id: string; provider: string; label: string; at: string }
export type WorkerDashboard = {
  metrics: { found: number; qualified: number; prepared: number; sent: number; replies: null; inbound_received: number }
  providers: WorkerProviderActivity[]
  recent: WorkerActivity[]
  page: number
  total: number
  as_of: string
}

export type WorkerProviderDetail = {
  provider: WorkerProviderActivity
  invitations: WorkerInvitation[]
  page: number
  has_more: boolean
}
