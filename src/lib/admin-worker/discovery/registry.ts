import 'server-only'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { fetchApisGuruCandidates, fetchApisGuruProviderNames } from './sources/apis-guru'
import type { RawCandidate } from './types'

export type SourceWorkKind = 'provider_plan' | 'provider_window' | 'candidate'
export type SourceWorkLoader = (claimKey: string) => Promise<unknown | null>
export type SourceWorkMaterializer = (claimKey: string, kind: SourceWorkKind, result: unknown) => Promise<unknown | null>

type CandidateResult = { kind: 'candidate'; ordinal: number; candidate: RawCandidate | null; reasonCode?: string }
type ProviderPlan = { providers: string[]; sourceExhausted: boolean }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function providerPlan(value: unknown): ProviderPlan | null {
  const item = record(value)
  const providers = item?.kind === 'provider_plan' ? item.providers : null
  return Array.isArray(providers) && providers.length <= 300
    && providers.every(provider => typeof provider === 'string')
    && typeof item?.sourceExhausted === 'boolean'
    ? { providers, sourceExhausted: item.sourceExhausted } : null
}

function candidateResult(value: unknown, ordinal: number): CandidateResult | null {
  const item = record(value)
  if (!item || item.kind !== 'candidate' || item.ordinal !== ordinal) return null
  if (item.candidate !== null && !record(item.candidate)) return null
  if (item.reasonCode !== undefined && typeof item.reasonCode !== 'string') return null
  return item as CandidateResult
}

export async function discoverApiDirectoryRange(input: {
  rootRunNumber: number
  start: number
  end: number
  loadSourceWork: SourceWorkLoader
  materializeSourceWork: SourceWorkMaterializer
  fetcher?: DiscoveryFetcher
  deadlineMs?: number
}): Promise<{ items: Array<{ ordinal: number; candidate: RawCandidate | null; reasonCode?: string }>; sourceExhausted: boolean; deadlineReached: boolean }> {
  const fetcher = input.fetcher ?? boundedDiscoveryFetch
  const planKey = 'providers:plan'
  let plan = providerPlan(await input.loadSourceWork(planKey))
  if (!plan) {
    const providers = await fetchApisGuruProviderNames(fetcher)
    const startOffset = ((input.rootRunNumber - 1) * 50) % providers.length
    const rotated = [...providers.slice(startOffset), ...providers.slice(0, startOffset)]
    plan = providerPlan(await input.materializeSourceWork(planKey, 'provider_plan', {
      kind: 'provider_plan', providers: rotated.slice(0, 300), sourceExhausted: rotated.length <= 300,
    }))
    if (!plan) throw new Error('source_budget_exhausted')
  }
  const selectedProviders = plan.providers.slice(input.start, input.end)
  const results: Array<{ ordinal: number; candidate: RawCandidate | null; reasonCode?: string }> = []
  let deadlineReached = false
  for (let index = 0; index < selectedProviders.length; index += 1) {
    const ordinal = input.start + index
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      deadlineReached = true
      break
    }
    const claimKey = `candidate:${ordinal}`
    let stored = candidateResult(await input.loadSourceWork(claimKey), ordinal)
    if (!stored) {
      const provider = selectedProviders[index]
      let proposed: CandidateResult
      try {
        const candidates = await fetchApisGuruCandidates(fetcher, provider)
        proposed = { kind: 'candidate', ordinal,
          candidate: candidates.length ? candidates[(input.rootRunNumber + ordinal) % candidates.length] : null,
          reasonCode: 'source_record_invalid' }
      } catch {
        proposed = { kind: 'candidate', ordinal, candidate: null, reasonCode: 'source_fetch_failed' }
      }
      stored = candidateResult(await input.materializeSourceWork(claimKey, 'candidate', proposed), ordinal)
      if (!stored) {
        results.push({ ordinal, candidate: null, reasonCode: 'source_budget_exhausted' })
        continue
      }
    }
    results.push({ ordinal, candidate: stored.candidate, reasonCode: stored.reasonCode })
  }
  return { items: results,
    sourceExhausted: plan.sourceExhausted && input.end >= plan.providers.length && !deadlineReached, deadlineReached }
}
