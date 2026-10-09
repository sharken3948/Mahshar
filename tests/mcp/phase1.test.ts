import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { POST as mcpPost } from '../../src/app/api/mcp/route'
import { createMahsharMcpHandler } from '../../src/lib/mcp/server'

const API_ID = '11111111-1111-4111-8111-111111111111'

const publicListing = {
  id: API_ID,
  name: 'Weather observations',
  description: 'Returns recent public weather observations.',
  category: 'weather',
  price_per_call_usdc: 0.02,
  payment_model: 'x402-pay-per-call',
  auth: {
    type: 'apikey',
    injected_by: 'mahshar',
    credential_location: 'header x-api-key',
    seller_credentials_exposed: false,
  },
  auth_type: 'apikey',
  method: 'GET',
  score: 0.95,
  verified: true,
  example_request: null,
  example_response: { temperature: 20 },
  total_calls: 12,
  success_rate: 1,
  avg_latency_ms: 45,
  proxy_url: `https://mahshar.xyz/api/proxy/${API_ID}`,
  proxy_style: 'path',
  request: {
    outer_method: 'GET',
    content_type: null,
    body: {
      supported: false,
      required: false,
      schema: null,
      example: null,
      delete_body_supported: false,
    },
    dynamic_path: { supported: false, transport: null },
    query_transport: 'proxy_url query string',
    path_parameters: [],
    query_parameters: [{ name: 'city', required: true, type: 'string' }],
    example: null,
    incoming_headers: {
      supported: false,
      reason: 'Buyer-supplied headers are not forwarded upstream.',
    },
  },
  response: {
    content_type: 'application/json',
    schema: { type: 'object' },
    example: { temperature: 20 },
    wrapper: {
      response: 'Upstream JSON value or text string.',
      latency_ms: 'number',
      payment: 'ACCOUNTING_COMPLETE',
      delivery_state: 'SUCCEEDED | FAILED_RETRYABLE | FAILED_FINAL | UNKNOWN',
      attemptId: 'string',
      purchase_access_token: 'string',
    },
  },
  endpoint_url: 'https://seller.internal/weather',
  encrypted_credentials: 'ciphertext-secret',
  auth_param_name: 'private-query-key',
  seller_wallet: '0xprivate',
  credential_configured: true,
}

function discoveryResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    apis: [publicListing],
    pagination: { limit: 20, offset: 0, returned: 1, next_offset: null },
    ...overrides,
  }), { headers: { 'content-type': 'application/json' } })
}

const clientMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'mahshar-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': { tools: {} },
}

async function modernRequest(
  handler: ReturnType<typeof createMahsharMcpHandler>,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
) {
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  })
  if (name) headers.set('mcp-name', name)
  const response = await handler.fetch(new Request('https://mahshar.xyz/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: clientMeta },
    }),
  }))
  return { response, body: await response.json() as Record<string, any> }
}

async function modernRouteRequest(method: string, params: Record<string, unknown> = {}) {
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  })
  const response = await mcpPost(new Request('https://mahshar.xyz/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: clientMeta } }),
  }))
  return { response, body: await response.json() as Record<string, any> }
}

function handlerWith(responseFactory?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  return createMahsharMcpHandler({
    origin: 'https://mahshar.xyz',
    fetcher: async (input, init) => {
      if (responseFactory) return responseFactory(input, init)
      const url = new URL(String(input))
      const limit = Number(url.searchParams.get('limit'))
      const offset = Number(url.searchParams.get('offset'))
      return discoveryResponse({
        pagination: { limit, offset, returned: 1, next_offset: null },
      })
    },
  })
}

test('MCP handshake is stateless, public, and JSON-only', async () => {
  const first = await modernRouteRequest('server/discover')
  const second = await modernRouteRequest('server/discover')

  assert.equal(first.response.status, 200)
  assert.match(first.response.headers.get('content-type') ?? '', /^application\/json/)
  assert.deepEqual(first.body.result.supportedVersions, ['2026-07-28'])
  assert.equal(first.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'mahshar-public-discovery')
  assert.equal(first.body.result.capabilities.tools.listChanged, false)
  assert.equal(second.response.status, 200)
  assert.equal(first.response.headers.has('mcp-session-id'), false)
  assert.equal(second.response.headers.has('mcp-session-id'), false)
})

test('subscriptions are disabled and return a terminal JSON error', async () => {
  const { response, body } = await modernRouteRequest('subscriptions/listen', {
    notifications: { toolsListChanged: true },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
  assert.equal(body.error.message, 'Subscription limit reached')
})

test('MCP request bodies are bounded before protocol parsing', async () => {
  const response = await mcpPost(new Request('https://mahshar.xyz/api/mcp', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: 'x'.repeat((16 * 1024) + 1),
  }))
  assert.equal(response.status, 413)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
})

test('tool discovery exposes only Phase 1 discovery tools', async () => {
  const { body } = await modernRequest(handlerWith(), 'tools/list')
  assert.deepEqual(body.result.tools.map((tool: { name: string }) => tool.name), ['search_apis', 'get_api'])
  assert.equal(body.result.tools.every((tool: { inputSchema: { additionalProperties: boolean } }) =>
    tool.inputSchema.additionalProperties === false), true)
})

test('search_apis pages safe active discovery summaries', async () => {
  let requestedUrl = ''
  const handler = createMahsharMcpHandler({
    origin: 'https://mahshar.xyz',
    fetcher: async input => {
      requestedUrl = String(input)
      return discoveryResponse({ pagination: { limit: 10, offset: 20, returned: 1, next_offset: null } })
    },
  })
  const { body } = await modernRequest(handler, 'tools/call', {
    name: 'search_apis',
    arguments: { limit: 10, offset: 20 },
  }, 'search_apis')

  assert.equal(requestedUrl, 'https://mahshar.xyz/api/agent/discover?limit=10&offset=20')
  assert.equal(body.result.structuredContent.apis.length, 1)
  assert.equal(body.result.structuredContent.apis[0].id, API_ID)
  assert.equal(body.result.structuredContent.pagination.returned, 1)
})

test('get_api returns the complete safe public execution contract', async () => {
  const { body } = await modernRequest(handlerWith(), 'tools/call', {
    name: 'get_api',
    arguments: { api_id: API_ID },
  }, 'get_api')

  const api = body.result.structuredContent.api
  assert.equal(api.id, API_ID)
  assert.equal(api.request.query_parameters[0].name, 'city')
  assert.equal(api.response.wrapper.purchase_access_token, 'string')
})

test('get_api reports an unknown active API ID without accessing private routes', async () => {
  const unknownId = '22222222-2222-4222-8222-222222222222'
  const { body } = await modernRequest(handlerWith(), 'tools/call', {
    name: 'get_api',
    arguments: { api_id: unknownId },
  }, 'get_api')

  assert.equal(body.result.isError, true)
  assert.deepEqual(body.result.structuredContent, { error: 'api_not_found', api_id: unknownId })
})

test('get_api follows only consistent bounded discovery pages', async () => {
  const otherId = '22222222-2222-4222-8222-222222222222'
  const offsets: number[] = []
  const handler = handlerWith(input => {
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get('offset'))
    offsets.push(offset)
    if (offset < 200) {
      return discoveryResponse({
        apis: Array.from({ length: 100 }, () => ({ ...publicListing, id: otherId })),
        pagination: { limit: 100, offset, returned: 100, next_offset: offset + 100 },
      })
    }
    return discoveryResponse({
      pagination: { limit: 100, offset, returned: 1, next_offset: null },
    })
  })
  const { body } = await modernRequest(handler, 'tools/call', {
    name: 'get_api', arguments: { api_id: API_ID },
  }, 'get_api')

  assert.equal(body.result.structuredContent.api.id, API_ID)
  assert.deepEqual(offsets, [0, 100, 200])
})

test('tool schemas reject pagination overflow, invalid IDs, and unknown arguments', async () => {
  let fetches = 0
  const handler = createMahsharMcpHandler({
    origin: 'https://mahshar.xyz',
    fetcher: async () => {
      fetches += 1
      return discoveryResponse()
    },
  })
  const invalidCalls = [
    ['search_apis', { limit: 101 }],
    ['search_apis', { limit: 10, unexpected: true }],
    ['get_api', { api_id: 'not-an-id' }],
    ['get_api', { api_id: 'x'.repeat(500) }],
    ['get_api', { api_id: API_ID, unexpected: true }],
  ] as const

  for (const [name, args] of invalidCalls) {
    const { body } = await modernRequest(handler, 'tools/call', { name, arguments: args }, name)
    assert.equal(body.result.isError, true)
  }
  assert.equal(fetches, 0)
})

test('private listing fields and credentials are stripped from all MCP results', async () => {
  const handler = handlerWith()
  const search = await modernRequest(handler, 'tools/call', {
    name: 'search_apis', arguments: {},
  }, 'search_apis')
  const get = await modernRequest(handler, 'tools/call', {
    name: 'get_api', arguments: { api_id: API_ID },
  }, 'get_api')
  const serialized = JSON.stringify([search.body, get.body])

  for (const forbidden of [
    'seller.internal', 'ciphertext-secret', 'private-query-key', '0xprivate',
    'encrypted_credentials', 'endpoint_url', 'auth_param_name', 'seller_wallet', 'credential_configured',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden)
})

test('discovery source failure is isolated to the tool result', async () => {
  let fail = true
  const handler = handlerWith(input => fail
    ? new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
    : (() => {
      const url = new URL(String(input))
      const limit = Number(url.searchParams.get('limit'))
      const offset = Number(url.searchParams.get('offset'))
      return discoveryResponse({ pagination: { limit, offset, returned: 1, next_offset: null } })
    })())

  const failed = await modernRequest(handler, 'tools/call', {
    name: 'search_apis', arguments: {},
  }, 'search_apis')
  assert.equal(failed.body.result.isError, true)
  assert.deepEqual(failed.body.result.structuredContent, { error: 'discovery_unavailable' })

  fail = false
  const recovered = await modernRequest(handler, 'tools/call', {
    name: 'search_apis', arguments: {},
  }, 'search_apis')
  assert.equal(recovered.body.result.isError, undefined)
  assert.equal(recovered.body.result.structuredContent.apis.length, 1)
})

test('discovery timeout, malformed data, oversized data, and pagination drift fail safely', async () => {
  const failures: Array<[string, ReturnType<typeof createMahsharMcpHandler>]> = [
    ['timeout', createMahsharMcpHandler({
      origin: 'https://mahshar.xyz',
      timeoutMs: 5,
      fetcher: async (_input, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        throw new Error('unreachable')
      },
    })],
    ['malformed JSON', handlerWith(() => new Response('{'))],
    ['unexpected DTO', handlerWith(() => new Response(JSON.stringify({ apis: 'invalid' })))],
    ['oversized DTO', handlerWith(() => new Response('x'.repeat((4 * 1024 * 1024) + 1)))],
    ['pagination drift', handlerWith(() => discoveryResponse({
      pagination: { limit: 20, offset: 1, returned: 1, next_offset: null },
    }))],
  ]

  for (const [label, handler] of failures) {
    const { body } = await modernRequest(handler, 'tools/call', {
      name: 'search_apis', arguments: {},
    }, 'search_apis')
    assert.equal(body.result.isError, true, label)
    assert.deepEqual(body.result.structuredContent, { error: 'discovery_unavailable' }, label)
  }

  const healthy = await modernRequest(handlerWith(), 'tools/call', {
    name: 'search_apis', arguments: {},
  }, 'search_apis')
  assert.equal(healthy.body.result.structuredContent.apis.length, 1)
})

test('get_api rejects inconsistent pagination without traversing another page', async () => {
  let fetches = 0
  const handler = handlerWith(() => {
    fetches += 1
    return discoveryResponse({
      apis: [],
      pagination: { limit: 100, offset: 0, returned: 0, next_offset: 100 },
    })
  })
  const { body } = await modernRequest(handler, 'tools/call', {
    name: 'get_api', arguments: { api_id: API_ID },
  }, 'get_api')

  assert.equal(body.result.isError, true)
  assert.deepEqual(body.result.structuredContent, { error: 'discovery_unavailable' })
  assert.equal(fetches, 1)
})

test('MCP discovery modules have no database, credential, proxy, or payment-private imports', async () => {
  const files = await Promise.all([
    readFile(new URL('../../src/app/api/mcp/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/lib/mcp/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/lib/mcp/discovery-client.ts', import.meta.url), 'utf8'),
  ])
  const source = files.join('\n')
  const imports = source.split('\n').filter(line => /^import\s/.test(line)).join('\n')

  for (const forbidden of [
    'supabase', 'decrypt', 'credential', '@/lib/proxy', 'payments/settlement',
    'payments/delivery', 'marketplace/proxy-target', 'marketplace/purchase-access',
  ]) assert.equal(imports.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden)
  assert.equal(source.includes('/api/apis/'), false)
  assert.equal(source.includes("new URL('/api/agent/discover'"), true)
})
