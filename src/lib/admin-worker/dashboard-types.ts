export type WorkerInvitation = {
  id: string
  source: 'acquisition' | 'outreach'
  recipient: string | null
  subject: string
  body: string
  status: string
  prepared_at: string | null
  generator: 'groq' | 'template' | null
  template_version?: string | null
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
  historical_skip?: { reason: string; at: string } | null
  invitation: string
  delivery: string
  has_invitation: boolean
  discovered_at: string | null
  latest_activity_at: string | null
  contact: string
}

export type WorkerActivity = {
  id: string
  provider: string
  provider_id: string | null
  stage: 'Discovery' | 'Research' | 'Qualification' | 'Contact' | 'Groq Drafting' | 'Template Rendering' | 'Reservation' | 'Stopped' | null
  label: string
  at: string
}
export type WorkerActivityCursor = { at: string; id: string }
export type WorkerActivityHistory = { events: WorkerActivity[]; next_cursor: WorkerActivityCursor | null }
export type WorkerDashboard = {
  metrics: { found: number; qualified: number; prepared: number; prepared_template?: number; prepared_groq?: number; sent: number; replies: null; inbound_received: number }
  providers: WorkerProviderActivity[]
  recent: WorkerActivity[]
  activity_next_cursor: WorkerActivityCursor | null
  page: number
  total: number
  as_of: string
}

export type WorkerProviderDetail = {
  provider: WorkerProviderActivity
  invitations: WorkerInvitation[]
  page: number
  has_more: boolean
  activity: WorkerActivityHistory
  contacts?: WorkerContactRoute[]
  acquisition_history?: { id: string; reason: string; at: string }[]
  research: {
    id: string
    qualification: string
    summary: string | null
    qualified_at: string | null
    contact: string
    contact_state?: string | null
    contact_url?: string | null
    contact_researched_at: string | null
    email: string | null
    traction: string | null
    evidence: { id: string; role: string; url: string; summary: string | null; checked_at: string }[]
  }[]
}

export type WorkerContactRoute = {
  id: string
  type: string
  value: string
  purpose: string
  source_url: string
  form_state: 'available' | 'manual_required' | null
  verified_at: string
}
