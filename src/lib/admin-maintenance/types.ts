export type MaintenanceStatus =
  | 'current'
  | 'update_available'
  | 'deprecation_notice'
  | 'action_required'
  | 'check_failed'
  | 'unknown'

export type MaintenanceSeverity = 'Info' | 'Review' | 'Important' | 'Critical'

export type MaintenanceCategory = 'Arc' | 'Circle' | 'AI' | 'Runtime'

export type MaintenanceInventoryItem = {
  id: string
  component: string
  category: MaintenanceCategory
  current: string
  package_name: string | null
  usage: string
  source_url: string
}

export type MaintenanceCheckResult = MaintenanceInventoryItem & {
  latest: string | null
  status: MaintenanceStatus
  severity: MaintenanceSeverity
  impact: string
  details: string
  recommended_action: string
  checked_at: string
}

export type MaintenanceSummary = {
  critical: number
  important: number
  review: number
  current: number
  check_failures: number
}

export type MaintenanceDashboardDto = {
  inventory: MaintenanceInventoryItem[]
  results: MaintenanceCheckResult[]
  summary: MaintenanceSummary
  checked_at: string | null
}

export type ArcNotice = {
  id: string
  title: string
  body: string
  url: string
  updatedAt: string
}
