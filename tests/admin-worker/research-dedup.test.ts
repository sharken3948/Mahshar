import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processDiscoveryCandidate, type DiscoveryProcessorDependencies } from '../../src/lib/admin-worker/discovery/processor'
import { researchCandidate } from '../../src/lib/admin-worker/discovery/research'
import type { DurableCandidate, ProvenanceFact } from '../../src/lib/admin-worker/discovery/types'

const contract = 'https://api.apis.guru/v2/specs/poemist.com/1.0/swagger.json'
function candidate(overrides: Partial<DurableCandidate> = {}): DurableCandidate {
  return {
    id: '10000000-0000-4000-8000-000000000001', discoveryBatchId: '20000000-0000-4000-8000-000000000001',
    ordinal: 0, sourceType: 'api_directory', sourceUrl: 'https://api.apis.guru/v2/poemist.com.json',
    discoveredName: 'Poemist', discoveredDomain: 'poemist.com', discoveredProduct: 'Poemist API',
    discoveredContractUrl: contract, normalizedDomain: 'poemist.com', normalizedProductKey: 'poemist',
    status: 'deferred', reasonCode: 'provider_ownership_unverified', providerId: 'provider', productId: 'product',
    leadId: 'lead', retryAfter: null, processingLeaseId: null, processingLeaseExpiresAt: null, ...overrides,
  }
}

function fresh(overrides: Partial<DurableCandidate> = {}) {
  return candidate({ id: '10000000-0000-4000-8000-000000000002',
    discoveryBatchId: '20000000-0000-4000-8000-000000000002', status: 'pending', reasonCode: null,
    normalizedDomain: null, normalizedProductKey: null, providerId: null, productId: null, leadId: null, ...overrides })
}

function fixture(ledger = new Map<string, Set<string>>()) {
  const requests: string[] = []
  const accepted: Array<{ batch: string; budget: string; key: string }> = []
  let ownershipAvailable = false
  let groqCalls = 0
  let reusable: ProvenanceFact[] = []
  const dependencies: Partial<DiscoveryProcessorDependencies> = {
    preflightCandidate: async () => ({ action: 'continue' }),
    getReusableProvenance: async () => reusable,
    researchCandidate: input => researchCandidate({ ...input, fetcher: async url => {
      requests.push(url)
      return url.includes('/swagger.json') ? { url, status: 200, contentType: 'application/json',
        body: JSON.stringify({ swagger: '2.0', host: 'api.poemist.com', schemes: ['https'], paths: { '/poems': { get: {} } } }) }
        : { url, status: 200, contentType: 'text/html', body: ownershipAvailable ? '<title>Poemist API</title>' : '<title>Unavailable</title>' }
    } }),
    claimDiscoveryBudget: async (runId, budget, key) => {
      const batch = runId === 'next-batch' ? 'batch-two' : 'batch-one'
      const claims = ledger.get(batch) ?? new Set<string>()
      ledger.set(batch, claims)
      const identity = `${budget}:${key}`
      if (claims.has(identity)) return 'replayed'
      assert.match(key, /^[a-z0-9:_-]{1,120}$/, 'The existing durable claim contract must remain valid')
      claims.add(identity); accepted.push({ batch, budget, key })
      return 'claimed'
    },
    resolveDiscoveryLead: async () => ({ action: 'continue', providerId: 'provider', productId: 'product', leadId: 'lead' }),
    saveProvenance: async () => {},
    saveQualification: async input => ({ status: input.deferredReason ? 'deferred' : 'persisted',
      reasonCode: input.deferredReason ?? 'qualified', countedQualified: !input.deferredReason, targetReached: false }),
    markDiscoveryCandidate: async () => {},
    qualifyCandidate: async () => {
      groqCalls++
      return { fitScore: 88, commercialApi: true, agentUtility: 'high', payPerCallFit: 'high',
        integrationDifficulty: 'medium', providerCredibility: 'high', reasonCodes: ['useful_tool'], summary: 'Useful API.' }
    },
    getSavedContactResearch: async () => ({ status: 'verified_email', emailReady: true,
      preferredEmail: 'contact@poemist.com', preferredContactUrl: 'https://poemist.com/contact',
      evidence: [], completed: true, failureCode: null }),
    discoverProviderContacts: async () => { throw new Error('Saved contact verification must be reused') },
  }
  return { ledger, requests, accepted,
    researchClaims: () => accepted.filter(claim => claim.budget === 'research'),
    groqCalls: () => groqCalls,
    enableOwnership: () => { ownershipAvailable = true },
    reuse: (facts: ProvenanceFact[]) => { reusable = facts },
    process: (work: DurableCandidate, runId = 'original') =>
      processDiscoveryCandidate(runId, work, Date.now() + 60_000, dependencies, work.status === 'deferred'),
  }
}

test('Poemist deferred and fresh candidates share contract and ownership research in one logical batch', async () => {
  const f = fixture()
  assert.equal((await f.process(candidate())).reasonCode, 'provider_ownership_unverified')
  assert.equal((await f.process(fresh())).reasonCode, 'research_claim_replayed')
  assert.deepEqual(f.requests, [contract, 'https://poemist.com/'])
  assert.equal(f.researchClaims().length, 2)
  assert.equal(f.groqCalls(), 0)
})

test('normalized provider/product aliases and canonical contract URLs share the same research claims', async () => {
  const f = fixture()
  await f.process(candidate())
  const result = await f.process(fresh({ discoveredDomain: 'API.POEMIST.COM', discoveredProduct: 'Poemist REST API',
    discoveredContractUrl: 'https://API.APIS.GURU:443/v2/specs/poemist.com/1.0/swagger.json?ignored=value' }))
  assert.equal(result.reasonCode, 'research_claim_replayed')
  assert.equal(f.researchClaims().length, 2)
  assert.equal(f.requests.length, 2)
})

test('concurrent equivalent candidates cannot both consume the research budget', async () => {
  const f = fixture()
  const results = await Promise.all([f.process(candidate()), f.process(fresh())])
  assert.ok(results.some(result => result.reasonCode === 'research_claim_replayed'))
  assert.equal(f.researchClaims().length, 2)
  assert.deepEqual(f.requests, [contract, 'https://poemist.com/'])
})

test('Resume after a process restart replays durable claims while a later batch can recover and qualify', async () => {
  const f = fixture()
  await f.process(candidate())
  const resumed = fixture(f.ledger)
  assert.equal((await resumed.process(fresh(), 'resumed-run')).reasonCode, 'research_claim_replayed')
  assert.equal(resumed.accepted.length, 0)
  assert.equal(resumed.requests.length, 0)
  resumed.enableOwnership()
  assert.equal((await resumed.process(candidate(), 'next-batch')).status, 'persisted')
  assert.equal(resumed.researchClaims().length, 2)
  assert.equal(resumed.groqCalls(), 1)
  assert.deepEqual(resumed.requests, [contract, 'https://poemist.com/'])
})

test('different contracts, products and documentation inputs remain independently recoverable', async () => {
  for (const change of [
    { discoveredContractUrl: 'https://api.apis.guru/v2/specs/poemist.com/2.0/swagger.json' },
    { discoveredProduct: 'Poemist Analytics API' },
    { discoveredDocsUrl: 'https://poemist.com/docs' },
  ]) {
    const f = fixture()
    await f.process(candidate())
    const result = await f.process(fresh(change))
    assert.equal(result.reasonCode, 'provider_ownership_unverified')
    assert.ok(f.researchClaims().length > 2)
    assert.equal(f.groqCalls(), 0)
  }
})

test('existing official provenance and verified contacts bypass research as before', async () => {
  const f = fixture()
  f.reuse([{ sourceType: 'website', sourceRole: 'official_docs', url: 'https://poemist.com/openapi.json',
    factualSummary: 'Verified official API contract.', checkedAt: new Date().toISOString() }])
  assert.equal((await f.process(candidate())).status, 'persisted')
  assert.equal(f.researchClaims().length, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.groqCalls(), 1)
})
