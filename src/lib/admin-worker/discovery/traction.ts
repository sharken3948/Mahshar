import { durableExternalSummary } from './sanitize'
import type { Contactability, ProvenanceFact, RawCandidate, WorkerTraction } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

function activityDate(candidate: RawCandidate, now: number): { value: string | null; concerns: string[] } {
  const concerns: string[] = []
  let sawValue = false
  for (const value of [candidate.directoryUpdatedAt, candidate.directoryAddedAt]) {
    if (!value) continue
    sawValue = true
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) { concerns.push('activity_date_invalid'); continue }
    if (parsed > now) { concerns.push('activity_date_future'); continue }
    return { value: new Date(parsed).toISOString(), concerns }
  }
  if (!sawValue) concerns.push('activity_date_unavailable')
  return { value: null, concerns }
}

function contactability(facts: ProvenanceFact[]): Contactability {
  if (facts.some(fact => fact.sourceRole === 'official_contact' && fact.sourceType === 'website')) return 'verified_official_contact'
  if (facts.some(fact => fact.sourceRole === 'official_pricing' && fact.sourceType === 'website')) return 'official_sales_channel'
  return 'unknown'
}

export function assessTraction(candidate: RawCandidate, facts: ProvenanceFact[], now = Date.now()): WorkerTraction {
  const signals: string[] = []
  const concerns: string[] = []
  const activity = activityDate(candidate, now)
  const lastActivityAt = activity.value
  concerns.push(...activity.concerns)
  let score = 0
  if (facts.some(fact => fact.sourceRole === 'official_site')) { score += 15; signals.push('official_site_active') }
  if (facts.some(fact => fact.sourceRole === 'official_docs')) { score += 20; signals.push('official_docs_active') }
  if (facts.some(fact => fact.sourceRole === 'official_pricing')) { score += 15; signals.push('official_pricing_available') }
  if (facts.some(fact => fact.sourceRole === 'official_contact')) { score += 10; signals.push('official_contact_available') }
  if (lastActivityAt) {
    const ageDays = Math.max(0, Math.floor((now - Date.parse(lastActivityAt)) / DAY_MS))
    if (ageDays <= 180) { score += 40; signals.push('directory_update_recent') }
    else if (ageDays <= 730) { score += 25; signals.push('directory_update_maintained') }
    else { score += 5; concerns.push('directory_update_stale') }
  } else if (!concerns.length) concerns.push('activity_date_unavailable')
  score = Math.min(100, score)
  const evidenceCount = signals.length
  const tractionConfidence = lastActivityAt && evidenceCount >= 2 ? 'medium'
    : evidenceCount > 0 || lastActivityAt ? 'low' : 'unknown'
  const tractionLevel = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
  const summary = durableExternalSummary(
    tractionConfidence === 'unknown'
      ? 'Traction is unknown because no bounded activity evidence was available.'
      : `Estimated ${tractionLevel} activity from ${evidenceCount} bounded, verifiable signal${evidenceCount === 1 ? '' : 's'}; this is not usage volume.`,
    500,
  ) ?? 'Traction evidence unavailable.'
  return {
    tractionScore: score, tractionLevel, tractionConfidence, lastActivityAt,
    signals: signals.slice(0, 8), concerns: concerns.slice(0, 8), summary,
    contactability: contactability(facts),
  }
}
