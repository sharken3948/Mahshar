import type { WorkerIdentityType } from '../normalization'

export type DiscoverySourceType = 'api_directory'

export type RawCandidate = {
  sourceType: DiscoverySourceType
  sourceUrl: string
  discoveredName: string
  discoveredDomain?: string
  discoveredProduct?: string
  discoveredContractUrl?: string
  discoveredDocsUrl?: string
  discoveredPricingUrl?: string
  discoveredContactUrl?: string
  sourceSummary?: string
}

export type NormalizedIdentity = {
  type: WorkerIdentityType
  value: string
  originalValue: string
}

export type CandidateOutcome = {
  status: 'duplicate' | 'blocked' | 'filtered' | 'deferred' | 'persisted'
  reasonCode: string
  providerId?: string
  productId?: string
  leadId?: string
  discovered: number
  duplicate: number
  filtered: number
  qualified: number
  persisted: number
}

export type ProvenanceFact = {
  sourceType: 'website' | 'api_directory'
  sourceRole: 'directory_assertion' | 'official_site' | 'official_docs' | 'official_pricing' | 'official_contact'
  url: string
  title?: string
  factualSummary?: string
  checkedAt: string
}

export type QualificationLevel = 'low' | 'medium' | 'high'

export type WorkerQualification = {
  fitScore: number
  commercialApi: boolean
  agentUtility: QualificationLevel
  payPerCallFit: QualificationLevel
  integrationDifficulty: QualificationLevel
  providerCredibility: QualificationLevel
  reasonCodes: string[]
  summary: string
}

export type DurableCandidate = RawCandidate & {
  id: string
  discoveryBatchId: string
  ordinal: number
  normalizedDomain: string | null
  normalizedProductKey: string | null
  status: 'pending' | CandidateOutcome['status']
  reasonCode: string | null
  providerId: string | null
  productId: string | null
  leadId: string | null
  retryAfter: string | null
  processingLeaseId: string | null
  processingLeaseExpiresAt: string | null
}
