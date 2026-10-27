import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { DISCOVERY_SOURCES, freshDiscovery, sourcePage, type Source } from './sources'
import { AccessError, Network } from './network'
import { evaluate } from './pipeline'
import { DatabaseStore, type Store } from './store'

export async function databaseStore() { return new DatabaseStore(createServiceClient()) }

async function discoverBatch(store: Store, generation: string, transport: Network, sources: Source[]) {
  if (!store.discoveryState || !store.saveDiscovery) return
  const saved = await store.discoveryState()
  let progress = structuredClone(saved.progress ?? freshDiscovery()), pending = saved.pending
  if (progress.refreshAt) {
    if (Date.parse(progress.refreshAt) > Date.now()) return
    progress = freshDiscovery(); pending = []
  }
  const source = sources[progress.source]
  if (!source) {
    // Polling backoff after a finite pass; not an admission/request quota.
    progress.refreshAt = new Date(Date.now() + 3600_000).toISOString()
    await store.saveDiscovery(generation, progress, [], [], null, saved.progress)
    return
  }
  progress.stats[source.id] ??= { name: source.name, pages: 0, observed: 0, admitted: 0, duplicates: 0, errors: [] }
  const stats = progress.stats[source.id]
  if (!pending.length) {
    if (!progress.seen.includes(source.url)) progress.urls = [source.url]
    const url = progress.urls.shift()
    if (!url) { progress.source++; progress.seen = []; await store.saveDiscovery(generation, progress, [], [], null, saved.progress); return }
    try {
      const page = await transport.page(url)
      if (page.status !== 200) throw new Error(`http_${page.status}`)
      const found = sourcePage(source, page)
      pending = found.leads; stats.observed += pending.length
      progress.urls.push(...found.next.filter(next => !progress.seen.includes(next) && !progress.urls.includes(next) && next !== url))
    } catch (error) {
      // An unavailable catalogue page must not block independent sources.
      stats.errors.push(url + ': ' + (error instanceof AccessError || error instanceof Error ? error.message : 'source_unavailable'))
    }
    stats.pages++; progress.seen.push(url)
  }
  const batch = pending.slice(0, 50), remaining = pending.slice(50)
  if (!remaining.length && !progress.urls.length) { progress.source++; progress.seen = [] }
  await store.saveDiscovery(generation, progress, remaining, batch, source.id, saved.progress)
}

export type StepResult = 'continue' | 'done' | { waitUntil: string }
/** A finite batch of the existing inventory; three in flight, fifty per durable step. */
export async function tick(store: Store, generation: string, network?: Network, sources: Source[] = DISCOVERY_SOURCES): Promise<StepResult> {
  const state = await store.state()
  if (state.status !== 'running' || state.generation !== generation) return 'done'
  // Stop fences new claims. In-flight candidates finish and save their evidence safely.
  const transport = network ?? new Network(undefined, state.cooldowns, undefined, undefined, async () => {
    const current = await store.state()
    return current.status === 'running' && current.generation === generation
  })
  try {
    // Phase 1 databases do not enable discovery until the additive migration is applied.
    if ('discovery' in state) await discoverBatch(store, generation, transport, sources)
    let processed = 0
    while (processed < 50) {
      const rows = await store.claim(generation, Math.min(3, 50 - processed))
      if (!rows.length) break
      const outcomes = await Promise.allSettled(rows.map(async row => {
        const current = await store.state()
        if (current.status !== 'running' || current.generation !== generation) {
          await store.release(row); return
        }
        await store.save(row, await evaluate(row.lead, transport, row.result, result => store.checkpoint?.(row, result) ?? Promise.resolve()))
      }))
      // Wait for every in-flight save before releasing the batch's document memory.
      const failed = outcomes.find(outcome => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      processed += rows.length
    }
    await store.finish(generation, transport.pauses)
    const current = await store.state()
    if (current.status !== 'running' || current.generation !== generation) return 'done'
    if (current.discovery?.refreshAt && Date.parse(current.discovery.refreshAt) > Date.now() && processed < 50) return { waitUntil: current.discovery.refreshAt }
    return 'continue'
  } finally { transport.clearDocuments() }
}
export async function workerStep(generation: string) {
  'use step'
  const store = await databaseStore()
  try { return await tick(store, generation) }
  catch {
    await store.finish(generation, {}, 'Processing interrupted; saved results retained. Resume after active leases expire.')
    return 'done'
  }
}
