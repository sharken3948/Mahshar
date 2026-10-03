import 'server-only'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { fetchApisGuruCandidates, fetchApisGuruProviderNames } from './sources/apis-guru'
import type { RawCandidate } from './types'

export type SourceWorkKind = 'provider_window' | 'candidate'
export type SourceWorkLoader = (claimKey: string) => Promise<unknown | null>
export type SourceWorkMaterializer = (claimKey: string, kind: SourceWorkKind, result: unknown) => Promise<unknown | null>

type CandidateResult = { kind: 'candidate'; ordinal: number; candidate: RawCandidate | null; reasonCode?: string }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function providerWindow(value: unknown, expected: number): string[] | null {
  const item = record(value)
  const providers = item?.kind === 'provider_window' ? item.providers : null
  return Array.isArray(providers) && providers.length === expected
    && providers.every(provider => typeof provider === 'string') ? providers : null
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
}): Promise<Array<{ ordinal: number; candidate: RawCandidate | null; reasonCode?: string }>> {
  const fetcher = input.fetcher ?? boundedDiscoveryFetch
  const windowKey = `providers:${input.start}`
  let selectedProviders = providerWindow(await input.loadSourceWork(windowKey), input.end - input.start)
  if (!selectedProviders) {
    const providers = await fetchApisGuruProviderNames(fetcher)
    const startOffset = ((input.rootRunNumber - 1) * 50) % providers.length
    const proposed = Array.from({ length: input.end - input.start }, (_, index) => providers[(startOffset + input.start + index) % providers.length])
    selectedProviders = providerWindow(await input.materializeSourceWork(windowKey, 'provider_window', {
      kind: 'provider_window', providers: proposed,
    }), input.end - input.start)
    if (!selectedProviders) throw new Error('source_budget_exhausted')
  }
  const results: Array<{ ordinal: number; candidate: RawCandidate | null; reasonCode?: string }> = []
  for (let ordinal = input.start; ordinal < input.end; ordinal += 1) {
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      results.push({ ordinal, candidate: null, reasonCode: 'run_budget_exhausted' })
      continue
    }
    const claimKey = `candidate:${ordinal}`
    let stored = candidateResult(await input.loadSourceWork(claimKey), ordinal)
    if (!stored) {
      const provider = selectedProviders[ordinal - input.start]
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
  return results
}
