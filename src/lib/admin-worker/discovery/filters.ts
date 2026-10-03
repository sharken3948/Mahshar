import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'
import type { RawCandidate } from './types'

const UNSUPPORTED_PROTOCOL = /\b(?:soap|graphql subscription|websocket-only|mqtt-only|grpc-only)\b/i
const PROHIBITED = /\b(?:credential resale|stolen api|malware|ransomware|carding|ddos-for-hire)\b/i
const OBSOLETE = /\b(?:deprecated|obsolete|discontinued|sunset)\b/i

export function deterministicCandidateFilter(candidate: RawCandidate): string | null {
  if (!candidate.discoveredName.trim() || !candidate.discoveredDomain?.trim()) return 'provider_identity_missing'
  if (!candidate.discoveredProduct?.trim()) return 'product_identity_missing'
  if (![candidate.discoveredContractUrl, candidate.discoveredDocsUrl].some(url => url && isOutboundUrlShapeAllowed(url))) return 'structured_api_contract_missing'
  const evidence = `${candidate.discoveredProduct} ${candidate.sourceSummary ?? ''}`
  if (PROHIBITED.test(evidence)) return 'prohibited_service'
  if (OBSOLETE.test(evidence)) return 'obsolete_product'
  if (UNSUPPORTED_PROTOCOL.test(evidence)) return 'unsupported_protocol'
  if (!/\b(?:api|openapi|rest|http|json)\b/i.test(evidence)) return 'callable_api_unverified'
  return null
}
