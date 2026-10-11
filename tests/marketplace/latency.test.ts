import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { validateListingRequestContract } from '../../src/lib/marketplace/request-contract'

const routeSource = readFileSync('src/app/api/apis/latency/route.ts', 'utf8')
const compiledRoute = transpileModule(routeSource, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
}).outputText

function routeGet(database: unknown) {
  const routeModule = { exports: {} as Record<string, unknown> }
  const routeRequire = (specifier: string) => {
    if (specifier === 'next/server') return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }
    if (specifier === '@/lib/supabase/server') return { createServiceClient: () => database }
    if (specifier === '@/lib/marketplace/request-contract') return { validateListingRequestContract }
    throw new Error(`Unexpected latency route import: ${specifier}`)
  }
  Function('require', 'module', 'exports', compiledRoute)(routeRequire, routeModule, routeModule.exports)
  return routeModule.exports.GET as () => Promise<Response>
}

type Listing = {
  id: string
  is_active: boolean
  endpoint_url: string
  auth_type: string
  auth_param_name: string | null
  method: string
  example_request: string | null
  request_schema: Record<string, unknown> | null
  body_required: boolean | null
  dynamic_path_supported: boolean
  path_parameters: unknown[] | null
  query_parameters: unknown[] | null
}

type Call = { api_id: string; latency_ms: number; success: boolean }

function idFor(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function listing(index: number, overrides: Partial<Listing> = {}): Listing {
  const id = idFor(index)
  return {
    id,
    is_active: true,
    endpoint_url: `https://api-${index}.example/data`,
    auth_type: 'public',
    auth_param_name: null,
    method: 'GET',
    example_request: null,
    request_schema: null,
    body_required: false,
    dynamic_path_supported: false,
    path_parameters: null,
    query_parameters: null,
    ...overrides,
  }
}

type Observation = {
  tables: string[]
  selects: string[]
  selectOptions: unknown[]
  limits: number[]
  cursors: Array<string | null>
  rpcIds: string[][]
}

function database(input: {
  listings: Listing[]
  calls?: Call[]
  listingError?: string
  listingErrorAtQuery?: number
  rpcError?: string
  pageOverrides?: Listing[][]
  extraStats?: Array<{ api_id: string; avg_latency_ms: number | string | null }>
}) {
  const observation: Observation = {
    tables: [], selects: [], selectOptions: [], limits: [], cursors: [], rpcIds: [],
  }
  const activeListings = input.listings
    .filter(row => row.is_active)
    .sort((a, b) => a.id.localeCompare(b.id))
  let queryNumber = 0

  class ListingQuery {
    private active: boolean | null = null
    private after: string | null = null
    private maximum = Number.MAX_SAFE_INTEGER

    select(columns: string, options?: unknown) {
      observation.selects.push(columns)
      observation.selectOptions.push(options)
      return this
    }
    eq(key: string, value: unknown) {
      assert.equal(key, 'is_active')
      this.active = Boolean(value)
      return this
    }
    gt(key: string, value: string) {
      assert.equal(key, 'id')
      this.after = value
      return this
    }
    order(key: string, options?: { ascending?: boolean }) {
      assert.equal(key, 'id')
      assert.equal(options?.ascending, true)
      return this
    }
    limit(maximum: number) {
      observation.limits.push(maximum)
      this.maximum = maximum
      return this
    }
    then(resolve: (value: unknown) => unknown) {
      const currentQuery = queryNumber++
      observation.cursors.push(this.after)
      if (input.listingError || input.listingErrorAtQuery === currentQuery) {
        const message = input.listingError ?? `pagination detail ${currentQuery} must not leak`
        return Promise.resolve({ data: null, error: { message } }).then(resolve)
      }
      const eligible = input.pageOverrides?.[currentQuery] ?? activeListings
        .filter(row => (this.active === null || row.is_active === this.active) && (this.after === null || row.id > this.after))
        .slice(0, this.maximum)
      return Promise.resolve({ data: eligible.slice(0, this.maximum), error: null }).then(resolve)
    }
  }

  const db = {
    from(name: string) {
      observation.tables.push(name)
      assert.equal(name, 'api_listings', 'the latency route must never read api_calls history directly')
      return new ListingQuery()
    },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, 'mahshar_agent_listing_stats')
      const ids = args.p_api_ids as string[]
      observation.rpcIds.push([...ids])
      if (input.rpcError) return { data: null, error: { message: input.rpcError } }

      const rows = ids.flatMap(apiId => {
        const calls = (input.calls ?? []).filter(call => call.api_id === apiId)
        if (calls.length === 0) return []
        return [{
          api_id: apiId,
          total_calls: calls.length,
          successful_calls: calls.filter(call => call.success).length,
          avg_latency_ms: calls.reduce((sum, call) => sum + call.latency_ms, 0) / calls.length,
        }]
      })
      return { data: [...rows, ...(input.extraStats ?? [])], error: null }
    },
  }

  return { db: db as never, observation }
}

test('latency response preserves shape and rounding while excluding inactive and invalid public listings', async () => {
  const active = listing(1)
  const withoutCalls = listing(2)
  const invalid = listing(3, { method: 'TRACE' })
  const inactive = listing(4, { is_active: false })
  const { db, observation } = database({
    listings: [inactive, invalid, withoutCalls, active],
    calls: [
      { api_id: active.id, latency_ms: 100, success: true },
      { api_id: active.id, latency_ms: 101, success: false },
      { api_id: invalid.id, latency_ms: 1, success: true },
      { api_id: inactive.id, latency_ms: 2, success: true },
    ],
    extraStats: [{ api_id: inactive.id, avg_latency_ms: 2 }],
  })

  const response = await routeGet(db)()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { latencies: { [active.id]: 101 } })
  assert.deepEqual(observation.rpcIds, [[active.id, withoutCalls.id]])
  assert.deepEqual(observation.tables, ['api_listings'])
  assert.equal(observation.selects.every(columns => columns !== '*' && !columns.includes('latency_ms')), true)
  assert.equal(observation.selectOptions.every(options => options === undefined), true)
})

test('empty active inventory returns an empty compatible response after one bounded query without an RPC call', async () => {
  const { db, observation } = database({ listings: [listing(1, { is_active: false })] })
  const response = await routeGet(db)()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { latencies: {} })
  assert.deepEqual(observation.limits, [100])
  assert.deepEqual(observation.cursors, [null])
  assert.deepEqual(observation.rpcIds, [])
})

test('short and exact page boundaries terminate with deterministic keyset cursors', async () => {
  for (const size of [99, 100, 205]) {
    const listings = Array.from({ length: size }, (_, index) => listing(index))
    const { db, observation } = database({ listings })
    const response = await routeGet(db)()
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { latencies: {} })
    assert.equal(observation.limits.every(limit => limit === 100), true)
    assert.equal(observation.rpcIds.every(ids => ids.length <= 100), true)
    assert.equal(new Set(observation.cursors.filter(Boolean)).size, observation.cursors.filter(Boolean).length)
    if (size === 99) assert.deepEqual(observation.cursors, [null])
    if (size === 100) assert.deepEqual(observation.cursors, [null, listings[99].id])
    if (size === 205) {
      assert.deepEqual(observation.cursors, [null, listings[99].id, listings[199].id])
      assert.deepEqual(observation.rpcIds.map(ids => ids.length), [100, 100, 5])
    }
  }
})

test('exactly 10,100 active listings are accepted with bounded pages and a one-row sentinel', async () => {
  const listings = Array.from({ length: 10_100 }, (_, index) => listing(index))
  const { db, observation } = database({ listings })
  const response = await routeGet(db)()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { latencies: {} })
  assert.equal(observation.limits.length, 102)
  assert.equal(observation.limits.slice(0, -1).every(limit => limit === 100), true)
  assert.equal(observation.limits.at(-1), 1)
  assert.equal(observation.rpcIds.length, 101)
  assert.equal(observation.rpcIds.every(ids => ids.length === 100), true)
  assert.equal(new Set(observation.cursors.filter(Boolean)).size, 101)
})

test('10,101 active listings are rejected by the bounded sentinel', async () => {
  const listings = Array.from({ length: 10_101 }, (_, index) => listing(index))
  const { db, observation } = database({ listings })
  const response = await routeGet(db)()
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Failed to fetch latency statistics' })
  assert.equal(observation.limits.length, 102)
  assert.equal(observation.limits.at(-1), 1)
  assert.equal(observation.rpcIds.length, 101)
})

test('listing, later pagination, and statistics failures return sanitized compatible 500 responses', async () => {
  const listings = Array.from({ length: 101 }, (_, index) => listing(index))
  for (const fixture of [
    database({ listings: [], listingError: 'service-role listing detail must not leak' }),
    database({ listings, listingErrorAtQuery: 1 }),
    database({ listings: [listing(1)], rpcError: 'service-role RPC detail must not leak' }),
  ]) {
    const response = await routeGet(fixture.db)()
    const text = await response.text()
    assert.equal(response.status, 500)
    assert.deepEqual(JSON.parse(text), { error: 'Failed to fetch latency statistics' })
    assert.equal(text.includes('service-role'), false)
    assert.equal(text.includes('pagination detail'), false)
  }
})

test('malformed IDs and repeated pagination cursors fail closed without looping', async () => {
  const malformed = database({ listings: [listing(1, { id: 'not-a-uuid' })] })
  const malformedResponse = await routeGet(malformed.db)()
  assert.equal(malformedResponse.status, 500)
  assert.deepEqual(malformed.observation.rpcIds, [])

  const firstPage = Array.from({ length: 100 }, (_, index) => listing(index))
  const repeated = database({
    listings: firstPage,
    pageOverrides: [firstPage, [firstPage[99]]],
  })
  const repeatedResponse = await routeGet(repeated.db)()
  assert.equal(repeatedResponse.status, 500)
  assert.equal(repeated.observation.cursors.length, 2)
  assert.deepEqual(repeated.observation.rpcIds.map(ids => ids.length), [100])
})

test('source and Buyer contracts retain bounded public latency behavior without exact counts or history reads', () => {
  const route = readFileSync('src/app/api/apis/latency/route.ts', 'utf8')
  assert.doesNotMatch(route, /from\(['"]api_calls['"]\)/)
  assert.doesNotMatch(route, /count\s*:\s*['"]exact['"]|\.range\(/)
  assert.match(route, /\.gt\(['"]id['"], cursor/)
  assert.match(route, /\.limit\(LISTING_PAGE_SIZE\)/)
  assert.match(route, /\.limit\(1\)/)
  assert.match(route, /rpc\(['"]mahshar_agent_listing_stats['"]/)
  assert.match(route, /Math\.round\(average\)/)

  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  assert.match(buyer, /coalescedJsonGet<\{ latencies\?: Record<string, number> \}>\('\/api\/apis\/latency'\)/)
  assert.match(buyer, /setLatencyMap\(data\.latencies \?\? \{\}\)/)
  assert.match(buyer, /avgLatency=\{latencyMap\[api\.id\] \?\? null\}/)
  assert.match(buyer, /avgLatency != null \? `\$\{avgLatency\}ms` : 'Unknown'/)
  assert.match(buyer, /latencyFilter === 'under-100'/)
  assert.match(buyer, /sortBy === 'latency'/)
})
