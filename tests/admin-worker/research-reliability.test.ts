import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { reset, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import { processDiscoveryCandidate, processDiscoveryRange, type DiscoveryRangeDependencies } from '../../src/lib/admin-worker/discovery/processor'
import { prioritizeDiscoveryProviders, researchRetryAfter } from '../../src/lib/admin-worker/discovery/research-history'
import { provenanceRecords } from '../../src/lib/admin-worker/discovery/repository'
import { researchCandidate } from '../../src/lib/admin-worker/discovery/research'
import { discoverApiDirectoryRange } from '../../src/lib/admin-worker/discovery/registry'
import { WorkerMailInfrastructureError } from '../../src/lib/admin-worker/discovery/provider-history'
import type { CandidateOutcome, DurableCandidate, ProvenanceFact } from '../../src/lib/admin-worker/discovery/types'

const batch = '20000000-0000-4000-8000-000000000001'
const id = '10000000-0000-4000-8000-000000000001'
function candidate(overrides: Partial<DurableCandidate> = {}): DurableCandidate {
  return { id, discoveryBatchId: batch, ordinal: 0, sourceType: 'api_directory',
    sourceUrl: 'https://api.apis.guru/v2/apideck.com.json', discoveredName: 'Apideck',
    discoveredDomain: 'apideck.com', discoveredProduct: 'ATS API',
    discoveredContractUrl: 'https://api.apis.guru/v2/specs/apideck.com/ats/9.3.0/openapi.json',
    discoveredDocsUrl: 'https://developers.apideck.com/', discoveredContactUrl: 'https://developers.apideck.com/',
    normalizedDomain: null, normalizedProductKey: null, status: 'pending', reasonCode: null,
    providerId: null, productId: null, leadId: null, retryAfter: null,
    processingLeaseId: null, processingLeaseExpiresAt: null, ...overrides }
}
function result(qualified = 0): CandidateOutcome {
  return { status: qualified ? 'persisted' : 'deferred', reasonCode: qualified ? 'qualified' : 'official_docs_unreachable',
    discovered: 1, duplicate: 0, filtered: 0, qualified, persisted: qualified,
    reviewCandidate: 0, deferred: qualified ? 0 : 1, tractionScored: 0 }
}
function prior(overrides: Record<string, unknown> = {}) {
  const c = candidate()
  return { id: 'old', normalized_domain: 'apideck.com', normalized_product_key: 'ats',
    discovered_contract_url: c.discoveredContractUrl, discovered_docs_url: c.discoveredDocsUrl,
    status: 'deferred', reason_code: 'official_docs_unreachable', processing_attempt: 0,
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString(), ...overrides }
}
function range(overrides: Partial<DiscoveryRangeDependencies> = {}): Partial<DiscoveryRangeDependencies> {
  return { recoverPendingEmails: async () => {},
    getDiscoveryRunContext: async () => ({ batchId: batch, rootRunNumber: 1,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(), qualifiedCount: 0, qualifiedTarget: 50 }),
    getDiscoveryCandidates: async () => [candidate()], processDiscoveryCandidate: async () => result(),
    claimMailRecoveryCandidates: async () => [], claimContactEnrichmentCandidates: async () => [],
    claimDeferredCandidates: async () => [], ...overrides }
}
beforeEach(() => { reset(); boundary.rpcOverride = null; boundary.unavailable = false; boundary.unavailableTable = null })

test('Apideck research facts persist one normalized lead/URL key and retain verified official documentation', async () => {
  const c = candidate()
  const researched = await researchCandidate({ candidate: c, normalizedDomain: 'apideck.com',
    claimResearchBudget: async () => 'claimed', fetcher: async url => ({ url, status: 200,
      contentType: url.includes('openapi.json') ? 'application/json' : 'text/html',
      body: url.includes('openapi.json') ? JSON.stringify({ openapi: '3.0.0',
        servers: [{ url: 'https://unify.apideck.com' }], paths: { '/ats/jobs': { get: {} } } })
        : '<title>Apideck ATS API documentation</title>',
    }) })
  assert.equal(researched.docsVerified, true)
  assert.equal(researched.facts.filter(f => f.url === c.discoveredDocsUrl).length, 2)
  const rows = provenanceRecords('lead', researched.facts)
  assert.equal(new Set(rows.map(row => `${row.lead_id}:${row.url}`)).size, rows.length,
    'The actual bulk-upsert payload cannot contain duplicate conflict keys')
  const official = rows.find(row => row.url === c.discoveredDocsUrl)
  assert.equal(official?.source_role, 'official_docs'); assert.equal(official?.source_type, 'website')
  assert.ok(rows.some(row => row.url === c.discoveredContractUrl))
})

test('canonical duplicates retain the strongest evidence before applying the five-source limit', () => {
  const checkedAt = new Date().toISOString()
  const facts: ProvenanceFact[] = Array.from({ length: 5 }, () => ({ sourceType: 'api_directory',
    sourceRole: 'directory_assertion', url: 'https://developers.apideck.com/?directory=1', checkedAt }))
  const docs: ProvenanceFact = { sourceType: 'website', sourceRole: 'official_docs',
    url: 'https://DEVELOPERS.APIDECK.COM:443/', checkedAt, factualSummary: 'Verified ATS API documentation.', namingEvidence: [] }
  for (const input of [[...facts, docs], [docs, ...facts]]) {
    const rows = provenanceRecords('lead', input)
    assert.equal(rows.length, 1); assert.equal(rows[0].source_role, 'official_docs')
    assert.equal(rows[0].factual_summary, docs.factualSummary); assert.deepEqual(rows[0].naming_evidence, [])
  }
})

test('unseen identities move ahead of old investigations before the durable 300-provider plan is capped', async () => {
  const providers = [...Array.from({ length: 300 }, (_, n) => `old${String(n).padStart(3, '0')}.example`), 'unseen.example']
  state.tables.worker_candidates = providers.slice(0, 300).map((domain, n) => ({ id: String(n), normalized_domain: domain }))
  const order = await prioritizeDiscoveryProviders(providers)
  assert.equal(order[0], 'unseen.example'); assert.deepEqual(order.slice(1), providers.slice(0, 300))
  let plan: unknown; const requests: string[] = []
  await discoverApiDirectoryRange({ rootRunNumber: 1, start: 0, end: 1, prioritizeProviders: prioritizeDiscoveryProviders,
    loadSourceWork: async () => null, materializeSourceWork: async (_key, kind, value) => { if (kind === 'provider_plan') plan = value; return value },
    fetcher: async url => { requests.push(url); return { url, status: 200, contentType: 'application/json',
      body: JSON.stringify(url.endsWith('providers.json') ? { data: providers } : { apis: {
        api: { info: { title: 'Unseen API' }, swaggerUrl: 'https://unseen.example/openapi.json' },
      } }) } },
  })
  assert.equal((plan as { providers: string[] }).providers.length, 300)
  assert.equal((plan as { providers: string[] }).providers[0], 'unseen.example')
  assert.ok(requests[1].includes('unseen.example'))
})

test('resumed source plans keep their ordinals and never reorder already materialized work', async () => {
  const stored = { kind: 'provider_plan', providers: ['old.example', 'new.example'], sourceExhausted: true }
  const output = await discoverApiDirectoryRange({ rootRunNumber: 10, start: 1, end: 2,
    prioritizeProviders: async () => { throw new Error('Resume must not replan') },
    loadSourceWork: async key => key === 'providers:plan' ? stored : { kind: 'candidate', ordinal: 1, candidate: null, reasonCode: 'provider_identity_processed' },
    materializeSourceWork: async () => { throw new Error('Stored work must not be fetched again') },
  })
  assert.equal(output.items[0].ordinal, 1)
})

test('fresh research precedes legacy first-pass, contact recovery and deferred work without spending fresh ordinals', async () => {
  const events: string[] = []
  const output = await processDiscoveryRange(batch, 0, 1, range({
    recoverPendingEmails: async () => { events.push('cheap-reconcile') },
    processDiscoveryCandidate: async (_run, c) => { events.push(c.id === id ? 'fresh' : c.id); return result() },
    claimMailRecoveryCandidates: async () => { events.push('legacy-claim'); return [candidate({ id: 'legacy' })] },
    finishMailRecovery: async () => {},
    claimContactEnrichmentCandidates: async () => { events.push('contact-claim'); return [] },
    claimDeferredCandidates: async () => { events.push('deferred-claim'); return [candidate({ id: 'deferred', status: 'deferred' })] },
  }))
  assert.deepEqual(events, ['cheap-reconcile', 'fresh', 'legacy-claim', 'legacy', 'contact-claim', 'deferred-claim', 'deferred'])
  assert.equal(output.nextIndex, 1); assert.equal(output.outcomes[1].discovered, 0)
})

test('expensive retained work cannot consume more recovery starts after its one-minute slice', async () => {
  const original = Date.now; let now = original(); Date.now = () => now
  try {
    let old = 0; let contact = 0; let deferred = 0
    const output = await processDiscoveryRange(batch, 0, 1, range({
      claimMailRecoveryCandidates: async () => [candidate({ id: 'legacy1' }), candidate({ id: 'legacy2' })],
      finishMailRecovery: async () => {},
      processDiscoveryCandidate: async (_run, c) => { if (c.id !== id) { old++; now += 61_000 } return result() },
      claimContactEnrichmentCandidates: async () => { contact++; return [] },
      claimDeferredCandidates: async () => { deferred++; return [] },
    }))
    assert.equal(old, 1); assert.equal(contact, 0); assert.equal(deferred, 0); assert.equal(output.nextIndex, 1)
    assert.equal(output.deadlineReached, false, 'A recovery slice must not terminate the logical run')
  } finally { Date.now = original }
})

test('Stop after fresh processing prevents recovery claims', async () => {
  let running = true; let claims = 0
  const output = await processDiscoveryRange(batch, 0, 1, range({
    acquisition: { running: async () => running, afterProvider: async () => { running = false } },
    claimMailRecoveryCandidates: async () => { claims++; return [] },
    claimContactEnrichmentCandidates: async () => { claims++; return [] },
  }))
  assert.equal(claims, 0); assert.equal(output.nextIndex, 1)
})

test('temporary failures retain a cooldown across Starts without extending it through skipped observations', async () => {
  const previous = prior(); state.tables.worker_candidates = [previous]
  const first = await researchRetryAfter(candidate(), 'apideck.com', 'ats')
  assert.equal(first, Date.parse(previous.updated_at) + 60 * 60_000)
  state.tables.worker_candidates.push(prior({ id: 'skipped', reason_code: 'provider_retry_not_due', updated_at: new Date().toISOString() }))
  assert.equal(await researchRetryAfter(candidate(), 'apideck.com', 'ats'), first)
  let calls = 0
  for (const attempt of [1, 2]) {
    const output = await processDiscoveryCandidate(batch, candidate({ id: String(attempt) }), Date.now() + 60000, {
      preflightCandidate: async () => ({ action: 'continue' }), markDiscoveryCandidate: async () => {},
      researchCandidate: async () => { calls++; throw new Error('Research during cooldown forbidden') },
    })
    assert.equal(output.reasonCode, 'provider_retry_not_due')
  }
  assert.equal(calls, 0)
})

test('bounded backoff expires and changed contracts, products or newer source evidence can recover immediately', async () => {
  state.tables.worker_candidates = [prior({ processing_attempt: 3, updated_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString() })]
  assert.ok((await researchRetryAfter(candidate(), 'apideck.com', 'ats'))! < Date.now())
  state.tables.worker_candidates = [prior({ processing_attempt: 10 })]
  assert.equal(await researchRetryAfter(candidate({ discoveredContractUrl: 'https://apideck.com/v2/openapi.json' }), 'apideck.com', 'ats'), null)
  assert.equal(await researchRetryAfter(candidate(), 'apideck.com', 'accounting'), null)
  assert.equal(await researchRetryAfter(candidate({ directoryUpdatedAt: new Date().toISOString() }), 'apideck.com', 'ats'), null)
  const after = await researchRetryAfter(candidate(), 'apideck.com', 'ats')
  assert.ok(after! <= Date.now() + 4 * 60 * 60_000, 'Incomplete providers are never permanently suppressed')
})

test('unchanged terminal contract failures retain their existing horizon and history errors fail closed', async () => {
  const previous = prior({ status: 'filtered', reason_code: 'unsupported_auth_pattern' }); state.tables.worker_candidates = [previous]
  assert.equal(await researchRetryAfter(candidate(), 'apideck.com', 'ats'), Date.parse(previous.updated_at) + 30 * 24 * 60 * 60_000)
  boundary.unavailableTable = 'worker_candidates'
  await assert.rejects(researchRetryAfter(candidate(), 'apideck.com', 'ats'), WorkerMailInfrastructureError)
})

test('old directory-keyword rejection is not a research attempt and cannot impose a thirty-day cooldown', async () => {
  const previous = prior({ status: 'filtered', reason_code: 'callable_api_unverified', processing_attempt: 0 })
  const retained = JSON.stringify(previous)
  state.tables.worker_candidates = [previous]
  assert.equal(await researchRetryAfter(candidate(), 'apideck.com', 'ats'), null)
  let researched = 0
  const result = await processDiscoveryCandidate(batch, candidate(), Date.now() + 60000, {
    preflightCandidate: async () => ({ action: 'continue' }), markDiscoveryCandidate: async () => {},
    researchCandidate: async () => {
      researched++
      return { facts: [], docsVerified: false, failureCode: 'structured_api_contract_missing', compatibilityFailure: null }
    },
  })
  assert.equal(researched, 1); assert.equal(result.qualified, 0)
  assert.equal(result.reasonCode, 'structured_api_contract_missing')
  assert.equal(JSON.stringify(previous), retained, 'Retained historical records are not rewritten')
  const temporary = prior({ id: 'actual-research', reason_code: 'official_docs_unreachable' })
  state.tables.worker_candidates.push(temporary)
  assert.equal(await researchRetryAfter(candidate(), 'apideck.com', 'ats'), Date.parse(temporary.updated_at) + 60 * 60_000)
})
