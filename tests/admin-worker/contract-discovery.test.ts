import assert from 'node:assert/strict'
import { test } from 'node:test'
import examples from './fixtures/contract-missing-run-30.json'
import { researchCandidate } from '../../src/lib/admin-worker/discovery/research'
import { boundedDiscoveryFetch, DiscoveryResponseTooLargeError } from '../../src/lib/admin-worker/discovery/fetch'
import { officialContractLinks } from '../../src/lib/admin-worker/discovery/contract-links'
import { WorkerMailInfrastructureError } from '../../src/lib/admin-worker/discovery/provider-history'
import type { DiscoverySourceId } from '../../src/lib/admin-worker/discovery/sources/adapter'
import type { RawCandidate } from '../../src/lib/admin-worker/discovery/types'
import type { DiscoveryFetcher } from '../../src/lib/admin-worker/discovery/fetch'

const docs = 'https://acme.example/docs'
const specification = (endpoint = 'https://acme.example/api', version = '3.0.0') => JSON.stringify({
  openapi: version, servers: [{ url: endpoint }], paths: { '/weather': { get: {} } },
})
const candidate: RawCandidate = { sourceType: 'api_directory', sourceUrl: 'https://directory.example/',
  discoveredName: 'Acme', discoveredDomain: 'acme.example', discoveredProduct: 'Acme API', discoveredDocsUrl: docs }
const response = (url: string, body: string, contentType = 'text/html', status = 200) => ({ url, body, contentType, status })
function run(fetcher: DiscoveryFetcher, overrides: Partial<RawCandidate> = {}) {
  const requests: string[] = [], claims: string[] = []
  return { requests, claims, result: researchCandidate({ candidate: { ...candidate, ...overrides }, normalizedDomain: 'acme.example',
    claimResearchBudget: async key => { claims.push(key); return 'claimed' },
    fetcher: async (url, options) => { requests.push(url); return fetcher(url, options) } }) }
}

// These are the 24 public directory URL/product assertions from the diagnosed run.
// Responses below are synthetic: they test discovery without asserting that these providers have contracts.
for (const example of examples) test(`run #30 HTML documentation can expose a contract: ${example.discoveredProduct}`, async () => {
  let requests = 0
  const spec = new URL('/verified-openapi.json', example.discoveredDocsUrl).toString()
  const result = await researchCandidate({ candidate: { ...example, discoveredName: example.discoveredDomain, sourceId: example.sourceId as DiscoverySourceId, sourceType: 'api_directory',
    sourceUrl: 'https://directory.example/' }, normalizedDomain: example.discoveredDomain,
    claimResearchBudget: async () => 'claimed', fetcher: async url => {
      requests++
      return url === spec ? response(url, specification(`https://${example.discoveredDomain}/api`), 'application/json')
        : response(url, '<title>API documentation</title><a href="/verified-openapi.json">OpenAPI specification</a>')
    } })
  assert.equal(result.docsVerified, true); assert.equal(requests, 2)
  assert.ok(result.facts.some(f => f.url === spec && f.sourceRole === 'official_docs'))
})

test('literal Swagger UI, Redoc and links are recognized without executing scripts or guessing URLs', () => {
  assert.deepEqual(officialContractLinks(`<redoc spec-url="/v1/schema.json"></redoc>
    <script>SwaggerUIBundle({url: '/v2/schema.json', dom_id: '#swagger'})</script>
    <a href="/docs/api">API documentation</a><a href="/account">Account</a>`, docs).map(x => x.url),
  ['https://acme.example/v1/schema.json', 'https://acme.example/v2/schema.json', 'https://acme.example/docs/api'])
})

test('nested link labels are read while Swagger UI assets are excluded from contract requests', () => {
  assert.deepEqual(officialContractLinks(`<link rel="stylesheet" href="/swagger-ui.css">
    <a href="/schema.json"><span>Download OpenAPI</span></a>
    <a href="/reference"><span>Docs</span></a>`, docs), [
    { url: 'https://acme.example/schema.json', kind: 'contract' },
    { url: 'https://acme.example/reference', kind: 'docs' },
  ])
})

test('one explicit official documentation hop can lead to a verified contract', async () => {
  const f = run(async url => url.endsWith('schema.json') ? response(url, specification(), 'application/json')
    : response(url, url === docs ? '<a href="/reference">API reference</a>' : '<redoc spec-url="/schema.json"></redoc>'))
  assert.equal((await f.result).docsVerified, true); assert.equal(f.requests.length, 3)
  assert.equal(new Set(f.claims).size, f.requests.length)
})

test('a discovered spec is prioritized ahead of other pending documentation pages', async () => {
  const f = run(async url => url.endsWith('schema.json') ? response(url, specification(), 'application/json')
    : response(url, url === docs ? Array.from({ length: 8 }, (_, i) => `<a href="/reference${i}">API documentation</a>`).join('')
      : '<redoc spec-url="/schema.json"></redoc>'))
  assert.equal((await f.result).docsVerified, true); assert.equal(f.requests.length, 3)
})

test('an explicit official link verifies a separate specification host only with a provider-owned endpoint', async () => {
  for (const endpoint of ['https://acme.example/api', 'https://unrelated.example/api']) {
    const f = run(async url => url === docs ? response(url, '<title>Acme API documentation</title><a href="https://specs.cdn.example/schema.json">OpenAPI</a>')
      : response(url, specification(endpoint), 'application/json'))
    const result = await f.result
    assert.equal(result.docsVerified, endpoint.includes('acme.example'))
    if (result.docsVerified) assert.ok(result.facts.some(f => f.url === docs && f.sourceRole === 'official_docs'))
  }
})

test('unverified directory documentation cannot authorize a third-party specification host', async () => {
  const f = run(async url => response(url, '<a href="https://specs.example/openapi.json">OpenAPI</a>'),
    { discoveredDocsUrl: 'https://unrelated.example/docs' })
  assert.equal((await f.result).failureCode, 'official_linkage_unverified'); assert.equal(f.requests.length, 0)
})

test('unsafe, authenticated and non-explicit references are never requested', async () => {
  const f = run(async url => response(url, `<base href="https://evil.example/">
    <a href="http://acme.example/openapi.json">OpenAPI</a><a href="https://127.0.0.1/schema.json">OpenAPI</a>
    <a href="https://user:pass@evil.example/schema.json">OpenAPI</a><a href="/schema.json?token=private">OpenAPI</a>
    <a href="https://evil.example/docs">API docs</a><script>fetch('/guess.json')</script>`))
  assert.equal((await f.result).failureCode, 'structured_api_contract_missing'); assert.deepEqual(f.requests, [docs])
})

test('documentation redirects cannot authorize an unrelated specification host', async () => {
  const requested: string[] = []
  const result = await researchCandidate({ candidate, normalizedDomain: 'acme.example', claimResearchBudget: async () => 'claimed',
    fetcher: (url, options) => boundedDiscoveryFetch(url, options, async target => {
      requested.push(target)
      return target === docs ? new Response('<a href="/openapi.json">OpenAPI</a>', { headers: { 'content-type': 'text/html' } })
        : new Response(null, { status: 302, headers: { location: 'https://unrelated.example/forged.json' } })
    }) })
  assert.equal(result.docsVerified, false); assert.equal(requested.length, 2)
  assert.equal(requested.some(url => url.includes('unrelated')), false)
})

test('missing, unsupported and temporary contract failures retain distinct outcomes', async () => {
  const cases = [
    { body: '<html>No contract published</html>', type: 'text/html', status: 200, expected: 'structured_api_contract_missing' },
    { body: specification(undefined, '4.0.0'), type: 'application/json', status: 200, expected: 'unsupported_api_spec_version' },
    { body: '', type: 'text/html', status: 503, expected: 'official_docs_unreachable' },
    { body: '<html>No longer published</html>', type: 'text/html', status: 404, expected: 'structured_api_contract_missing' },
  ]
  for (const c of cases) {
    const f = run(async url => url === docs ? response(url, '<a href="/openapi.json">OpenAPI</a>') : response(url, c.body, c.type, c.status))
    const result = await f.result
    assert.equal(result.docsVerified, false); assert.equal(result.failureCode, c.expected)
  }
})

test('broken directory contract HTML can fall back to the separate official docs URL', async () => {
  const f = run(async url => url.endsWith('/schema.json') ? response(url, specification(), 'application/json')
    : response(url, url === docs ? '<redoc spec-url="/schema.json"></redoc>' : '<p>Not a specification</p>'),
  { discoveredContractUrl: 'https://directory.example/contract' })
  assert.equal((await f.result).docsVerified, true); assert.equal(f.requests.length, 3)
})

test('discovery requests, redirects and budget denial are bounded; replay cannot issue another request', async () => {
  const ledger = new Set<string>(), attempts: string[] = []
  const input = { candidate, normalizedDomain: 'acme.example', claimResearchBudget: async (key: string) => {
    if (ledger.has(key)) return 'replayed' as const
    ledger.add(key); return 'claimed' as const
  }, fetcher: (url: string, options?: Parameters<DiscoveryFetcher>[1]) => boundedDiscoveryFetch(url, options, async target => {
    attempts.push(target)
    if (target.endsWith('/openapi.json')) return new Response(null, { status: 302, headers: { location: '/schema.json' } })
    return new Response(target.endsWith('/schema.json') ? specification() : '<a href="/openapi.json">OpenAPI</a>',
      { headers: { 'content-type': target.endsWith('/schema.json') ? 'application/json' : 'text/html' } })
  }) }
  assert.equal((await researchCandidate(input)).docsVerified, true)
  assert.equal(ledger.size, 3); assert.equal(attempts.length, 3)
  assert.equal((await researchCandidate(input)).failureCode, 'research_claim_replayed')
  assert.equal(attempts.length, 3)
  const denied = await researchCandidate({ candidate, normalizedDomain: 'acme.example',
    claimResearchBudget: async key => key === 'contract' ? 'claimed' : 'exhausted',
    fetcher: async url => response(url, '<a href="/schema.json">OpenAPI</a>') })
  assert.equal(denied.failureCode, 'research_budget_exhausted')
})

test('documentation traversal cannot exceed four linked requests or loop forever', async () => {
  const f = run(async url => response(url, Array.from({ length: 30 }, (_, i) => `<a href="/schema${i}.json">OpenAPI</a>`).join('')))
  assert.equal((await f.result).failureCode, 'official_docs_unreachable'); assert.equal(f.requests.length, 5)
})

test('deadline prevents linked HTTP and unsupported contracts never reach verification', async () => {
  let requests = 0
  const result = await researchCandidate({ candidate, normalizedDomain: 'acme.example', deadlineMs: Date.now() - 1,
    claimResearchBudget: async () => 'claimed', fetcher: async url => { requests++; return response(url, '') } })
  assert.equal(result.failureCode, 'run_budget_exhausted'); assert.equal(requests, 0)
})

test('temporary linked-contract transport failure remains recoverable in a later batch', async () => {
  let healthy = false
  const fetcher: DiscoveryFetcher = async url => {
    if (url === docs) return response(url, '<a href="/openapi.json">OpenAPI</a>')
    if (!healthy) throw new Error('connection_reset')
    return response(url, specification(), 'application/json')
  }
  const failed = await run(fetcher).result
  assert.equal(failed.failureCode, 'official_docs_unreachable'); assert.equal(failed.compatibilityFailure, null)
  healthy = true
  assert.equal((await run(fetcher).result).docsVerified, true)
})

test('separate spec-host access requires established official-page identity before requesting it', async () => {
  const f = run(async url => response(url, '<a href="https://specs.cdn.example/schema.json">OpenAPI</a>'))
  assert.equal((await f.result).failureCode, 'provider_ownership_unverified')
  assert.deepEqual(f.requests, [docs])
})

test('linked YAML is classified as unsupported format, never accepted as HTML or a JSON contract', async () => {
  const f = run(async url => url === docs ? response(url, '<a href="/openapi.yaml">OpenAPI</a>')
    : response(url, 'openapi: 3.0.0', 'application/yaml'))
  assert.equal((await f.result).failureCode, 'unsupported_api_spec_format')
})

test('database budget failures escape research without finalizing an ordinary candidate outcome', async () => {
  await assert.rejects(researchCandidate({ candidate, normalizedDomain: 'acme.example',
    claimResearchBudget: async key => { if (key !== 'contract') throw new WorkerMailInfrastructureError('database_unavailable'); return 'claimed' },
    fetcher: async url => response(url, '<a href="/openapi.json">OpenAPI</a>') }), WorkerMailInfrastructureError)
})

test('866,618-byte Guru detail is rejected at 512 KiB and its body is cancelled before reading', async () => {
  let cancelled = false, pulls = 0
  await assert.rejects(boundedDiscoveryFetch('https://api.apis.guru/v2/amazonaws.com.json', {}, async () => new Response(
    new ReadableStream({ pull() { pulls++ }, cancel() { cancelled = true } }),
    { headers: { 'content-length': '866618', 'content-type': 'application/json' } })), DiscoveryResponseTooLargeError)
  assert.equal(cancelled, true); assert.ok(pulls <= 1)
})
