import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverMultiSourceRange } from '../../src/lib/admin-worker/discovery/multi-source'
import { discoverySourceAdapters, parsePublicApiLists, PUBLIC_API_LISTS_URL, type DiscoverySourceId, type DiscoverySourceState } from '../../src/lib/admin-worker/discovery/sources/adapter'
import { WorkerMailInfrastructureError, type ProviderHistory } from '../../src/lib/admin-worker/discovery/provider-history'
import { discoverySourceStore, sourceState, type DiscoverySourceStore, type SourceObservation } from '../../src/lib/admin-worker/discovery/source-repository'
import { researchCandidate } from '../../src/lib/admin-worker/discovery/research'
import { processDiscoveryCandidate, processDiscoveryRange, type DiscoveryRangeDependencies } from '../../src/lib/admin-worker/discovery/processor'
import type { CandidateOutcome, DurableCandidate } from '../../src/lib/admin-worker/discovery/types'
import { boundary } from '../admin/fixture'
import { boundedDiscoveryFetch, DiscoveryResponseTooLargeError } from '../../src/lib/admin-worker/discovery/fetch'

function harness() {
  let batch = 1
  let now = Date.now()
  let running = true
  let permitRequest = true
  let failPublic = false
  let crashAfterObserve = false
  const states = new Map<DiscoverySourceId, DiscoverySourceState>(discoverySourceAdapters.map(adapter => [adapter.id, {
    sourceId: adapter.id, version: 0, snapshot: { entries: [], cursor: 0, revision: null, fetchedAt: null, refreshAfter: null, retryAfter: null, failures: 0 },
  }]))
  const work = new Map<string, unknown>()
  const requests: string[] = []
  const publicEntries = ['a', 'b', 'c', 'd'].map(name => ({ name: `${name.toUpperCase()} API`, url: `https://${name}.example/docs`, description: 'Commercial JSON API' }))
  const gurus = ['e.example', 'f.example', 'g.example', 'h.example']
  const history = new Map<string, ProviderHistory>()
  const store: DiscoverySourceStore = {
    read: async id => structuredClone(states.get(id)!),
    update: async (state, snapshot) => {
      assert.equal(states.get(state.sourceId)!.version, state.version)
      if (!running) return null
      const saved = { ...state, snapshot, version: state.version + 1 }
      states.set(state.sourceId, structuredClone(saved))
      return saved
    },
    observe: async (state, result) => {
      if (!running) return null
      const key = `${batch}:candidate:${result.ordinal}`
      if (work.has(key)) return structuredClone(work.get(key) as SourceObservation)
      assert.equal(states.get(state.sourceId)!.version, state.version)
      work.set(key, structuredClone(result))
      states.set(state.sourceId, { ...state, version: state.version + 1, snapshot: { ...state.snapshot, cursor: state.snapshot.cursor + 1, failures: 0, retryAfter: null } })
      if (crashAfterObserve) { crashAfterObserve = false; throw new WorkerMailInfrastructureError('lost_database_response') }
      return structuredClone(result)
    },
    running: async () => running,
    request: async () => permitRequest,
  }
  const input = (start = 0, end = 4) => ({
    rootRunNumber: batch, start, end, sourceStore: store, now: () => now, deadlineMs: now + 60_000,
    adapters: discoverySourceAdapters.filter(adapter => ['apis_guru', 'public_api_lists'].includes(adapter.id)),
    providerHistory: async (domains: string[]) => domains.flatMap(domain => history.has(domain) ? [history.get(domain)!] : []),
    prioritizeProviders: async (domains: string[]) => [...domains.filter(domain => !history.has(domain)), ...domains.filter(domain => history.has(domain))],
    loadSourceWork: async (key: string) => work.get(`${batch}:${key}`) ?? null,
    materializeSourceWork: async (key: string, _kind: unknown, value: unknown) => { work.set(`${batch}:${key}`, structuredClone(value)); return value },
    fetcher: async (url: string) => {
      requests.push(url)
      if (url === PUBLIC_API_LISTS_URL) return { url, status: failPublic ? 429 : 200, retryAfter: '600', contentType: 'application/json', body: JSON.stringify({ entries: publicEntries }) }
      if (url.endsWith('providers.json')) return { url, status: 200, contentType: 'application/json', body: JSON.stringify({ data: gurus }) }
      const domain = url.split('/').at(-1)!.replace(/\.json$/, '')
      return { url, status: 200, contentType: 'application/json', body: JSON.stringify({ apis: { weather: {
        info: { title: `${domain} API` }, swaggerUrl: `https://${domain}/openapi.json`, openapi: '3.0.0',
      } } }) }
    },
  })
  return { input, states, requests, history, store, work, publicEntries, gurus,
    start: () => { batch += 1 }, advance: (ms: number) => { now += ms }, stop: () => { running = false }, resume: () => { running = true },
    rateLimit: () => { failPublic = true }, recover: () => { failPublic = false },
    exhaustBudget: () => { permitRequest = false }, crash: () => { crashAfterObserve = true },
  }
}

test('oversized amazonaws.com detail is durably quarantined across Resume, Starts and catalog refresh', async () => {
  const f = harness(); f.gurus.unshift('amazonaws.com')
  let oversized = 0
  const invoke = async (start: number, end: number) => {
    const input = f.input(start, end), original = input.fetcher
    return discoverMultiSourceRange({ ...input, fetcher: async (url, options) => {
      if (url.endsWith('/amazonaws.com.json')) {
        oversized++
        return boundedDiscoveryFetch(url, options, async () => new Response('', {
          headers: { 'content-length': '866618', 'content-type': 'application/json' },
        }))
      }
      return original(url)
    } })
  }
  const result = await invoke(0, 4)
  assert.equal(result.items.length, 4)
  assert.ok(result.items.some(item => item.candidate?.sourceId === 'apis_guru'))
  assert.ok(result.items.every(item => item.reasonCode !== 'source_adapter_unavailable'))
  const snapshot = f.states.get('apis_guru')!.snapshot
  assert.equal(snapshot.entries.at(-1)?.id, 'amazonaws.com')
  assert.equal(snapshot.entries.at(-1)?.quarantine?.reason, 'discovery_response_too_large')
  assert.ok(snapshot.cursor > 0); assert.equal(snapshot.failures, 0)
  assert.equal(snapshot.retryAfter, null); assert.equal(oversized, 1)
  f.stop(); assert.equal((await invoke(4, 6)).items.length, 0)
  f.resume(); await invoke(0, 4); assert.equal(oversized, 1, 'Resume reuses observations')
  f.start(); await invoke(0, 4); assert.equal(oversized, 1, 'A new Start cannot re-download the quarantined detail')
  f.advance(25 * 60 * 60 * 1000); f.start(); f.gurus.push('new.example')
  const after = await invoke(0, 4)
  assert.equal(oversized, 1); assert.ok(after.items.some(item => item.candidate?.discoveredDomain === 'new.example'))
  assert.equal(f.states.get('apis_guru')!.snapshot.entries.at(-1)?.quarantine?.reason, 'discovery_response_too_large')
})

test('a lost quarantine-save response does not re-download the oversized record on Resume', async () => {
  const f = harness(); f.gurus.unshift('amazonaws.com')
  const originalUpdate = f.store.update
  let crash = true, attempts = 0
  f.store.update = async (state, snapshot) => {
    const saved = await originalUpdate(state, snapshot)
    if (crash && snapshot.entries.some(entry => entry.quarantine)) {
      crash = false; throw new WorkerMailInfrastructureError('lost_quarantine_response')
    }
    return saved
  }
  const invoke = () => {
    const input = f.input(), original = input.fetcher
    return discoverMultiSourceRange({ ...input, fetcher: async url => {
      if (url.endsWith('/amazonaws.com.json')) { attempts++; throw new DiscoveryResponseTooLargeError() }
      return original(url)
    } })
  }
  await assert.rejects(invoke(), WorkerMailInfrastructureError)
  assert.equal((await invoke()).items.length, 4); assert.equal(attempts, 1)
})

test('Guru can continue past its oversized head even when every other source is exhausted', async () => {
  const f = harness(); f.gurus.unshift('amazonaws.com')
  const input = f.input(0, 2), original = input.fetcher
  let requests = 0
  const result = await discoverMultiSourceRange({ ...input,
    adapters: discoverySourceAdapters.filter(adapter => adapter.id === 'apis_guru'),
    fetcher: async url => {
      requests++
      if (url.endsWith('/amazonaws.com.json')) throw new DiscoveryResponseTooLargeError()
      return original(url)
    } })
  assert.equal(result.items.length, 2); assert.equal(result.sourceExhausted, false)
  assert.ok(result.items.every(item => item.candidate?.sourceId === 'apis_guru'))
  assert.equal(requests, 4, 'One catalog, one oversized head and two healthy providers')
})

test('quarantining an entire Guru window still respects the existing per-slot HTTP cap', async () => {
  const f = harness(); f.gurus.push(...Array.from({ length: 20 }, (_, i) => `large${i}.example`))
  const input = f.input(0, 1), original = input.fetcher
  let requests = 0
  const result = await discoverMultiSourceRange({ ...input,
    adapters: discoverySourceAdapters.filter(adapter => adapter.id === 'apis_guru'),
    fetcher: async url => {
      requests++
      if (url.endsWith('/providers.json')) return original(url)
      throw new DiscoveryResponseTooLargeError()
    } })
  assert.equal(requests, 6)
  assert.equal(f.states.get('apis_guru')!.snapshot.entries.filter(entry => entry.quarantine).length, 5)
  assert.equal(result.items[0].reasonCode, 'source_budget_exhausted')
  assert.equal(f.states.get('apis_guru')!.snapshot.cursor, 0)
})

test('Stop immediately after quarantine preserves the next healthy provider for Resume', async () => {
  const f = harness(); f.gurus.unshift('amazonaws.com')
  const update = f.store.update
  f.store.update = async (state, snapshot) => {
    const saved = await update(state, snapshot)
    if (snapshot.entries.some(entry => entry.quarantine)) f.stop()
    return saved
  }
  const invoke = () => {
    const input = f.input(0, 1), original = input.fetcher
    return discoverMultiSourceRange({ ...input,
      adapters: discoverySourceAdapters.filter(adapter => adapter.id === 'apis_guru'),
      fetcher: async url => {
        if (url.endsWith('/amazonaws.com.json')) throw new DiscoveryResponseTooLargeError()
        return original(url)
      } })
  }
  assert.equal((await invoke()).items.length, 0)
  assert.equal(f.states.get('apis_guru')!.snapshot.cursor, 0)
  f.store.update = update; f.resume()
  assert.equal((await invoke()).items[0].candidate?.discoveredDomain, 'e.example')
})

test('all eight sources retain opportunities while an oversized Guru detail is isolated', async () => {
  const f = harness(), seen = new Map<string, number>(), requests: string[] = []
  const adapters = discoverySourceAdapters.map(adapter => ({ id: adapter.id,
    catalog: async () => Array.from({ length: 12 }, (_, i) => ({ id: `${adapter.id}-${i}`, domain: `${adapter.id.replaceAll('_', '')}${i}.example` })),
    candidate: async (entry: { id: string; domain: string }, fetcher: import('../../src/lib/admin-worker/discovery/fetch').DiscoveryFetcher) => {
      await fetcher(`https://catalog.example/${entry.id}`)
      if (adapter.id === 'apis_guru' && entry.id.endsWith('-0')) throw new DiscoveryResponseTooLargeError()
      return { sourceType: 'api_directory' as const, sourceId: adapter.id, sourceRecordId: entry.id,
        sourceUrl: `https://catalog.example/${entry.id}`, discoveredName: entry.domain, discoveredDomain: entry.domain,
        discoveredProduct: 'API', discoveredDocsUrl: `https://${entry.domain}/docs` }
    } }))
  let charged = 0
  f.store.request = async () => { charged++; return charged <= 40 }
  const output = await discoverMultiSourceRange({ ...f.input(0, 32), adapters, fetcher: async url => {
    requests.push(url); return { url, status: 200, contentType: 'application/json', body: '{}' }
  } })
  for (const item of output.items) if (item.candidate?.sourceId) seen.set(item.candidate.sourceId, (seen.get(item.candidate.sourceId) ?? 0) + 1)
  assert.equal(seen.size, 8); assert.ok([...seen.values()].every(count => count >= 3 && count <= 5))
  assert.equal(charged, requests.length); assert.equal(requests.length, 33)
  assert.ok(output.items.every(item => item.candidate !== null))
  const replay = await discoverMultiSourceRange({ ...f.input(0, 32), adapters, fetcher: async () => { throw new Error('Resume must reuse durable work') } })
  assert.deepEqual(replay.items, output.items); assert.equal(charged, 33)
})

test('Public API Lists bounds, sanitizes and deduplicates observations without inventing evidence', () => {
  const entries = parsePublicApiLists({ entries: [
    { name: 'Weather API', url: 'https://api.acme.com/docs', description: 'Weather JSON API', email: 'untrusted@acme.com', verified: true },
    { name: 'Weather API', url: 'https://api.acme.com/docs' },
    { name: 'Unsafe', url: 'https://127.0.0.1/docs' }, { name: 'Plaintext', url: 'http://plain.example/docs' },
    { name: 'Marketplace', url: 'https://rapidapi.com/user/api/product' },
    { name: 'Ambiguous publisher', url: 'https://github.com/user/project' },
  ] })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].domain, 'acme.com')
  const candidate = entries[0].candidate!
  assert.equal(candidate.discoveredContractUrl, undefined)
  assert.equal(candidate.discoveredContactUrl, undefined)
  assert.equal(candidate.directoryUpdatedAt, undefined)
  assert.equal(candidate.sourceId, 'public_api_lists')
  assert.equal(candidate.sourceUrl, PUBLIC_API_LISTS_URL)
  assert.equal('email' in candidate, false)
  assert.throws(() => parsePublicApiLists({ entries: Array(2001).fill({}) }), /invalid/)
  assert.throws(() => parsePublicApiLists({ entries: [] }), /invalid/)
})

test('both real adapters alternate fairly and cache independent cursors across Starts', async () => {
  const h = harness()
  const first = await discoverMultiSourceRange(h.input())
  assert.deepEqual(first.items.map(item => item.candidate?.sourceId), ['apis_guru', 'public_api_lists', 'apis_guru', 'public_api_lists'])
  const original = first.items.map(item => item.candidate?.sourceRecordId)
  h.start()
  const second = await discoverMultiSourceRange(h.input())
  assert.deepEqual(second.items.map(item => item.candidate?.sourceId), ['public_api_lists', 'apis_guru', 'public_api_lists', 'apis_guru'])
  assert.ok(second.items.every(item => !original.includes(item.candidate?.sourceRecordId)))
  assert.equal(h.requests.filter(url => url === PUBLIC_API_LISTS_URL).length, 1)
  assert.equal(h.requests.filter(url => url.endsWith('providers.json')).length, 1)
  assert.equal(h.states.get('apis_guru')!.snapshot.cursor, 4)
  assert.equal(h.states.get('public_api_lists')!.snapshot.cursor, 4)
  h.start()
  assert.equal((await discoverMultiSourceRange(h.input())).sourceExhausted, true)
})

test('Resume replays a persisted observation after a lost response without refetching or advancing twice', async () => {
  const h = harness()
  h.crash()
  await assert.rejects(discoverMultiSourceRange(h.input(0, 1)), /lost_database_response/)
  const requests = h.requests.length
  const cursor = h.states.get('apis_guru')!.snapshot.cursor
  const resumed = await discoverMultiSourceRange(h.input(0, 1))
  assert.equal(resumed.items.length, 1)
  assert.equal(h.requests.length, requests)
  assert.equal(h.states.get('apis_guru')!.snapshot.cursor, cursor)
})

test('unchanged revisions never restart the catalog and changed revisions consume only new IDs', async () => {
  const h = harness()
  await discoverMultiSourceRange(h.input(0, 8))
  h.advance(24 * 60 * 60 * 1000 + 1); h.start()
  assert.equal((await discoverMultiSourceRange(h.input())).items.length, 0)
  const revision = h.states.get('public_api_lists')!.snapshot.revision
  h.publicEntries.push({ name: 'New API', url: 'https://new.example/docs', description: 'Commercial JSON API' })
  h.advance(24 * 60 * 60 * 1000 + 1); h.start()
  const added = await discoverMultiSourceRange(h.input())
  assert.equal(added.items.length, 1)
  assert.equal(added.items[0].candidate?.discoveredDomain, 'new.example')
  assert.notEqual(h.states.get('public_api_lists')!.snapshot.revision, revision)
})

test('unseen providers lead each catalog and finalized identities skip all detail requests', async () => {
  const h = harness()
  h.history.set('e.example', { domain: 'e.example', reason: 'manual_mail_pending', providerId: null })
  const result = await discoverMultiSourceRange(h.input(0, 2))
  assert.equal(result.items[0].candidate?.discoveredDomain, 'f.example')
  assert.equal(h.requests.some(url => url.endsWith('/e.example.json')), false)
  await discoverMultiSourceRange(h.input(2, 8))
  assert.equal(h.requests.some(url => url.endsWith('/e.example.json')), false)
})

test('429 isolates one source, persists Retry-After across Starts, and permits due recovery', async () => {
  const h = harness()
  h.rateLimit()
  const first = await discoverMultiSourceRange(h.input(0, 2))
  assert.ok(first.items.every(item => item.candidate?.sourceId === 'apis_guru'))
  const retryAt = h.states.get('public_api_lists')!.snapshot.retryAfter!
  assert.ok(Date.parse(retryAt) - Date.parse(h.states.get('apis_guru')!.snapshot.fetchedAt!) >= 600_000)
  h.start(); h.recover()
  await discoverMultiSourceRange(h.input(0, 1))
  assert.equal(h.requests.filter(url => url === PUBLIC_API_LISTS_URL).length, 1)
  h.advance(600_001); h.start()
  const recovered = await discoverMultiSourceRange(h.input(0, 2))
  assert.ok(recovered.items.some(item => item.candidate?.sourceId === 'public_api_lists'))
  assert.equal(h.states.get('public_api_lists')!.snapshot.failures, 0)
})

test('shared database failures fail closed rather than masquerading as source unavailability', async () => {
  const h = harness()
  h.store.update = async () => { throw new WorkerMailInfrastructureError('database_unavailable') }
  await assert.rejects(discoverMultiSourceRange(h.input()), /database_unavailable/)
  assert.equal(h.requests.length, 1)
})

test('Stop and deadlines prevent requests and cursor advancement; Resume retains work', async () => {
  const h = harness()
  h.stop()
  assert.equal((await discoverMultiSourceRange(h.input())).items.length, 0)
  assert.equal(h.requests.length, 0)
  h.resume()
  const expired = h.input(); expired.deadlineMs = expired.now() - 1
  assert.equal((await discoverMultiSourceRange(expired)).deadlineReached, true)
  assert.equal(h.requests.length, 0)
  const observe = h.store.observe
  h.store.observe = async (...args) => { h.stop(); return observe(...args) }
  assert.equal((await discoverMultiSourceRange(h.input())).items.length, 0)
  assert.equal(h.states.get('apis_guru')!.snapshot.cursor, 0)
  h.store.observe = observe; h.resume()
  assert.equal((await discoverMultiSourceRange(h.input(0, 1))).items.length, 1)
})

test('source request budget exhaustion produces the existing hard-limit outcome', async () => {
  const h = harness(); h.exhaustBudget()
  const result = await discoverMultiSourceRange(h.input())
  assert.equal(result.items[0].reasonCode, 'source_budget_exhausted')
  assert.equal(h.requests.length, 0)
  assert.equal(h.states.get('apis_guru')!.snapshot.cursor, 0)
})

test('directory assertions cannot satisfy OpenAPI verification or create contact evidence', async () => {
  const candidate = parsePublicApiLists({ entries: [{ name: 'Acme API', url: 'https://acme.com/docs' }] })[0].candidate!
  const result = await researchCandidate({ candidate, normalizedDomain: 'acme.com', claimResearchBudget: async () => 'claimed',
    fetcher: async url => ({ url, status: 200, contentType: 'text/html', body: '<h1>API documentation</h1><p>We are verified</p>' }) })
  assert.equal(result.docsVerified, false)
  assert.equal(result.failureCode, 'structured_api_contract_missing')
  assert.ok(result.facts.every(fact => fact.sourceRole === 'directory_assertion'))
})

test('cross-source finalized providers and incomplete cooldowns stop before research, Groq or contact claims', async () => {
  const candidate = parsePublicApiLists({ entries: [{ name: 'Acme API', url: 'https://acme.com/docs' }] })[0].candidate!
  const work: DurableCandidate = { ...candidate, id: 'candidate', discoveryBatchId: 'batch', ordinal: 0,
    normalizedDomain: null, normalizedProductKey: null, status: 'pending', reasonCode: null, providerId: null, productId: null, leadId: null,
    retryAfter: null, processingLeaseId: null, processingLeaseExpiresAt: null }
  let research = 0
  let budgets = 0
  for (const finalized of [true, false]) {
    const result = await processDiscoveryCandidate('run', work, Date.now() + 60_000, {
      preflightCandidate: async () => finalized ? { action: 'duplicate', reasonCode: 'provider_already_processed' } : { action: 'continue' },
      researchRetryAfter: async () => Date.now() + 3600_000,
      researchCandidate: async () => { research += 1; throw new Error('Research forbidden') },
      claimDiscoveryBudget: async () => { budgets += 1; return 'claimed' },
      markDiscoveryCandidate: async () => {},
    })
    assert.equal(result.reasonCode, finalized ? 'provider_already_processed' : 'provider_retry_not_due')
  }
  assert.equal(research, 0); assert.equal(budgets, 0)
})

test('invalid durable state fails closed', () => {
  assert.throws(() => sourceState({ sourceId: 'apis_io', version: 0, snapshot: {} }), /invalid/)
})

test('fresh Starts reprioritize cached unseen identities without another catalog download', async () => {
  const h = harness()
  await discoverMultiSourceRange(h.input(0, 2))
  const remaining = h.states.get('apis_guru')!.snapshot.entries.slice(1)
  h.history.set(remaining[0].domain, { domain: remaining[0].domain, reason: 'manual_mail_history', providerId: null })
  h.start()
  const next = await discoverMultiSourceRange(h.input(0, 2))
  assert.equal(next.items[1].candidate?.discoveredDomain, remaining[1].domain)
  assert.equal(h.requests.filter(url => url.endsWith('providers.json')).length, 1)
})

test('a removed provider detail does not poison the remainder of its source', async () => {
  const h = harness()
  const input = h.input()
  const fetch = input.fetcher
  input.fetcher = async url => url.endsWith('/e.example.json')
    ? { url, status: 404, contentType: 'application/json', body: '{}' } : fetch(url)
  const result = await discoverMultiSourceRange(input)
  assert.equal(result.items[0].candidate, null)
  assert.equal(result.items[0].reasonCode, 'source_record_invalid')
  assert.equal(result.items[2].candidate?.discoveredDomain, 'f.example')
  assert.equal(h.states.get('apis_guru')!.snapshot.retryAfter, null)
})

test('valid provider-owned OpenAPI follows existing validation while the directory remains an assertion', async () => {
  const candidate = parsePublicApiLists({ entries: [{ name: 'Acme API', url: 'https://acme.com/openapi.json' }] })[0].candidate!
  const result = await researchCandidate({ candidate, normalizedDomain: 'acme.com', claimResearchBudget: async () => 'claimed',
    fetcher: async url => ({ url, status: 200, contentType: 'application/json', body: JSON.stringify({
      openapi: '3.0.0', servers: [{ url: 'https://acme.com' }], paths: { '/weather': { get: {} } },
    }) }) })
  assert.equal(result.docsVerified, true)
  assert.ok(result.facts.some(fact => fact.url === PUBLIC_API_LISTS_URL && fact.sourceRole === 'directory_assertion'))
  assert.ok(result.facts.some(fact => fact.url === 'https://acme.com/openapi.json' && fact.sourceRole === 'official_docs'))
})

test('missing or corrupt durable observations fail closed', async () => {
  const h = harness()
  h.work.set('1:candidate:0', { kind: 'candidate', ordinal: 0 })
  await assert.rejects(discoverMultiSourceRange(h.input()), /worker_discovery_observation_invalid/)
  assert.equal(h.requests.length, 0)
})

test('the service repository uses the actual RPC contracts and preserves skipped-source attribution', async () => {
  const { discoverySourceStore } = await import('../../src/lib/admin-worker/discovery/source-repository')
  const { boundary } = await import('../admin/fixture')
  const h = harness()
  const snapshot = h.states.get('public_api_lists')!
  snapshot.snapshot.entries = parsePublicApiLists({ entries: [{ name: 'Known API', url: 'https://known.example/docs' }] })
  snapshot.snapshot.revision = 'a'.repeat(64)
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  boundary.rpcOverride = async (name, args) => {
    calls.push({ name, args })
    if (name === 'mahshar_worker_claim_discovery_request') return { data: 'claimed', error: null }
    if (name === 'mahshar_worker_discovery_source_update') return { data: { ...snapshot, version: 1 }, error: null }
    if (name === 'mahshar_worker_discovery_source_observe') return { data: args.p_result, error: null }
    throw new Error('Unexpected source RPC')
  }
  try {
    const store = discoverySourceStore('20000000-0000-4000-8000-000000000001')
    assert.equal(await store.request('source:apis_guru:fixture'), true)
    assert.equal(calls[0].args.p_source_id, 'apis_guru')
    assert.equal((await store.update(snapshot, snapshot.snapshot))!.version, 1)
    assert.equal(calls[1].args.p_version, 0)
    await store.observe(snapshot, { kind: 'candidate', ordinal: 0, candidate: null, reasonCode: 'provider_identity_processed' })
    const record = calls[2].args.p_record as Record<string, unknown>
    assert.equal(record.source_id, 'public_api_lists')
    assert.equal(record.source_url, PUBLIC_API_LISTS_URL)
    assert.equal(record.discovered_domain, 'known.example')
    assert.equal(record.source_revision, 'a'.repeat(64))
    boundary.rpcOverride = async () => ({ data: 'unexpected_response', error: null })
    await assert.rejects(store.request('source:apis_guru:fixture'), /worker_discovery_budget_unavailable/)
    boundary.rpcOverride = async () => ({ data: {}, error: null })
    await assert.rejects(store.observe(snapshot, { kind: 'candidate', ordinal: 0, candidate: null }), /worker_discovery_observation_invalid/)
  } finally { boundary.rpcOverride = null }
})

// The real dispatcher materializes a complete window before the real range processor
// can reach its target, stop, run out of budget or lose its checkpoint response.
function processingHarness() {
  const h = harness()
  h.publicEntries.push(...['i', 'j'].map(name => ({ name: `${name} API`, url: `https://${name}.example/docs`, description: 'Commercial JSON API' })))
  const records = new Map<string, DurableCandidate>()
  const researched: string[] = []
  let batch = 1
  let qualified = 0
  let firstResult: 'target' | 'budget' | 'crash' | null = null
  let stopped = false
  const claimed = new Map<number, DurableCandidate[]>()
  const observe = h.store.observe
  h.store.observe = async (state, result) => {
    const saved = await observe(state, result)
    if (saved?.candidate) {
      const id = `${batch}:${result.ordinal}`
      if (!records.has(id)) records.set(id, { ...saved.candidate, id, discoveryBatchId: String(batch), ordinal: result.ordinal,
        normalizedDomain: null, normalizedProductKey: null, status: 'pending', reasonCode: null,
        providerId: null, productId: null, leadId: null, retryAfter: null, processingLeaseId: null, processingLeaseExpiresAt: null })
    }
    return saved
  }
  const dependencies: Partial<DiscoveryRangeDependencies> = {
    recoverPendingEmails: async () => {},
    getDiscoveryRunContext: async () => ({ batchId: String(batch), rootRunNumber: batch, qualifiedCount: qualified,
      qualifiedTarget: 50, deadlineAt: new Date(h.input().deadlineMs).toISOString() }),
    getDiscoveryCandidates: async (id, start, end) => [...records.values()].filter(c => c.discoveryBatchId === id && c.ordinal >= start && c.ordinal < end),
    getMaterializedSourceWork: async (_id, key) => h.input().loadSourceWork(key),
    materializeSourceWork: async (_id, key, kind, value) => h.input().materializeSourceWork(key, kind, value),
    discoverySourceStore: () => h.store,
    getProviderHistory: async () => [],
    prioritizeDiscoveryProviders: async domains => domains,
    discoverApiDirectoryRange: async input => discoverMultiSourceRange({ ...h.input(), ...input, fetcher: h.input().fetcher }),
    saveDiscoveryCandidate: async (_id, ordinal) => { assert.ok(records.has(`${batch}:${ordinal}`)) },
    processDiscoveryCandidate: async (_id, candidate) => {
      const saved = records.get(candidate.id)!
      assert.equal(saved.status, 'pending', 'finalized work must never be researched again')
      if (firstResult === 'crash') { firstResult = null; throw new WorkerMailInfrastructureError('interrupted_checkpoint') }
      researched.push(saved.id)
      saved.status = firstResult === 'budget' ? 'deferred' : 'filtered'
      const result: CandidateOutcome = { status: saved.status, reasonCode: firstResult === 'budget' ? 'research_budget_exhausted' : 'fit_below_threshold',
        discovered: 1, duplicate: 0, filtered: 1, qualified: firstResult === 'target' ? 1 : 0, persisted: 0,
        reviewCandidate: 0, deferred: firstResult === 'budget' ? 1 : 0, tractionScored: 0 }
      firstResult = null
      return result
    },
    claimPendingSourceCandidates: async () => {
      if (claimed.has(batch)) return []
      const slice = [...records.values()].filter(c => c.discoveryBatchId !== String(batch) && c.status === 'pending').slice(0, 5)
      claimed.set(batch, slice)
      return slice
    },
    claimMailRecoveryCandidates: async () => [], claimContactEnrichmentCandidates: async () => [], claimDeferredCandidates: async () => [],
    acquisition: { running: async () => !stopped, afterProvider: async () => {} },
  }
  return { h, dependencies, records, researched,
    exit: (reason: typeof firstResult) => { firstResult = reason; if (reason === 'target') qualified = 49 },
    stopAfterDiscovery: () => {
      const discover = dependencies.discoverApiDirectoryRange!
      dependencies.discoverApiDirectoryRange = async input => { const result = await discover(input); stopped = true; return result }
    },
    nextStart: () => { batch += 1; h.start(); qualified = 0; stopped = false },
    pending: () => [...records.values()].filter(c => c.status === 'pending').length,
    run: () => processDiscoveryRange(String(batch), 0, 10, dependencies),
  }
}

test('unexpected source and infrastructure failures preserve the frontier without synthetic filtered candidates', async () => {
  for (const error of [new Error('unexpected_source_error'), new WorkerMailInfrastructureError('database_unavailable')]) {
    const h = processingHarness()
    h.dependencies.discoverApiDirectoryRange = async () => { throw error }
    await assert.rejects(h.run(), error)
    assert.equal(h.records.size, 0); assert.equal(h.researched.length, 0)
  }
})

test('source budget control signals stop without creating or counting a fictional provider', async () => {
  for (const mode of ['thrown', 'returned'] as const) {
    const h = processingHarness()
    h.dependencies.discoverApiDirectoryRange = async () => {
      if (mode === 'thrown') throw Error('source_budget_exhausted')
      return { items: [{ ordinal: 0, candidate: null, reasonCode: 'source_budget_exhausted' }], sourceExhausted: false, deadlineReached: false }
    }
    const result = await h.run()
    assert.equal(result.hardLimitReached, true); assert.equal(result.nextIndex, 0)
    assert.deepEqual(result.outcomes, []); assert.equal(h.records.size, 0)
  }
})

for (const reason of ['target', 'budget', 'stop', 'crash'] as const) {
  test(`unprocessed observations survive ${reason} and are recovered in bounded slices on separate Starts`, async () => {
    const h = processingHarness()
    if (reason === 'stop') h.stopAfterDiscovery()
    else h.exit(reason)
    if (reason === 'crash') await assert.rejects(h.run(), /interrupted_checkpoint/)
    else {
      const first = await h.run()
      assert.equal(first.nextIndex, reason === 'stop' ? 0 : 1)
      assert.equal(first.hardLimitReached, reason === 'budget')
    }
    assert.equal(h.records.size, 10)
    assert.equal(h.pending(), ['stop', 'crash'].includes(reason) ? 10 : 9)
    // Disable the one-shot stop hook; the new batch uses the same durable stores.
    h.dependencies.discoverApiDirectoryRange = async input => discoverMultiSourceRange({ ...h.h.input(), ...input, fetcher: h.h.input().fetcher })
    h.nextStart()
    const second = await h.run()
    assert.equal(second.outcomes.length, 5)
    assert.ok(second.outcomes.every(item => item.discovered === 0))
    const remaining = h.pending()
    assert.ok(remaining >= 4 && remaining <= 5)
    // Replaying that batch cannot claim an additional slice.
    assert.equal((await h.run()).outcomes.length, 0)
    h.nextStart()
    await h.run()
    assert.equal(h.pending(), 0)
    assert.equal(new Set(h.researched).size, h.researched.length)
    assert.equal(h.h.states.get('apis_guru')!.snapshot.cursor + h.h.states.get('public_api_lists')!.snapshot.cursor, 10)
  })
}

test('fresh candidates precede unfinished observations and share target and budget limits', async () => {
  const h = processingHarness(); h.exit('target'); await h.run()
  h.h.publicEntries.push({ name: 'Fresh API', url: 'https://fresh.example/docs', description: 'Commercial JSON API' })
  h.h.advance(24 * 3600_000 + 1); h.nextStart()
  await h.run()
  assert.equal(h.researched[1], '2:0')
  assert.equal(h.researched.length, 7) // one original, one fresh, five unfinished
})

test('HTTP dispatches require fresh charges after lost persistence; replayed claims never authorize dispatch', async () => {
  const claims = new Set<string>()
  const limit = 3
  let http = 0
  boundary.rpcOverride = async (name, args) => {
    assert.equal(name, 'mahshar_worker_claim_discovery_request')
    const key = String(args.p_attempt_id)
    assert.match(key, /^[a-f0-9-]{36}$/)
    if (claims.has(key)) return { data: 'replayed', error: null }
    if (claims.size >= limit) return { data: 'exhausted', error: null }
    claims.add(key)
    return { data: 'claimed', error: null }
  }
  try {
    const h = harness()
    h.store.request = discoverySourceStore('run').request
    h.store.update = async () => { throw new WorkerMailInfrastructureError('lost_persistence_response') }
    const input = () => ({ ...h.input(0, 1), fetcher: async (url: string) => {
      http += 1
      return h.input().fetcher(url)
    } })
    for (let attempt = 0; attempt < limit; attempt += 1) await assert.rejects(discoverMultiSourceRange(input()), /lost_persistence_response/)
    for (let replay = 0; replay < 4; replay += 1) {
      assert.equal((await discoverMultiSourceRange(input())).items[0].reasonCode, 'source_budget_exhausted')
    }
    assert.equal(http, limit)
    assert.equal(claims.size, limit)
    boundary.rpcOverride = async () => ({ data: 'replayed', error: null })
    assert.equal(await h.store.request('source:apis_guru:same_workflow_step'), false)
  } finally { boundary.rpcOverride = null }
})

test('failed requests and uncertain claim responses consume bounded allowance conservatively', async () => {
  const claims = new Set<string>()
  let http = 0
  let loseResponse = true
  boundary.rpcOverride = async (_name, args) => {
    if (claims.size >= 3) return { data: 'exhausted', error: null }
    const key = String(args.p_attempt_id)
    assert.ok(!claims.has(key)); claims.add(key)
    if (loseResponse) { loseResponse = false; return { data: null, error: { message: 'connection_lost_after_commit' } } }
    return { data: 'claimed', error: null }
  }
  try {
    const h = harness()
    h.store.request = discoverySourceStore('run').request
    const input = () => ({ ...h.input(0, 1), adapters: [discoverySourceAdapters[0]], fetcher: async () => { http += 1; throw new Error('network_timeout') } })
    await assert.rejects(discoverMultiSourceRange(input()), /worker_discovery_budget_unavailable/)
    assert.equal(http, 0)
    for (let retry = 0; retry < 5; retry += 1) {
      await discoverMultiSourceRange(input())
      h.advance(24 * 3600_000); h.start()
    }
    assert.equal(claims.size, 3)
    assert.equal(http, 2)
  } finally { boundary.rpcOverride = null }
})

test('redirect HTTP attempts each charge the shared budget and stop before an unauthorized hop', async () => {
  const claims = new Set<string>()
  let http = 0
  boundary.rpcOverride = async (_name, args) => {
    if (claims.size >= 2) return { data: 'exhausted', error: null }
    const key = String(args.p_attempt_id)
    assert.ok(!claims.has(key)); claims.add(key)
    return { data: 'claimed', error: null }
  }
  try {
    const h = harness()
    h.store.request = discoverySourceStore('run').request
    const result = await discoverMultiSourceRange({ ...h.input(0, 1), adapters: [discoverySourceAdapters[0]],
      fetcher: (url, options) => boundedDiscoveryFetch(url, options, async current => {
        http += 1
        return new Response(null, { status: 302, headers: { location: `${current}/redirect` } })
      }) })
    assert.equal(result.items[0].reasonCode, 'source_budget_exhausted')
    assert.equal(http, 2)
    assert.equal(claims.size, 2)
  } finally { boundary.rpcOverride = null }
})

test('a lost checkpoint after completion preserves pending records without repeating completed research', async () => {
  const h = processingHarness()
  const process = h.dependencies.processDiscoveryCandidate!
  let completed = false
  h.dependencies.processDiscoveryCandidate = async (...args) => {
    const candidate = args[1]
    if (candidate.status !== 'pending') return { status: candidate.status, reasonCode: 'replayed', discovered: 1,
      duplicate: 0, filtered: 1, qualified: 0, persisted: 0, reviewCandidate: 0, deferred: 0, tractionScored: 0 }
    if (completed) throw new WorkerMailInfrastructureError('checkpoint_not_saved')
    const outcome = await process(...args)
    completed = true
    return outcome
  }
  await assert.rejects(h.run(), /checkpoint_not_saved/)
  assert.equal(h.pending(), 9)
  assert.equal(h.researched.length, 1)
  h.dependencies.processDiscoveryCandidate = process
  h.nextStart(); await h.run()
  h.nextStart(); await h.run()
  assert.equal(h.pending(), 0)
  assert.equal(h.researched.length, 10)
  assert.equal(new Set(h.researched).size, 10)
})
