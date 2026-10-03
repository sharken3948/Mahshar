import 'server-only'
import { normalizeWorkerIdentity, normalizeWorkerProductKey } from '../normalization'
import { WORKER_QUALIFICATION_MODEL, qualifiesForMahshar, qualifyCandidate } from './qualification'
import { deterministicCandidateFilter } from './filters'
import { discoverApiDirectoryRange } from './registry'
import { researchCandidate } from './research'
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
  return { status, reasonCode, discovered: 1, duplicate: 0, filtered: 0, qualified: 0, persisted: 0, ...values }
}

function replayOutcome(candidate: DurableCandidate, discovered = 1): CandidateOutcome {
  const references = { providerId: candidate.providerId ?? undefined, productId: candidate.productId ?? undefined, leadId: candidate.leadId ?? undefined, discovered }
  if (candidate.status === 'persisted') return outcome('persisted', candidate.reasonCode ?? 'qualified', { ...references, qualified: 1, persisted: 1 })
  if (candidate.status === 'filtered') return outcome('filtered', candidate.reasonCode ?? 'filtered', { ...references, filtered: 1 })
  if (candidate.status === 'duplicate' || candidate.status === 'blocked') return outcome(candidate.status, candidate.reasonCode ?? 'duplicate', { ...references, duplicate: 1 })
  if (candidate.status === 'deferred') return outcome('deferred', candidate.reasonCode ?? 'qualification_deferred', references)
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
  if (candidate.leadId && candidate.leadId === current.leadId && current.reasonCode === 'existing_qualified_lead') {
    const result = outcome('persisted', 'qualified', { ...current, discovered, qualified: 1, persisted: 1 })
    await deps.markDiscoveryCandidate(candidate, result, domain, productKey)
    return result
  }
  if (candidate.leadId && candidate.leadId === current.leadId && current.reasonCode === 'existing_rejected_lead') {
    const result = outcome('filtered', 'fit_below_threshold', { ...current, discovered, filtered: 1 })
    await deps.markDiscoveryCandidate(candidate, result, domain, productKey)
    return result
  }
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
    const result = outcome('deferred', 'run_budget_exhausted', { discovered })
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
      const result = outcome(deferred ? 'deferred' : 'filtered', reason, { discovered, filtered: deferred ? 0 : 1 })
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
    const persisted = await deps.saveQualification({ candidate, ...entity, qualified: false, deferredReason: reason })
    return outcome(persisted.status, persisted.reasonCode, { ...entity, discovered,
      duplicate: persisted.status === 'duplicate' || persisted.status === 'blocked' ? 1 : 0,
      filtered: persisted.status === 'filtered' ? 1 : 0,
      qualified: persisted.status === 'persisted' ? 1 : 0, persisted: persisted.status === 'persisted' ? 1 : 0 })
  }
  let qualification: Awaited<ReturnType<typeof qualifyCandidate>>
  try {
    qualification = await deps.qualifyCandidate(candidate, facts)
  } catch {
    const persisted = await deps.saveQualification({ candidate, ...entity, qualified: false, deferredReason: 'groq_qualification_failed' })
    return outcome(persisted.status, persisted.reasonCode, { ...entity, discovered,
      duplicate: persisted.status === 'duplicate' || persisted.status === 'blocked' ? 1 : 0,
      filtered: persisted.status === 'filtered' ? 1 : 0 })
  }
  const persisted = await deps.saveQualification({ candidate, ...entity, result: qualification,
    model: WORKER_QUALIFICATION_MODEL, qualified: qualifiesForMahshar(qualification) })
  return outcome(persisted.status, persisted.reasonCode, { ...entity, discovered,
    duplicate: persisted.status === 'duplicate' || persisted.status === 'blocked' ? 1 : 0,
    filtered: persisted.status === 'filtered' ? 1 : 0,
    qualified: persisted.status === 'persisted' ? 1 : 0, persisted: persisted.status === 'persisted' ? 1 : 0 })
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
  runId: string, batchId: string, deadlineMs: number, deps: DiscoveryRangeDependencies,
): Promise<CandidateOutcome[]> {
  const candidates = await deps.claimDeferredCandidates(runId, batchId, DEFERRED_SLICE)
  const outcomes: CandidateOutcome[] = []
  for (const candidate of candidates) {
    try { outcomes.push(await deps.processDiscoveryCandidate(runId, candidate, deadlineMs, {}, true)) }
    catch { /* A deferred item remains durable and must not poison fresh discovery. */ }
  }
  return outcomes
}

export async function processDiscoveryRange(
  runId: string, start: number, end: number, dependencies: Partial<DiscoveryRangeDependencies> = {},
): Promise<CandidateOutcome[]> {
  const deps = { ...defaultRangeDependencies, ...dependencies }
  const context = await deps.getDiscoveryRunContext(runId)
  const deadlineMs = Date.parse(context.deadlineAt)
  const deferredOutcomes = start === 0 && runId === context.batchId
    ? await drainDeferredWithDependencies(runId, context.batchId, deadlineMs, deps) : []
  let candidates = await deps.getDiscoveryCandidates(context.batchId, start, end)
  const existing = new Set(candidates.map(candidate => candidate.ordinal))
  if (Date.now() >= deadlineMs) {
    for (let ordinal = start; ordinal < end; ordinal += 1) if (!existing.has(ordinal)) await deps.saveDiscoveryCandidate(context.batchId, ordinal, null, 'run_budget_exhausted')
    candidates = await deps.getDiscoveryCandidates(context.batchId, start, end)
    const results: CandidateOutcome[] = []
    for (const candidate of candidates) {
      const result = candidate.status === 'pending' ? outcome('deferred', 'run_budget_exhausted') : replayOutcome(candidate)
      if (candidate.status === 'pending') await deps.markDiscoveryCandidate(candidate, result)
      results.push(result)
    }
    return [...deferredOutcomes, ...results]
  }
  if (existing.size < end - start) {
    let discovered: Awaited<ReturnType<typeof discoverApiDirectoryRange>>
    try {
      discovered = await deps.discoverApiDirectoryRange({
        rootRunNumber: context.rootRunNumber, start, end,
        loadSourceWork: claimKey => deps.getMaterializedSourceWork(context.batchId, claimKey),
        materializeSourceWork: (claimKey, kind, result) => deps.materializeSourceWork(runId, claimKey, kind, result),
        deadlineMs,
      })
    } catch {
      discovered = Array.from({ length: end - start }, (_, index) => ({
        ordinal: start + index, candidate: null, reasonCode: 'source_adapter_unavailable',
      }))
    }
    for (const item of discovered) if (!existing.has(item.ordinal)) await deps.saveDiscoveryCandidate(context.batchId, item.ordinal, item.candidate, item.reasonCode)
    candidates = await deps.getDiscoveryCandidates(context.batchId, start, end)
  }
  const byOrdinal = new Map(candidates.map(candidate => [candidate.ordinal, candidate]))
  const results: CandidateOutcome[] = []
  for (let ordinal = start; ordinal < end; ordinal += 1) {
    const candidate = byOrdinal.get(ordinal)
    results.push(candidate ? await deps.processDiscoveryCandidate(runId, candidate, deadlineMs) : outcome('filtered', 'source_record_missing', { filtered: 1 }))
  }
  return [...deferredOutcomes, ...results]
}
