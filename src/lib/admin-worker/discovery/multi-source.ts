import { createHash } from 'node:crypto'
import { catalogRevision, discoverySourceAdapters, type DiscoverySourceAdapter, type DiscoverySourceId, type DiscoverySourceState, type SourceEntry } from './sources/adapter'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { WorkerMailInfrastructureError, type ProviderHistory } from './provider-history'
import { sourceObservation, type DiscoverySourceStore, type SourceObservation } from './source-repository'
import type { SourceWorkLoader, SourceWorkMaterializer } from './registry'
import { normalizeWorkerIdentity } from '../normalization'
import { ApifyPublisherMismatchError } from './sources/open-catalogs'
import { discoverySourceCatalog } from './sources/catalog'

const CACHE_MS = 24 * 60 * 60 * 1000
class SourcePaused extends Error {}
class SourceHttpFailure extends Error {
  constructor(readonly status: number, readonly retryAt: number | null) { super('discovery_source_http_error') }
}

function providerDomain(domain: string): string | null {
  try { return normalizeWorkerIdentity('domain', domain) } catch { return null }
}

/** Shared catalog dispatcher; lifecycle, research and qualification stay in the existing Worker. */
export async function discoverMultiSourceRange(input: {
  rootRunNumber: number; start: number; end: number
  loadSourceWork: SourceWorkLoader; materializeSourceWork: SourceWorkMaterializer
  sourceStore: DiscoverySourceStore
  providerHistory?: (domains: string[]) => Promise<ProviderHistory[]>
  prioritizeProviders?: (domains: string[]) => Promise<string[]>
  fetcher?: DiscoveryFetcher; deadlineMs?: number
  adapters?: readonly DiscoverySourceAdapter[]
  now?: () => number
}): Promise<{ items: SourceObservation[]; sourceExhausted: boolean; deadlineReached: boolean }> {
  const now = input.now ?? Date.now
  const configured = input.adapters ?? discoverySourceAdapters
  if (configured.some(adapter => discoverySourceCatalog.find(source => source.id === adapter.id)?.status !== 'ACTIVE-READY')) {
    throw new WorkerMailInfrastructureError('worker_discovery_source_not_authorized')
  }
  if (now() >= (input.deadlineMs ?? Infinity) || !await input.sourceStore.running()) {
    return { items: [], sourceExhausted: false, deadlineReached: now() >= (input.deadlineMs ?? Infinity) }
  }
  let plan = await input.loadSourceWork('sources:plan') as { kind: string; multiSource: number; providers: string[] } | null
  const freshPlan = !plan
  if (!plan) plan = await input.materializeSourceWork('sources:plan', 'provider_plan', {
    kind: 'provider_plan', providers: configured.map(adapter => adapter.id), multiSource: 1,
  }) as { kind: string; multiSource: number; providers: string[] } | null
  if (!plan) throw new Error('source_budget_exhausted')
  if (plan.kind !== 'provider_plan' || plan.multiSource !== 1 || !Array.isArray(plan.providers)
    || new Set(plan.providers).size !== plan.providers.length || !plan.providers.length || plan.providers.some(id => !configured.some(adapter => adapter.id === id))) {
    throw new WorkerMailInfrastructureError('worker_discovery_plan_invalid')
  }
  const adapters = plan.providers.map(id => configured.find(adapter => adapter.id === id)!)
  const states = new Map<DiscoverySourceId, DiscoverySourceState>()
  const unavailable = new Set<DiscoverySourceId>()
  const prepared = new Set<DiscoverySourceId>()
  let budgetReached = false
  const items: SourceObservation[] = []
  const deadline = () => now() >= (input.deadlineMs ?? Infinity)
  const active = async () => !deadline() && await input.sourceStore.running()
  const read = async (id: DiscoverySourceId) => {
    if (!states.has(id)) states.set(id, await input.sourceStore.read(id))
    return states.get(id)!
  }
  const requestsBySlot = new Map<string, number>()
  const fetcher = (adapter: DiscoverySourceAdapter, ordinal: number): DiscoveryFetcher => {
    const slot = `${adapter.id}:${ordinal}`
    return async (url, options) => {
      const requestId = createHash('sha256').update(url).digest('hex').slice(0, 32)
      if (!await active()) throw new SourcePaused('discovery_stopped')
      // Includes redirects for the default transport. Custom test transports issue one request.
      const beforeRequest = async () => {
        if (!await active()) throw new SourcePaused('discovery_stopped')
        const requests = (requestsBySlot.get(slot) ?? 0) + 1
        requestsBySlot.set(slot, requests)
        if (requests > 6 || !await input.sourceStore.request(`source:${slot}:${requestId}:${requests}`)) {
          budgetReached = true
          throw new SourcePaused('source_budget_exhausted')
        }
      }
      let response: Awaited<ReturnType<DiscoveryFetcher>>
      if (!input.fetcher) response = await boundedDiscoveryFetch(url, { ...options, beforeRequest })
      else {
        await beforeRequest()
        let first = true
        response = await input.fetcher(url, { ...options, beforeRequest: async () => {
          if (first) { first = false; return }
          await beforeRequest()
        } })
      }
      if (response.status < 200 || response.status >= 300) {
        const header = response.retryAfter
        const retryAt = header ? (/^\d+$/.test(header) ? now() + Number(header) * 1000 : Date.parse(header)) : NaN
        throw new SourceHttpFailure(response.status, Number.isFinite(new Date(retryAt).getTime()) ? retryAt : null)
      }
      return response
    }
  }
  const failure = async (state: DiscoverySourceState, error: unknown, rotateEntry = false) => {
    if (error instanceof WorkerMailInfrastructureError || error instanceof SourcePaused) throw error
    const failures = Math.min(16, state.snapshot.failures + 1)
    const { entries, cursor } = state.snapshot
    // Retain a failed profile behind the other unconsumed records, including across Resume.
    const pending = rotateEntry ? [...entries.slice(0, cursor), ...entries.slice(cursor + 1), entries[cursor]] : entries
    const saved = await input.sourceStore.update(state, { ...state.snapshot, entries: pending, failures,
      retryAfter: new Date(Math.max(now() + Math.min(CACHE_MS, 60_000 * 2 ** (failures - 1)),
        error instanceof SourceHttpFailure ? (error.status === 402 && ['x402_list', 'payapi_market', 'bolthub'].includes(state.sourceId)
          ? Math.max(now() + CACHE_MS, error.retryAt ?? 0) : error.retryAt ?? 0) : 0)).toISOString() })
    if (!saved) throw new SourcePaused('discovery_stopped')
    states.set(state.sourceId, saved)
    unavailable.add(state.sourceId)
  }
  const prepare = async (adapter: DiscoverySourceAdapter, ordinal: number): Promise<DiscoverySourceState | null> => {
    let state = await read(adapter.id)
    let prioritized = false
    if (unavailable.has(adapter.id) || (state.snapshot.retryAfter && Date.parse(state.snapshot.retryAfter) > now())) return null
    const advancePage = state.snapshot.cursor >= state.snapshot.entries.length && state.snapshot.nextPage != null
    if (advancePage || !state.snapshot.refreshAfter || Date.parse(state.snapshot.refreshAfter) <= now()) {
      let entries: SourceEntry[]
      let nextPage: string | null = null
      try {
        const page = await adapter.catalog(fetcher(adapter, ordinal), advancePage ? state.snapshot.nextPage : null)
        entries = Array.isArray(page) ? page : page.entries
        nextPage = Array.isArray(page) ? null : page.nextPage
        if (advancePage && nextPage === state.snapshot.nextPage) throw new Error('discovery_source_page_stalled')
        // Leave headroom for snapshot metadata and PostgreSQL JSONB spacing.
        if (entries.length > 2000 || Buffer.byteLength(JSON.stringify(entries, null, 1)) > 500_000) {
          throw new Error('discovery_catalog_too_large')
        }
      }
      catch (error) { await failure(state, error); return null }
      const revision = catalogRevision(entries)
      let cursor = advancePage ? 0 : state.snapshot.cursor
      if (advancePage || revision !== state.snapshot.revision) {
        const consumed = new Set(advancePage ? [] : state.snapshot.entries.slice(0, cursor).map(entry => entry.id))
        const prefix = entries.filter(entry => consumed.has(entry.id))
        const rest = entries.filter(entry => !consumed.has(entry.id))
        const domains = [...new Set(rest.map(entry => entry.domain).filter(domain => providerDomain(domain) !== null))]
        const order = input.prioritizeProviders ? await input.prioritizeProviders(domains) : domains
        const ranks = new Map(order.map((domain, index) => [domain, index]))
        rest.sort((a, b) => (ranks.get(a.domain) ?? Infinity) - (ranks.get(b.domain) ?? Infinity))
        prioritized = true
        entries = [...prefix, ...rest]
        cursor = prefix.length
      } else entries = state.snapshot.entries
      const saved = await input.sourceStore.update(state, { entries, cursor, revision, nextPage,
        fetchedAt: new Date(now()).toISOString(), refreshAfter: new Date(now() + CACHE_MS).toISOString(), retryAfter: null, failures: 0 })
      if (!saved) throw new SourcePaused('discovery_stopped')
      states.set(adapter.id, state = saved)
    }
    if (freshPlan && !prioritized && !prepared.has(adapter.id) && input.prioritizeProviders && state.snapshot.cursor < state.snapshot.entries.length) {
      const prefix = state.snapshot.entries.slice(0, state.snapshot.cursor)
      const rest = state.snapshot.entries.slice(state.snapshot.cursor)
      const order = await input.prioritizeProviders([...new Set(rest.map(entry => entry.domain).filter(domain => providerDomain(domain) !== null))])
      const ranks = new Map(order.map((domain, index) => [domain, index]))
      rest.sort((a, b) => (ranks.get(a.domain) ?? Infinity) - (ranks.get(b.domain) ?? Infinity))
      const saved = await input.sourceStore.update(state, { ...state.snapshot, entries: [...prefix, ...rest] })
      if (!saved) throw new SourcePaused('discovery_stopped')
      states.set(adapter.id, state = saved)
    }
    prepared.add(adapter.id)
    return state.snapshot.cursor < state.snapshot.entries.length ? state : null
  }
  for (let ordinal = input.start; ordinal < input.end; ordinal += 1) {
    if (!await active()) break
    const replay = await input.loadSourceWork(`candidate:${ordinal}`) as SourceObservation | null
    if (replay) {
      items.push(sourceObservation(replay, ordinal))
      continue
    }
    let observed = false
    try {
      for (let offset = 0; offset < adapters.length; offset += 1) {
        const adapter = adapters[(input.rootRunNumber - 1 + ordinal + offset) % adapters.length]
        let state: DiscoverySourceState | null
        try { state = await prepare(adapter, ordinal) }
        catch (error) { await failure(await read(adapter.id), error); continue }
        if (!state) continue
        let entry = state.snapshot.entries[state.snapshot.cursor]
        let invalidProfile = false
        if (adapter.resolve) {
          try { entry = await adapter.resolve(entry, fetcher(adapter, ordinal)) }
          catch (error) {
            if (error instanceof ApifyPublisherMismatchError || (error instanceof SourceHttpFailure && [404, 410].includes(error.status))) invalidProfile = true
            else { await failure(state, error, true); continue }
          }
        }
        const domain = providerDomain(entry.domain)
        const invalidIdentity = !!entry.domain && domain === null
        const history = !invalidProfile && domain && input.providerHistory ? await input.providerHistory([domain]) : []
        let candidate: SourceObservation['candidate'] = null
        let reasonCode = invalidProfile ? 'source_record_invalid' : invalidIdentity ? 'provider_identity_invalid' : 'provider_identity_processed'
        if (!invalidProfile && !invalidIdentity && !history.length) {
          try { candidate = await adapter.candidate(entry, fetcher(adapter, ordinal), input.rootRunNumber + ordinal) }
          catch (error) {
            if (!(error instanceof SourceHttpFailure && [404, 410].includes(error.status))) { await failure(state, error); continue }
          }
          reasonCode = 'source_record_invalid'
        }
        const result: SourceObservation = { kind: 'candidate', ordinal, candidate, reasonCode, domain: entry.domain || undefined }
        const saved = await input.sourceStore.observe(state, result)
        if (!saved) {
          budgetReached = await active()
          throw new SourcePaused(budgetReached ? 'source_budget_exhausted' : 'discovery_stopped')
        }
        items.push(sourceObservation(saved, ordinal))
        // The atomic RPC persists the observation/candidate before advancing this frontier.
        states.set(adapter.id, { ...state, version: state.version + 1,
          snapshot: { ...state.snapshot, cursor: state.snapshot.cursor + 1, failures: 0, retryAfter: null } })
        observed = true
        break
      }
    } catch (error) {
      if (!(error instanceof SourcePaused)) throw error
      if (budgetReached) {
        const result: SourceObservation = { kind: 'candidate', ordinal, candidate: null, reasonCode: 'source_budget_exhausted' }
        items.push(result)
      }
      break
    }
    // Exhausted or cooling sources have no eligible work in this run. Their cursors remain durable.
    if (!observed) return { items, sourceExhausted: true, deadlineReached: deadline() }
  }
  return { items, sourceExhausted: false, deadlineReached: deadline() }
}
