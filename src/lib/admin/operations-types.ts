export type OperationsAvailability = 'ready' | 'degraded' | 'unavailable'

export type ListingCountsDto = {
  total: number
  active: number
  inactive: number
  verified: number
  as_of: string
}

export type TreasuryBalanceDto = {
  wallet: string
  balance_usdc: string
  status: 'fresh' | 'stale'
  chain_id: 5042
  explorer_url: string
  as_of: string
}

export type StateCount = { state: string; count: number }

export type OperationsSnapshotDto = {
  settlement: StateCount[]
  delivery: StateCount[]
  total: number
  as_of: string
}

export type RecentPaymentDto = {
  id: string
  listing: { id: string; name: string } | null
  payer: string
  seller: string
  settlement_state: string
  accounting_state: 'ACCOUNTING_COMPLETE' | 'PURCHASE_LINKED' | 'NOT_RECORDED'
  delivery_state: string
  purchase_id: string | null
  evidence_id: string | null
  buyer_charge_usdc: string | null
  seller_share_usdc: string | null
  created_at: string | null
  updated_at: string | null
  delivery_http_status: number | null
  delivery_error_code: string | null
  reason_code: string | null
}

export type RecentPaymentsDto = {
  payments: RecentPaymentDto[]
  limit: number
  as_of: string
}

export type PurchaseDto = {
  id: string
  listing: { id: string; name: string } | null
  buyer: string
  seller: string
  buyer_amount_usdc: string | null
  seller_share_usdc: string | null
  settlement_attempt_id: string | null
  settlement_state: string | null
  delivery_state: string | null
  delivery_http_status: number | null
  delivery_error_code: string | null
  historical_unlinked: boolean
  created_at: string | null
}

export type PurchasesDto = {
  purchases: PurchaseDto[]
  limit: number
  as_of: string
}

export type PurchaseCallDto = {
  id: string
  success: boolean
  latency_ms: number | null
  payment_type: string | null
  created_at: string | null
}

export type PurchaseDetailDto = {
  purchase: PurchaseDto
  api_calls: PurchaseCallDto[]
  as_of: string
}

export type OperationalSignalState = 'ready' | 'configured' | 'unobserved' | 'degraded' | 'unavailable' | 'not_configured'

export type OperationalSignalDto = {
  id: string
  label: string
  state: OperationalSignalState
  detail: string
  metadata?: string | null
}

export type InfrastructureDto = {
  signals: OperationalSignalDto[]
  as_of: string
}

export type SystemHealthDto = {
  signals: OperationalSignalDto[]
  response_retention_days: 7
  expired_response_backlog: number
  expired_response_backlog_capped: boolean
  as_of: string
}

export type IssueSeverity = 'critical' | 'warning' | 'informational'
export type IssuePresentation = 'needs_attention' | 'informational'

export type OperationsIssueDto = {
  id: string
  type: string
  severity: IssueSeverity
  entity_id: string
  listing: { id: string; name: string } | null
  wallet: string | null
  settlement_state: string | null
  delivery_state: string | null
  purchase_id: string | null
  error_code: string | null
  occurred_at: string | null
  updated_at: string | null
  explanation: string
  presentation: IssuePresentation
}

export type OperationsIssueSourceDto = {
  id: 'settlement' | 'delivery' | 'withdrawals' | 'response_backlog' | 'listing_contracts'
  label: string
  state: 'ready' | 'unavailable'
}

export type OperationsIssuesDto = {
  issues: OperationsIssueDto[]
  count: number
  counts: {
    needs_attention_entities: number
    needs_attention_conditions: number
    informational_conditions: number
    all_conditions: number
  }
  truncated: boolean
  complete: boolean
  sources: OperationsIssueSourceDto[]
  taxonomy: 'current_durable_v1'
  as_of: string
}

export type ListingContractStatus = {
  status: 'VALID' | 'INVALID'
  reason_code: string | null
  reason: string | null
}

export type ListingDiscoveryStatus = {
  status: 'VISIBLE' | 'EXCLUDED'
  reason_code: string | null
  reason: string | null
}

export type ListingExecutionStatus = {
  status: 'ELIGIBLE' | 'BLOCKED'
  reason_code: string | null
  reason: string | null
}

export type OperationsListingDto = {
  id: string
  name: string
  category: string
  price_per_call: string | null
  seller_wallet: string
  active: boolean
  verified: boolean
  source: string
  score: number | null
  contract: ListingContractStatus
  discovery: ListingDiscoveryStatus
  execution: ListingExecutionStatus
}

export type OperationsListingsDto = {
  listings: OperationsListingDto[]
  pagination: {
    page: number
    page_size: number
    total: number
    total_pages: number
  }
  filters: {
    status: 'all' | 'active' | 'inactive'
    verification: 'all' | 'verified' | 'unverified'
    source: string | null
  }
  as_of: string
}
