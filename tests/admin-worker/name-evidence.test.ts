import assert from 'node:assert/strict'
import { test } from 'node:test'
import { researchCandidate } from '../../src/lib/admin-worker/discovery/research'
import { getReusableProvenance, provenanceRecords } from '../../src/lib/admin-worker/discovery/repository'
import { state, reset } from '../marketplace/fixtures'
import { qualifyCandidate } from '../../src/lib/admin-worker/discovery/qualification'
import { officialNamingMetadata, resolveOfficialNames } from '../../src/lib/admin-worker/invitation-names'

test('existing research fetches capture official body naming metadata without changing discovery outcomes or budgets', async () => {
  reset()
  const claims: string[] = [], requests: string[] = []
  const contract = 'https://directory.example/openapi.json', root = 'https://acme.example/'
  const now = new Date().toISOString()
  const result = await researchCandidate({ normalizedDomain: 'acme.example', now: () => now,
    candidate: { sourceType: 'api_directory', sourceUrl: contract, discoveredName: 'acme.example', discoveredProduct: 'OpenAPI Documentation', discoveredContractUrl: contract },
    claimResearchBudget: async purpose => { claims.push(purpose); return 'claimed' },
    fetcher: async url => {
      requests.push(url)
      return { url, status: 200, contentType: url === contract ? 'application/json' : 'text/html', body: url === contract
        ? JSON.stringify({ openapi: '3.0.0', info: { title: 'OpenAPI Documentation' }, servers: [{ url: 'https://acme.example/' }], paths: { '/api': { get: {} } } })
        : '<html><title>Swagger UI</title><h1>OpenAPI Documentation</h1><p>Acme.example provides APIs.</p><p>Our company is called Acme.</p><p>Our API is called Acme Developer API.</p></html>' }
    },
  })
  assert.deepEqual(claims, ['contract', 'ownership_root'])
  assert.deepEqual(requests, [contract, root])
  assert.equal(result.docsVerified, true); assert.equal(result.failureCode, null)
  assert.ok(result.facts.filter(f => f.sourceType === 'api_directory').every(f => !f.namingEvidence))
  const official = result.facts.find(f => f.sourceRole === 'official_site')!
  assert.equal(official.namingEvidence?.length, 2)
  assert.equal(official.factualSummary, 'Provider-owned site independently verified for this directory contract.')
  const records = provenanceRecords('lead', result.facts)
  assert.deepEqual(records.find(r => r.source_role === 'official_site')!.naming_evidence, official.namingEvidence)
  state.tables.worker_sources = records
  const cached = await getReusableProvenance('lead')
  const proof = cached.find(f => f.sourceRole === 'official_site')!
  assert.deepEqual(proof.namingEvidence, official.namingEvidence)
  assert.deepEqual(resolveOfficialNames('acme.example', proof.namingEvidence!.map(p => ({ ...p, sourceId: 'source', sourceType: proof.sourceType, sourceRole: proof.sourceRole, url: proof.url, checkedAt: proof.checkedAt }))), { company: 'Acme', product: 'Acme Developer API' })
})

test('naming metadata does not alter qualification prompts and fresh absent proof explicitly clears old metadata', async () => {
  const candidate = { sourceType: 'api_directory' as const, sourceUrl: 'https://directory.example/', discoveredName: 'Acme', discoveredProduct: 'API' }
  const fact = { sourceType: 'website' as const, sourceRole: 'official_site' as const, url: 'https://acme.example/', factualSummary: 'Official identity', checkedAt: new Date().toISOString() }
  const naming = officialNamingMetadata(fact.url, '<p>Our API is called Acme Developer API.</p>', 'acme.example')
  const prompts: string[] = []
  const caller = async (system: string, prompt: string) => { prompts.push(system + prompt); return {fitScore:80,commercialApi:true,agentUtility:'high',payPerCallFit:'high',integrationDifficulty:'low',providerCredibility:'high',reasonCodes:[],summary:'Offline fixture'} }
  await qualifyCandidate(candidate, [fact], caller)
  await qualifyCandidate(candidate, [{ ...fact, ...naming }], caller)
  assert.equal(prompts[0], prompts[1])
  const fresh = officialNamingMetadata(fact.url, '<title>Acme API Documentation</title>', 'acme.example')
  assert.deepEqual(fresh, { namingEvidence: [] })
  assert.deepEqual(provenanceRecords('lead', [{ ...fact, ...fresh }])[0].naming_evidence, [])
})
