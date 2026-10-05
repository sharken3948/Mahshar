import 'server-only'
import { normalizeWorkerIdentity, normalizeWorkerProductKey } from '../normalization'
import { WORKER_QUALIFICATION_MODEL, qualificationDisposition, qualifyCandidate } from './qualification'
import { deterministicCandidateFilter } from './filters'
import { discoverApiDirectoryRange } from './registry'
import { researchCandidate } from './research'
import { assessTraction } from './traction'
import {
  claimDeferredCandidates, claimDiscoveryBudget, getDiscoveryCandidates, getDiscoveryRunContext,
  getMaterializedSourceWork, getReusableProvenance, markDiscoveryCandidate, materializeSourceWork, preflightCandidate, resolveDiscoveryLead,
  saveDiscoveryCandidate, saveProvenance, saveQualification,
} from './repository'
import type { CandidateOutcome, DurableCandidate, ProvenanceFact } from './types'

const DEFERRED_SLICE = 5

export type DiscoveryProcessorDependencies = {
  preflightCandidate: typeof preflightCandidate
  researchCandidate: typeof researchCandidate
  resolveDiscoveryLead: typeof resolveDiscoveryLead
  claimDiscoveryBudget: typeof claimDiscoveryBudget
  getReusableProvenance: typeof getReusableProvenance
  saveProvenance: typeof saveProvenance
  saveQualification: typeof saveQualification
  markDiscoveryCandidate: typeof markDiscoveryCandidate
  qualifyCandidate: typeof qualifyCandidate
}

const defaultDependencies: DiscoveryProcessorDependencies = {
  preflightCandidate, researchCandidate, resolveDiscoveryLead, claimDiscoveryBudget,
  getReusableProvenance, saveProvenance, saveQualification, markDiscoveryCandidate, qualifyCandidate,
}

function outcome(status: CandidateOutcome['status'], reasonCode: string, values: Partial<CandidateOutcome> = {}): CandidateOutcome {
  return { status, reasonCode, discovered: 1, duplicate: 0, filtered: 0, qualified: 0, persisted: 0,
    reviewCandidate: 0, deferred: 0, tractionScored: 0, ...values }
}

function replayOutcome(candidate: DurableCandidate, discovered = 1): CandidateOutcome {
  const references = { providerId: candidate.providerId ?? undefined, productId: candidate.productId ?? undefined, leadId: candidate.leadId ?? undefined, discovered }
  if (candidate.status === 'persisted') {
    const reasonCode = candidate.reasonCode ?? 'qualified'
    return outcome('persisted', reasonCode, { ...references, qualified: 0,
      reviewCandidate: reasonCode === 'review_candidate' ? 1 : 0, persisted: 1, tractionScored: 1 })
  }
  if (candidate.status === 'filtered') {
    const reasonCode = candidate.reasonCode ?? 'filtered'
    return outcome('filtered', reasonCode, { ...references, filtered: 1,
      tractionScored: reasonCode === 'fit_below_threshold' ? 1 : 0 })
  }
  if (candidate.status === 'duplicate' || candidate.status === 'blocked') return outcome(candidate.status, candidate.reasonCode ?? 'duplicate', { ...references, duplicate: 1 })
  if (candidate.status === 'deferred') return outcome('deferred', candidate.reasonCode ?? 'qualification_deferred', { ...references, deferred: 1 })
  throw new Error('worker_candidate_replay_invalid')
}

async function recordPreflightOutcome(
  candidate: DurableCandidate,
  current: Awaited<ReturnType<typeof preflightCandidate>>,
  domain: string,
  productKey: string,
  deps: DiscoveryProcessorDependencies,
  discovered: number,
): Promise<CandidateOutcome> {
  const status = current.action === 'blocked' ? 'blocked' : 'duplicate'
  const result = outcome(status, current.reasonCode ?? 'duplicate', { ...current, discovered, duplicate: 1 })
  await deps.markDiscoveryCandidate(candidate, result, domain, productKey)
  return result
}

export async function processDiscoveryCandidate(
  runId: string,
  candidate: DurableCandidate,
  deadlineMs: number,
  dependencies: Partial<DiscoveryProcessorDependencies> = {},
  retryDeferred = false,
): Promise<CandidateOutcome> {
  const deps = { ...defaultDependencies, ...dependencies }
  const discovered = retryDeferred ? 0 : 1
  if (candidate.status !== 'pending' && !(retryDeferred && candidate.status === 'deferred')) {
    if (candidate.normalizedDomain && candidate.normalizedProductKey) {
      const current = await deps.preflightCandidate(candidate.normalizedDomain, candidate.normalizedProductKey)
      if (current.action === 'blocked') return recordPreflightOutcome(candidate, current, candidate.normalizedDomain, candidate.normalizedProductKey, deps, discovered)
    }
    return replayOutcome(candidate, discovered)
  }

  let domain: string
  let productKey: string
  try {
    domain = candidate.normalizedDomain ?? normalizeWorkerIdentity('domain', candidate.discoveredDomain ?? '')
    productKey = candidate.normalizedProductKey ?? normalizeWorkerProductKey(candidate.discoveredProduct ?? '')
  } catch {
    const result = outcome('filtered', 'identity_normalization_failed', { discovered, filtered: 1 })
    await deps.markDiscoveryCandidate(candidate, result)
    return result
  }

  const preflight = await deps.preflightCandidate(domain, productKey)
  if (preflight.action !== 'continue') return recordPreflightOutcome(candidate, preflight, domain, productKey, deps, discovered)
  if (Date.now() >= deadlineMs) {
    const result = outcome('deferred', 'run_budget_exhausted', { discovered, deferred: 1 })
    await deps.markDiscoveryCandidate(candidate, result, domain, productKey)
    return result
  }
  const filter = deterministicCandidateFilter(candidate)
  if (filter) {
    const result = outcome('filtered', filter, { discovered, filtered: 1 })
    await deps.markDiscoveryCandidate(candidate, result, domain, productKey)
    return result
  }

  let facts: ProvenanceFact[] = []
  if (retryDeferred && candidate.leadId) facts = await deps.getReusableProvenance(candidate.leadId)
  if (!facts.some(fact => fact.sourceRole === 'official_docs')) {
    const research = await deps.researchCandidate({
      candidate, normalizedDomain: domain,
      claimResearchBudget: purpose => deps.claimDiscoveryBudget(runId, 'research', `candidate:${candidate.id}:${purpose}`),
    })
    facts = research.facts
    if (!research.docsVerified || research.compatibilityFailure) {
      const reason = research.compatibilityFailure ?? research.failureCode ?? 'official_docs_unverified'
      const deferred = reason === 'research_budget_exhausted' || reason === 'run_budget_exhausted'
      const result = outcome(deferred ? 'deferred' : 'filtered', reason, { discovered, filtered: deferred ? 0 : 1, deferred: deferred ? 1 : 0 })
      await deps.markDiscoveryCandidate(candidate, result, domain, productKey)
      return result
    }
  }

  const resolution = await deps.resolveDiscoveryLead({ candidate, domain, productKey })
  if (resolution.action !== 'continue') return recordPreflightOutcome(candidate, resolution, domain, productKey, deps, discovered)
  if (!resolution.providerId || !resolution.productId || !resolution.leadId) throw new Error('worker_discovery_lead_resolve_invalid')
  const entity = { providerId: resolution.providerId, productId: resolution.productId, leadId: resolution.leadId }
  await deps.saveProvenance(entity.leadId, facts)

  const finalPreflight = await deps.preflightCandidate(domain, productKey)
  if (finalPreflight.action !== 'continue') {
    return recordPreflightOutcome(candidate, finalPreflight, domain, productKey, deps, discovered)
  }

  if (Date.now() >= deadlineMs || !await deps.claimDiscoveryBudget(runId, 'groq', `candidate:${candidate.id}`)) {
    const reason = Date.now() >= deadlineMs ? 'run_budget_exhausted' : 'groq_budget_exhausted'
    const persisted = await deps.saveQualification({ runId, candidate, ...entity, qualified: false, deferredReason: reason })
    return outcome(persisted.status, persisted.reasonCode, { ...entity, discovered,
      duplicate: persisted.status === 'duplicate' || persisted.status === 'blocked' ? 1 : 0,
      filtered: persisted.status === 'filtered' ? 1 : 0,
      qualified: persisted.countedQualified ? 1 : 0,
      persisted: persisted.status === 'persisted' ? 1 : 0, deferred: persisted.status === 'deferred' ? 1 : 0,
      targetReached: persisted.targetReached })
  }
  let qualification: Awaited<ReturnType<typeof qualifyCandidate>>
  try {
    qualification = await deps.qualifyCandidate(candidate, facts)
  } catch {
    const persisted = await deps.saveQualification({ runId, candidate, ...entity, qualified: false, deferredReason: 'groq_qualification_failed' })
    return outcome(persisted.status, persisted.reasonCode, { ...entity, discovered,
      duplicate: persisted.status === 'duplicate' || persisted.status === 'blocked' ? 1 : 0,
      filtered: persisted.status === 'filtered' ? 1 : 0, qualified: persisted.countedQualified ? 1 : 0,
      targetReached: persisted.targetReached })
  }
  const disposition = qualificationDisposition(qualification)
  const traction = assessTraction(candidate, facts)
  const persisted = await deps.saveQualification({ runId, candidate, ...entity, result: qualification,
    traction, model: WORKER_QUALIFICATION_MODEL, qualified: disposition === 'qualified' })
  return outcome(persisted.status, persisted.reasonCode, { ...entity, discovered,
    duplicate: persisted.status === 'duplicate' || persisted.status === 'blocked' ? 1 : 0,
    filtered: persisted.status === 'filtered' ? 1 : 0,
    qualified: persisted.countedQualified ? 1 : 0,
    reviewCandidate: persisted.status === 'persisted' && persisted.reasonCode === 'review_candidate' ? 1 : 0,
    persisted: persisted.status === 'persisted' ? 1 : 0,
    tractionScored: ['persisted', 'filtered'].includes(persisted.status) ? 1 : 0,
    targetReached: persisted.targetReached })
}

export type DiscoveryRangeDependencies = {
  claimDeferredCandidates: typeof claimDeferredCandidates
  getDiscoveryCandidates: typeof getDiscoveryCandidates
  getDiscoveryRunContext: typeof getDiscoveryRunContext
  saveDiscoveryCandidate: typeof saveDiscoveryCandidate
  markDiscoveryCandidate: typeof markDiscoveryCandidate
  getMaterializedSourceWork: typeof getMaterializedSourceWork
  materializeSourceWork: typeof materializeSourceWork
  discoverApiDirectoryRange: typeof discoverApiDirectoryRange
  processDiscoveryCandidate: typeof processDiscoveryCandidate
}

const defaultRangeDependencies: DiscoveryRangeDependencies = {
  claimDeferredCandidates, getDiscoveryCandidates, getDiscoveryRunContext, saveDiscoveryCandidate,
  markDiscoveryCandidate, getMaterializedSourceWork, materializeSourceWork,
  discoverApiDirectoryRange, processDiscoveryCandidate,
}

async function drainDeferredWithDependencies(
  runId: string, batchId: string, deadlineMs: number, remaining: number, deps: DiscoveryRangeDependencies,
): Promise<CandidateOutcome[]> {
  if (remaining <= 0) return []
  const candidates = await deps.claimDeferredCandidates(runId, batchId, Math.min(DEFERRED_SLICE, remaining))
  const outcomes: CandidateOutcome[] = []
  let credited = 0
  for (const candidate of candidates) {
    try {
      const result = await deps.processDiscoveryCandidate(runId, candidate, deadlineMs, {}, true)
      outcomes.push(result)
      credited += result.qualified
      if (credited >= remaining || result.targetReached) break
    }
    catch { /* A deferred item remains durable and must not poison fresh discovery. */ }
  }
  return outcomes
}

export async function processDiscoveryRange(
  runId: string, start: number, end: number, dependencies: Partial<DiscoveryRangeDependencies> = {},
): Promise<{ outcomes: CandidateOutcome[]; nextIndex: number; sourceExhausted: boolean; deadlineReached: boolean; hardLimitReached: boolean }> {
  const deps = { ...defaultRangeDependencies, ...dependencies }
  const context = await deps.getDiscoveryRunContext(runId)
  const deadlineMs = Date.parse(context.deadlineAt)
  if (context.qualifiedCount >= context.qualifiedTarget) {
    return { outcomes: [], nextIndex: start, sourceExhausted: false, deadlineReached: false, hardLimitReached: false }
  }
  const deferredOutcomes = start === 0 && runId === context.batchId
    ? await drainDeferredWithDependencies(runId, context.batchId, deadlineMs,
      context.qualifiedTarget - context.qualifiedCount, deps) : []
  const deferredQualified = deferredOutcomes.reduce((sum, item) => sum + item.qualified, 0)
  if (context.qualifiedCount + deferredQualified >= context.qualifiedTarget) {
    return { outcomes: deferredOutcomes, nextIndex: start, sourceExhausted: false, deadlineReached: false, hardLimitReached: false }
  }
  let candidates = await deps.getDiscoveryCandidates(context.batchId, start, end)
  const existing = new Set(candidates.map(candidate => candidate.ordinal))
  if (Date.now() >= deadlineMs) {
    return { outcomes: deferredOutcomes, nextIndex: start, sourceExhausted: false, deadlineReached: true, hardLimitReached: false }
  }
  let sourceExhausted = false
  let sourceDeadlineReached = false
  if (existing.size < end - start) {
    let discovered: Awaited<ReturnType<typeof discoverApiDirectoryRange>>
    try {
      discovered = await deps.discoverApiDirectoryRange({
        rootRunNumber: context.rootRunNumber, start, end,
        loadSourceWork: claimKey => deps.getMaterializedSourceWork(context.batchId, claimKey),
        materializeSourceWork: (claimKey, kind, result) => deps.materializeSourceWork(runId, claimKey, kind, result),
        deadlineMs,
      })
    } catch (error) {
      const deadlineReached = Date.now() >= deadlineMs
      const sourceBudgetReached = error instanceof Error && error.message === 'source_budget_exhausted'
      discovered = { items: deadlineReached ? [] : Array.from({ length: sourceBudgetReached ? 1 : end - start }, (_, index) => ({
        ordinal: start + index, candidate: null,
        reasonCode: sourceBudgetReached ? 'source_budget_exhausted' : 'source_adapter_unavailable',
      })), sourceExhausted: false, deadlineReached }
    }
    sourceExhausted = discovered.sourceExhausted
    sourceDeadlineReached = discovered.deadlineReached
    for (const item of discovered.items) if (!existing.has(item.ordinal)) await deps.saveDiscoveryCandidate(context.batchId, item.ordinal, item.candidate, item.reasonCode)
    candidates = await deps.getDiscoveryCandidates(context.batchId, start, end)
  }
  const byOrdinal = new Map(candidates.map(candidate => [candidate.ordinal, candidate]))
  const results: CandidateOutcome[] = []
  let nextIndex = start
  let hardLimitReached = false
  let qualified = context.qualifiedCount + deferredQualified
  for (let ordinal = start; ordinal < end; ordinal += 1) {
    const candidate = byOrdinal.get(ordinal)
    if (!candidate) break
    const result = await deps.processDiscoveryCandidate(runId, candidate, deadlineMs)
    results.push(result)
    nextIndex = ordinal + 1
    qualified += result.qualified
    if (qualified >= context.qualifiedTarget || result.targetReached) break
    if (['source_budget_exhausted', 'research_budget_exhausted', 'groq_budget_exhausted'].includes(result.reasonCode)) {
      hardLimitReached = true
      break
    }
  }
  return { outcomes: [...deferredOutcomes, ...results], nextIndex, sourceExhausted,
    deadlineReached: sourceDeadlineReached || Date.now() >= deadlineMs, hardLimitReached }
}
