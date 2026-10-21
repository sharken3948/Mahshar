import { readAgentDiscovery } from '../../src/lib/agent-discovery-document'
import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, state, reset, sessionHeaders, origin } from '../marketplace/fixtures'
import { GET as catalog, POST as create } from '../../src/app/api/apis/route'
import { PATCH } from '../../src/app/api/apis/[id]/route'
import { POST as onramp } from '../../src/app/api/onramp/session/route'
import { GET as maintenance } from '../../src/app/api/internal/maintenance/prune-responses/route'
import { enableTestBudgets, disableTestBudgets } from './policy-fixture'
import { getPublicSeoListing } from '../../src/lib/seo/public-catalog'
import { createDiscoveryClient } from '../../src/lib/mcp/discovery-client'

beforeEach(() => { reset(); enableTestBudgets() })
afterEach(disableTestBudgets)
const id = '11111111-1111-4111-8111-111111111111'
function listing(index = 1) {
  return { id: index === 1 ? id : `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    name: 'Weather', description: 'Weather observations', category: 'weather', price_per_call: 0.001,
    payment_model: 'pay-per-call', seller_wallet: alice.address.toLowerCase(), auth_type: 'public',
    score: null, method: 'GET', endpoint_url: 'https://example.com/weather', is_active: true, verified_at: new Date().toISOString(),
    created_at: new Date(index * 1000).toISOString(), example_request: null, example_response: null }
}
function mutation(path: string, body: unknown, method = 'POST') {
  return new NextRequest(origin + path, { method, headers: { ...sessionHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

test('listing admission denial or outage stops persistence and endpoint DNS work', async () => {
  for (const unavailable of [false, true]) {
    reset(); state.resourceAllowed = false; state.resourceError = unavailable
    const response = await create(mutation('/api/apis', { ...listing(), is_active: undefined }))
    assert.equal(response.status, unavailable ? 503 : 429)
    assert.equal(state.tables.api_listings.length, 0)
    assert.equal(state.urlValidationCalls, 0)
    assert.equal(state.resourceCalls, 1)
  }
})

test('public catalog stays fresh, bounds pagination and never caches owner responses', async () => {
  state.tables.api_listings = Array.from({ length: 105 }, (_, i) => listing(i + 1))
  const first = await catalog(new NextRequest(origin + '/api/apis?limit=100'))
  assert.equal((await first.json()).apis.length, 100)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  const reads = state.reads
  await catalog(new NextRequest(origin + '/api/apis?limit=100'))
  assert.ok(state.reads > reads)
  const second = await catalog(new NextRequest(origin + '/api/apis?limit=100&offset=100'))
  assert.equal((await second.json()).apis.length, 5)
  const owner = await catalog(new NextRequest(origin + `/api/apis?seller_wallet=${alice.address}`, { headers: sessionHeaders() }))
  assert.equal((await owner.json()).apis.length, 105)
  assert.equal(owner.headers.get('cache-control'), 'no-store')
  const unpaginated = await catalog(new NextRequest(origin + '/api/apis'))
  assert.equal((await unpaginated.json()).apis.length, 105)
})

test('MCP lookup uses the local public discovery service and one indexed listing read', async () => {
  state.tables.api_listings = [listing()]
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('SELF_HTTP_FORBIDDEN') }
  try {
    const result = await createDiscoveryClient({ origin, loadPage: (url, signal) => readAgentDiscovery(new NextRequest(url, { signal })) }).find(id)
    assert.equal(result?.id, id)
    assert.equal(state.reads, 1)
    const missing = await createDiscoveryClient({ origin, loadPage: (url, signal) => readAgentDiscovery(new NextRequest(url, { signal })) }).find('22222222-2222-4222-8222-222222222222')
    assert.equal(missing, null)
    assert.equal(state.reads, 2)
  } finally { globalThis.fetch = original }
})

test('disabled Onramp policy preserves baseline validation without a new admission dependency', async () => {
  disableTestBudgets(); state.resourceError = true
  const response = await onramp(mutation('/api/onramp/session', {}))
  assert.equal(response.status, 400)
  assert.equal(state.resourceCalls, 0)
})

test('Onramp budget denial stops provider work and is machine readable', async () => {
  state.resourceAllowed = false
  const response = await onramp(mutation('/api/onramp/session', {}))
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error, 'resource_budget_exhausted')
})

test('Onramp releases its admitted slot when provider configuration is unavailable', async () => {
  const previous = process.env.CIRCLE_ONRAMP_API_KEY
  delete process.env.CIRCLE_ONRAMP_API_KEY
  try {
    const response = await onramp(mutation('/api/onramp/session', { destinationAddress: alice.address }))
    assert.equal(response.status, 503)
    assert.equal(state.resourceCalls, 1)
    assert.equal(state.resourceReleaseCalls, 1)
  } finally {
    if (previous !== undefined) process.env.CIRCLE_ONRAMP_API_KEY = previous
  }
})

test('successful seller metadata edits are immediately visible in public reads', async () => {
  state.tables.api_listings = [listing()]
  await catalog(new NextRequest(origin + '/api/apis'))
  const response = await PATCH(mutation(`/api/apis/${id}`, { name: 'Updated weather' }, 'PATCH'), { params: Promise.resolve({ id }) })
  assert.equal(response.status, 200)
  const updated = await catalog(new NextRequest(origin + '/api/apis'))
  assert.equal((await updated.json()).apis[0].name, 'Updated weather')
})

test('operational retention stays behind the existing secret and cannot fail response/auth cleanup', async () => {
  process.env.CRON_SECRET = 'offline-'.repeat(8)
  try {
    assert.equal((await maintenance(new NextRequest(origin + '/api/internal/maintenance/prune-responses'))).status, 401)
    assert.equal(state.resourcePruneCalls, 0)
    state.resourceError = true
    const response = await maintenance(new NextRequest(origin + '/api/internal/maintenance/prune-responses', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }))
    assert.equal(response.status, 200)
    assert.equal(state.resourcePruneCalls, 1)
    assert.equal(state.pruneCalls, 1)
    assert.equal(state.authPruneCalls, 1)
  } finally { delete process.env.CRON_SECRET }
})

test('operational maintenance stops at five bounded batches during a backlog', async () => {
  process.env.CRON_SECRET = 'offline-'.repeat(8)
  state.resourcePruneResult = 1000
  try {
    const response = await maintenance(new NextRequest(origin + '/api/internal/maintenance/prune-responses', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }))
    assert.equal(response.status, 200)
    assert.equal(state.resourcePruneCalls, 5)
  } finally { delete process.env.CRON_SECRET }
})

test('independent-instance listing changes appear immediately across catalog, discovery and SEO', async () => {
  state.tables.api_listings = [listing()]
  async function view() {
    const publicCatalog = await catalog(new NextRequest(origin + '/api/apis'))
    const discovery = await readAgentDiscovery(new NextRequest(origin + '/api/agent/discover?api_id=' + id))
    assert.equal(publicCatalog.headers.get('cache-control'), 'no-store')
    assert.equal(discovery.headers.get('cache-control'), 'no-store')
    return { catalog: (await publicCatalog.json()).apis, discovery: (await discovery.json()).apis, seo: await getPublicSeoListing(id) }
  }
  assert.equal((await view()).catalog.length, 1)
  // Model a mutation committed by another instance: no process invalidation call.
  state.tables.api_listings[0].is_active = false
  let result = await view()
  assert.equal(result.catalog.length, 0); assert.equal(result.discovery.length, 0); assert.equal(result.seo, null)
  state.tables.api_listings[0].is_active = true
  Object.assign(state.tables.api_listings[0], { name: 'Current name', price_per_call: 0.25 })
  result = await view()
  assert.equal(result.catalog[0].name, 'Current name')
  assert.equal(result.catalog[0].price_per_call, 0.25)
  assert.equal(result.discovery[0].price_per_call_usdc, 0.25)
  assert.equal(result.seo?.name, 'Current name')
  state.tables.api_listings = []
  result = await view()
  assert.equal(result.catalog.length, 0); assert.equal(result.discovery.length, 0); assert.equal(result.seo, null)
})
