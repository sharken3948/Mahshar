import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { parseX402List, parsePayApi, parseBolthub } from '../../src/lib/admin-worker/discovery/sources/additional-catalogs'
import { discoverySourceAdapters, type DiscoverySourceId, type DiscoverySourceState } from '../../src/lib/admin-worker/discovery/sources/adapter'
import { sourceCatalogUrl } from '../../src/lib/admin-worker/discovery/sources/catalog'
import { directoryObservation } from '../../src/lib/admin-worker/discovery/sources/open-catalogs'
import { discoverMultiSourceRange } from '../../src/lib/admin-worker/discovery/multi-source'
import { WorkerMailInfrastructureError } from '../../src/lib/admin-worker/discovery/provider-history'
import { sourceState, type DiscoverySourceStore, type SourceObservation } from '../../src/lib/admin-worker/discovery/source-repository'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/additional-catalogs.json', import.meta.url), 'utf8'))
const added = ['x402_list', 'payapi_market', 'bolthub'] as const
const parsers = [parseX402List, parsePayApi, parseBolthub]
const provenance = { license: 'CC-BY-4.0', attribution_required: true, source: 'https://x402-list.com' }
function payload(id: DiscoverySourceId, position = id === 'payapi_market' ? 0 : 1) {
  const rows = Array.from({ length: 50 }, (_, index) => {
    const n = (id === 'payapi_market' ? position : (position - 1) * 50) + index
    return { slug: `product-${n}`, id: `product-${n}`, name: `Product ${n}`, website_url: 'https://docs.acme.com/',
      base_url: 'https://api.acme.com/paid/execute', status: 'live', description: 'Commercial service',
      endpoints: [{ docsUrl: 'https://docs.acme.com/' }] }
  })
  if (id === 'x402_list') return { data: rows, meta: { total: 100, page: position, per_page: 50, total_pages: 2 }, provenance }
  if (id === 'payapi_market') return { results: rows, count: 50, total: 100, offset: position, limit: 50,
    next_offset: position === 0 ? 50 : null, has_more: position === 0 }
  return { entries: rows, total: 100, hasMore: position === 1 }
}

test('captured official catalog pages validate with exact pagination and conservative provider hints', () => {
  for (const [parser, prefix] of [[parseX402List, 'x402'], [parsePayApi, 'pay'], [parseBolthub, 'bolt']] as const) {
    for (const page of [1, 2]) {
      const result = parser(fixture[prefix + page], prefix === 'pay' ? (page - 1) * 50 : page)
      for (const item of result.entries) {
        const candidate = directoryObservation(prefix === 'x402' ? 'x402_list' : prefix === 'pay' ? 'payapi_market' : 'bolthub', item)!
        assert.equal(candidate.discoveredContractUrl, undefined)
        assert.equal('discoveredEmail' in candidate, false)
        assert.equal(candidate.sourceType, 'api_directory')
      }
      if (prefix === 'bolt') { assert.equal(result.entries.length, 0); assert.equal(result.nextPage, null) }
    }
  }
  assert.ok(parseX402List(fixture.x4021).entries.every(item => item.summary!.includes('CC BY 4.0')))
  assert.ok(parsePayApi(fixture.pay1, 0).entries.every(item => new URL(item.url!).pathname === '/'))
})

test('all new parsers reject corrupt pagination and empty pages that claim more raw records', () => {
  for (const [index, id] of added.entries()) {
    const parser = parsers[index], position = id === 'payapi_market' ? 0 : 1
    const good = payload(id)
    assert.equal(parser(good, position).entries.length, 50)
    const empty = structuredClone(good) as Record<string, unknown>
    empty[id === 'x402_list' ? 'data' : id === 'payapi_market' ? 'results' : 'entries'] = []
    assert.throws(() => parser(empty, position), /catalog_invalid/)
    assert.throws(() => parser({ ...good, total: -1, meta: { total: -1 } }, position), /catalog_invalid/)
  }
  assert.throws(() => parseX402List({ ...fixture.x4021, provenance: { ...provenance, license: 'unknown' } }), /invalid/)
  assert.throws(() => parsePayApi({ ...fixture.pay1, next_offset: 0 }), /invalid/)
  assert.throws(() => parsePayApi({ ...fixture.pay1, has_more: false, next_offset: null }), /invalid/)
  assert.throws(() => parsePayApi({ ...fixture.pay1, total: 1, has_more: false, next_offset: null }), /invalid/)
})

test('genuinely empty catalogs terminate and completed pages never loop', () => {
  assert.deepEqual(parseX402List({ data: [], meta: { total: 0, page: 1, per_page: 50, total_pages: 0 }, provenance }), { entries: [], nextPage: null })
  assert.deepEqual(parsePayApi({ results: [], count: 0, total: 0, offset: 0, limit: 50, has_more: false, next_offset: null }), { entries: [], nextPage: null })
  assert.deepEqual(parseBolthub({ entries: [], total: 0, hasMore: false }), { entries: [], nextPage: null })
  for (const [i, id] of added.entries()) assert.equal(parsers[i](payload(id, id === 'payapi_market' ? 50 : 2), id === 'payapi_market' ? 50 : 2).nextPage, null)
})

test('unsafe/shared provider identities and directory badges cannot manufacture ownership or qualification', () => {
  for (const link of ['http://acme.com/', 'https://127.0.0.1/', 'https://acme.gw.bolthub.ai/', 'https://aws.amazon.com/marketplace/seller',
    'https://payapi.market/api/acme', 'https://tenant.vercel.app/', 'https://github.com/acme', 'https://a:b@acme.com/']) {
    const x = payload('x402_list'); x.data![0].website_url = link
    const p = payload('payapi_market'); p.results![0].base_url = link
    const b = payload('bolthub'); b.entries![0].endpoints[0].docsUrl = link
    assert.equal(parseX402List(x).entries.length, 49)
    assert.equal(parsePayApi(p).entries.length, 49)
    assert.equal(parseBolthub(b).entries.length, 49)
  }
  const x = payload('x402_list'); x.data![0].website_url = ''
  assert.equal(parseX402List(x).entries.length, 49, 'paid base_url cannot replace missing website')
})

function harness(ids: readonly DiscoverySourceId[] = added) {
  let batch = 1, running = true, now = Date.now(), known = false, crash = false, permit = true
  let failed: DiscoverySourceId | null = null, status = 503, retryAfter = '600'
  const adapters = discoverySourceAdapters.filter(adapter => ids.includes(adapter.id))
  const states = new Map<DiscoverySourceId, DiscoverySourceState>(adapters.map(a => [a.id, { sourceId: a.id, version: 0,
    snapshot: { entries: [], cursor: 0, revision: null, fetchedAt: null, refreshAfter: null, retryAfter: null, failures: 0 } }]))
  const work = new Map<string, unknown>(), urls: string[] = [], claims: string[] = []
  const store: DiscoverySourceStore = {
    read: async id => sourceState(structuredClone(states.get(id))), running: async () => running,
    request: async key => { claims.push(key); return permit },
    update: async (state, snapshot) => {
      if (!running) return null
      assert.equal(states.get(state.sourceId)!.version, state.version)
      const saved = { ...state, version: state.version + 1, snapshot }; states.set(state.sourceId, structuredClone(saved)); return saved
    },
    observe: async (state, result) => {
      if (!running) return null
      assert.equal(states.get(state.sourceId)!.version, state.version)
      states.set(state.sourceId, { ...state, version: state.version + 1, snapshot: { ...state.snapshot, cursor: state.snapshot.cursor + 1 } })
      work.set(`${batch}:candidate:${result.ordinal}`, structuredClone(result))
      if (crash) { crash = false; throw new WorkerMailInfrastructureError('interrupted_observation_response') }
      return result
    },
  }
  const input = (start = 0, end = 6) => ({ rootRunNumber: batch, start, end, adapters, sourceStore: store, now: () => now, deadlineMs: now + 60_000,
    loadSourceWork: async (key: string) => work.get(`${batch}:${key}`) ?? null,
    materializeSourceWork: async (key: string, _kind: unknown, value: unknown) => { work.set(`${batch}:${key}`, value); return value },
    providerHistory: async (domains: string[]) => known ? domains.map(domain => ({ domain, providerId: null, reason: 'manual_mail_pending' })) : [],
    fetcher: async (url: string) => {
      urls.push(url)
      const source = adapters.find(a => url.startsWith(sourceCatalogUrl(a.id)))
      if (source?.id === failed) return { url, status, contentType: 'application/json', retryAfter, body: '{}' }
      const params = new URL(url).searchParams
      let data: unknown
      if (source && added.includes(source.id as typeof added[number])) data = payload(source.id, Number(params.get('offset') ?? params.get('page')))
      else if (url.endsWith('providers.json')) data = { data: ['acme.com'] }
      else if (url.includes('api.apis.guru')) data = { apis: { weather: { info: { title: 'Acme API' }, swaggerUrl: 'https://acme.com/openapi.json', openapi: '3.0.0' } } }
      else if (source?.id === 'public_api_lists') data = { entries: [{ name: 'Acme API', url: 'https://acme.com/docs' }] }
      else if (source?.id === 'apify_store') data = { data: { items: [{ id: 'actor', username: 'acme', title: 'Acme' }], total: 1, offset: 0, count: 1 } }
      else if (url.includes('api.apify.com/v2/users/')) data = { data: { username: 'Acme', profile: { websiteUrl: 'https://acme.com/' } } }
      else return { url, status: 200, contentType: 'text/plain', body: '| [Acme](https://acme.com/docs) | Service |' }
      return { url, status: 200, contentType: 'application/json', body: JSON.stringify(data) }
    },
  })
  return { input, states, work, urls, claims, store, stop: () => { running = false }, resume: () => { running = true }, next: () => { batch++ },
    known: () => { known = true }, crash: () => { crash = true }, deny: () => { permit = false }, advance: (ms: number) => { now += ms },
    fail: (id: DiscoverySourceId, code = 503, retry = '600') => { failed = id; status = code; retryAfter = retry } }
}

test('all eight real adapters receive a fair discovery opportunity through one shared dispatcher', async () => {
  const h = harness(discoverySourceAdapters.map(a => a.id))
  const result = await discoverMultiSourceRange(h.input(0, 8))
  assert.deepEqual(result.items.map(item => item.candidate?.sourceId), discoverySourceAdapters.map(a => a.id))
  for (const state of h.states.values()) assert.equal(state.snapshot.cursor, 1)
  assert.equal(h.urls.length, h.claims.length)
})

for (const id of added) {
  test(`${id}: saved pages, separate Starts, Stop and interrupted Resume preserve every accepted observation`, async () => {
    const h = harness([id]); h.crash()
    await assert.rejects(discoverMultiSourceRange(h.input()), /interrupted_observation_response/)
    const requests = h.urls.length
    h.stop(); assert.equal((await discoverMultiSourceRange(h.input())).items.length, 0)
    h.resume(); const resumed = await discoverMultiSourceRange(h.input())
    assert.equal(resumed.items.length, 6); assert.equal(h.urls.length, requests)
    h.next(); await discoverMultiSourceRange(h.input(0, 45))
    assert.equal(h.states.get(id)!.snapshot.nextPage, null)
    assert.equal(h.urls.length, 2)
    assert.equal(h.states.get(id)!.snapshot.cursor, 1)
    const ids = [...h.work.entries()].filter(([key]) => key.includes('candidate:')).map(([, value]) => (value as SourceObservation).candidate!.sourceRecordId)
    assert.equal(new Set(ids).size, 51)
  })
  test(`${id}: finalized domains skip candidates without provider detail, inference or contact requests`, async () => {
    const h = harness([id]); h.known()
    const result = await discoverMultiSourceRange(h.input())
    assert.ok(result.items.every(item => item.candidate === null && item.reasonCode === 'provider_identity_processed'))
    assert.equal(h.urls.length, 1); assert.equal(h.claims.length, 1)
  })
  test(`${id}: uncertain fetch persistence requires a newly charged attempt; a saved response is reused`, async () => {
    const h = harness([id]), update = h.store.update
    let lose = true
    h.store.update = async (state, snapshot) => {
      if (lose) { lose = false; throw new WorkerMailInfrastructureError('catalog_persistence_uncertain') }
      return update(state, snapshot)
    }
    await assert.rejects(discoverMultiSourceRange(h.input()), /catalog_persistence_uncertain/)
    assert.equal(h.urls.length, 1); assert.equal(h.claims.length, 1)
    await discoverMultiSourceRange(h.input())
    assert.equal(h.urls.length, 2); assert.equal(h.claims.length, 2)
    await discoverMultiSourceRange(h.input())
    assert.equal(h.urls.length, 2); assert.equal(h.claims.length, 2)
  })
  test(`${id}: failures back off independently and valid cached responses are not fetched on replay`, async () => {
    const h = harness(); h.fail(id, 429)
    const result = await discoverMultiSourceRange(h.input())
    assert.equal(h.states.get(id)!.snapshot.cursor, 0)
    assert.ok(h.states.get(id)!.snapshot.retryAfter)
    assert.ok(result.items.length > 0)
    const attempts = h.urls.length
    await discoverMultiSourceRange(h.input()); assert.equal(h.urls.length, attempts)
  })
}

test('a denied page attempt preserves the frontier and every previously accepted observation', async () => {
  const h = harness(['x402_list'])
  await discoverMultiSourceRange(h.input(0, 50)); h.deny()
  const result = await discoverMultiSourceRange(h.input(50, 51))
  assert.equal(result.items[0].reasonCode, 'source_budget_exhausted')
  assert.equal(h.states.get('x402_list')!.snapshot.cursor, 50)
  assert.equal(h.states.get('x402_list')!.snapshot.nextPage, '2')
  assert.equal(h.urls.length, 1)
  assert.equal([...h.work.keys()].filter(key => key.includes('candidate:')).length, 50)
})

test('new catalogs never request execution paths; a denied attempt cannot dispatch HTTP', async () => {
  const h = harness(); h.deny()
  await discoverMultiSourceRange(h.input())
  assert.equal(h.urls.length, 0); assert.equal(h.claims.length, 1)
  for (const adapter of discoverySourceAdapters.filter(a => added.includes(a.id as typeof added[number]))) {
    for (const page of ['https://evil.example/', '-1', '99999999999']) await assert.rejects(adapter.catalog(async () => { throw Error('must not fetch') }, page), /source_page_invalid/)
  }
})

test('payment-required catalog responses never trigger payment or a repeated request before a full-day cooldown', async () => {
  for (const retry of ['600', '172800']) {
    const h = harness(['x402_list']); h.fail('x402_list', 402, retry)
    const minimum = h.input().now() + Math.max(86400, Number(retry)) * 1000
    await discoverMultiSourceRange(h.input()); assert.equal(h.urls.length, 1)
    assert.ok(Date.parse(h.states.get('x402_list')!.snapshot.retryAfter!) >= minimum)
    h.advance(3600_000); h.next(); await discoverMultiSourceRange(h.input()); assert.equal(h.urls.length, 1)
  }
})

test('missing source schema is an infrastructure error and cannot finalize a provider or advance progress', async () => {
  const h = harness(); h.store.read = async () => { throw new WorkerMailInfrastructureError('worker_discovery_sources_unavailable') }
  await assert.rejects(discoverMultiSourceRange(h.input()), /sources_unavailable/)
  assert.equal(h.urls.length, 0); assert.equal(h.claims.length, 0)
  assert.ok([...h.states.values()].every(state => state.snapshot.cursor === 0))
})
