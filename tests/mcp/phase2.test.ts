import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createMahsharMcpHandler } from '../../src/lib/mcp/server'
import { issuePreparedCallToken, verifyPreparedCallToken } from '../../src/lib/mcp/prepared-call'
import { buildProxyRequest, normalizePreparedCall } from '../../src/lib/mcp/request-builder'

process.env.ENCRYPTION_KEY = 'ab'.repeat(32)

const API_ID = '11111111-1111-4111-8111-111111111111'
const WALLET = '0x1111111111111111111111111111111111111111'
const OTHER_WALLET = '0x2222222222222222222222222222222222222222'
const PAYMENT_SIGNATURE = Buffer.from('{"synthetic":"no-money"}').toString('base64')
const PURCHASE_TOKEN = 'synthetic-capability.signature'

const listing = {
  id: API_ID,
  name: 'Weather observations', description: 'Weather', category: 'weather', price_per_call_usdc: 0.02,
  payment_model: 'x402-pay-per-call' as const,
  auth: { type: 'apikey', injected_by: 'mahshar' as const, credential_location: 'header x-api-key', seller_credentials_exposed: false as const },
  auth_type: 'apikey', method: 'GET' as const, score: 1, verified: true, example_request: null, example_response: null,
  total_calls: 1, success_rate: 1, avg_latency_ms: 1,
  proxy_url: `https://mahshar.xyz/api/proxy/${API_ID}`, proxy_style: 'path' as const,
  request: {
    outer_method: 'GET' as const, content_type: null,
    body: { supported: false, required: false, schema: null, example: null, delete_body_supported: false },
    dynamic_path: { supported: false, transport: null }, query_transport: 'proxy_url query string',
    path_parameters: [], query_parameters: [{ name: 'city', required: true, type: 'string' as const }], example: null,
    incoming_headers: { supported: false as const, reason: 'Buyer-supplied headers are not forwarded upstream.' },
  },
  response: {
    content_type: 'application/json', schema: null, example: null,
    wrapper: { response: 'unknown', latency_ms: 'number', payment: 'ACCOUNTING_COMPLETE', delivery_state: 'string', attemptId: 'string', purchase_access_token: 'string' },
  },
}

const challenge = {
  x402Version: 2,
  resource: { url: `https://mahshar.xyz/api/proxy/${API_ID}?city=Istanbul`, description: 'Synthetic challenge', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'eip155:5042', asset: '0x3600000000000000000000000000000000000000', amount: '22000', payTo: OTHER_WALLET, maxTimeoutSeconds: 604800, extra: { name: 'USDC', version: '2' } }],
  extensions: { hint: 'Synthetic no-money fixture' },
}

const clientMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'phase2-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': { tools: {} },
}

function discoveryResponse(api = listing) {
  return new Response(JSON.stringify({ apis: [api], pagination: { limit: 100, offset: 0, returned: 1, next_offset: null } }), {
    headers: { 'content-type': 'application/json' },
  })
}

async function call(handler: ReturnType<typeof createMahsharMcpHandler>, name: string, args: Record<string, unknown>) {
  const response = await handler.fetch(new Request('https://mahshar.xyz/api/mcp', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: clientMeta } }),
  }))
  return await response.json() as Record<string, any>
}

function handlerWith(proxy: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  return createMahsharMcpHandler({
    origin: 'https://mahshar.xyz',
    fetcher: async (input, init) => String(input).includes('/api/agent/discover') ? discoveryResponse() : proxy(input, init),
  })
}

test('execute_api_call schema is strict and rejects every prohibited authority field', async () => {
  let fetches = 0
  const handler = handlerWith(async () => { fetches += 1; return new Response('{}') })
  for (const prohibited of ['private_key', 'url', 'path', 'headers', 'method', 'amount', 'recipient', 'asset', 'network', 'seller_credentials']) {
    const result = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, [prohibited]: 'forbidden' })
    assert.equal(result.result.isError, true, prohibited)
  }
  assert.equal(fetches, 0)
})
test('Stage A performs one unsigned real-402-shaped probe and returns the authoritative challenge and prepared call', async () => {
  let proxyCalls = 0
  const handler = handlerWith((input, init) => {
    proxyCalls += 1
    assert.equal(String(input), `https://mahshar.xyz/api/proxy/${API_ID}?city=Istanbul`)
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).has('payment-signature'), false)
    return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') } })
  })
  const response = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } })
  const value = response.result.structuredContent
  assert.equal(proxyCalls, 1)
  assert.equal(value.status, 'payment_required')
  assert.equal(value.http_status, 402)
  assert.deepEqual(value.challenge, challenge)
  assert.equal(value.prepared_call.buyer_wallet, WALLET)
  assert.equal(typeof value.prepared_call_token, 'string')
  assert.equal(JSON.stringify(value).includes('price_per_call_usdc'), false)
})

test('execute_api_call rejects an unknown active API before proxy transport', async () => {
  let proxyCalls = 0
  const handler = createMahsharMcpHandler({
    origin: 'https://mahshar.xyz',
    fetcher: async input => {
      const url = new URL(String(input))
      if (url.pathname !== '/api/agent/discover') proxyCalls += 1
      return new Response(JSON.stringify({ apis: [], pagination: { limit: 100, offset: 0, returned: 0, next_offset: null } }))
    },
  })
  const response = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET })
  assert.deepEqual(response.result.structuredContent, { status: 'request_rejected', error: 'api_not_found', api_id: API_ID })
  assert.equal(proxyCalls, 0)
})

test('fixed POST and envelope GET/POST/PUT/DELETE transports are derived only from public listing metadata', () => {
  const body = { hello: 'world' }
  const base = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { q: true }, body }, true)
  const fixedPost = { ...listing, method: 'POST' as const, proxy_style: 'path' as const, request: { ...listing.request, outer_method: 'POST' as const, body: { ...listing.request.body, supported: true }, query_parameters: [{ name: 'q', type: 'boolean' as const }] } }
  const fixed = buildProxyRequest(fixedPost, base, 'https://mahshar.xyz')
  assert.equal(fixed.init.method, 'POST')
  assert.equal(fixed.init.body, JSON.stringify(body))

  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
    const envelopeListing = { ...listing, method, proxy_style: 'envelope' as const, proxy_url: 'https://mahshar.xyz/api/proxy', request: { ...listing.request, outer_method: 'POST' as const, body: { ...listing.request.body, supported: method !== 'GET' }, dynamic_path: { supported: true, transport: 'envelope.path' }, path_parameters: [{ name: 'item', required: true, type: 'string' as const }], query_parameters: [{ name: 'q', type: 'boolean' as const }] } }
    const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, path_values: { item: 'a/b' }, query_values: { q: true }, ...(method === 'GET' ? {} : { body }) }, method !== 'GET')
    const built = buildProxyRequest(envelopeListing, prepared, 'https://mahshar.xyz')
    const envelope = JSON.parse(String(built.init.body))
    assert.equal(built.init.method, 'POST')
    assert.equal(envelope.method, method)
    assert.equal(envelope.path, '/a%2Fb?q=true')
    assert.equal(Object.hasOwn(envelope, 'body'), method !== 'GET')
  }
})

test('Stage B accepts exact prepared replay, forwards only Payment-Signature, and emits the paid body once', async () => {
  let token = ''
  const handler = handlerWith((_input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('payment-signature')) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') } })
    assert.equal(headers.get('payment-signature'), PAYMENT_SIGNATURE)
    assert.equal(headers.has('authorization'), false)
    const paid = { response: { marker: 'UPSTREAM_ONCE' }, payment: 'ACCOUNTING_COMPLETE', delivery_state: 'SUCCEEDED', retryable: false, attemptId: 'attempt-1', purchaseId: 'purchase-1', purchase_access_token: PURCHASE_TOKEN, retrieve_response: '/api/calls/last-response' }
    const settlement = { success: true, payer: WALLET, transaction: 'synthetic-tx', network: 'eip155:5042', amount: '22000' }
    return new Response(JSON.stringify(paid), { status: 200, headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settlement)).toString('base64') } })
  })
  const args = { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }
  const probe = await call(handler, 'execute_api_call', args)
  token = probe.result.structuredContent.prepared_call_token
  const paid = await call(handler, 'execute_api_call', { ...args, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE })
  const value = paid.result.structuredContent
  assert.equal(value.status, 'paid_result')
  assert.equal(value.delivery_state, 'SUCCEEDED')
  assert.equal(value.purchase_access_token, PURCHASE_TOKEN)
  assert.equal(paid.result.content[0].text.includes('UPSTREAM_ONCE'), false)
  assert.equal((JSON.stringify(paid.result).match(/UPSTREAM_ONCE/g) ?? []).length, 1)
})

test('prepared_call_token rejects tampering, expiry, call mismatch, and listing drift', () => {
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, body: { a: 1 } }, true)
  const token = issuePreparedCallToken(prepared, listing, 100)
  assert.deepEqual(verifyPreparedCallToken(token, prepared, listing, 101), { ok: true })
  assert.equal(verifyPreparedCallToken(`${token}x`, prepared, listing, 101).ok, false)
  assert.deepEqual(verifyPreparedCallToken(token, prepared, listing, 700), { ok: false, code: 'prepared_call_expired' })
  assert.deepEqual(verifyPreparedCallToken(token, { ...prepared, buyer_wallet: OTHER_WALLET }, listing, 101), { ok: false, code: 'prepared_call_mismatch' })
  assert.deepEqual(verifyPreparedCallToken(token, prepared, { ...listing, method: 'POST' }, 101), { ok: false, code: 'listing_contract_changed' })

  const [payload, mac] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
  assert.deepEqual(Object.keys(claims).sort(), ['call', 'exp', 'listing', 'v'])
  assert.equal(claims.exp, 700)
  assert.equal(JSON.stringify(claims).includes(API_ID), false)
  assert.equal(JSON.stringify(claims).includes(WALLET), false)
  assert.notEqual(mac, createHmac('sha256', Buffer.from(process.env.ENCRYPTION_KEY!, 'hex')).update(payload).digest('base64url'))

  const reordered = normalizePreparedCall({
    api_id: API_ID, buyer_wallet: WALLET,
    path_values: { z: 'last', a: 'first' }, query_values: { y: 2, b: true }, body: { a: 1 },
  }, true)
  const reorderedAgain = normalizePreparedCall({
    api_id: API_ID, buyer_wallet: WALLET,
    path_values: { a: 'first', z: 'last' }, query_values: { b: true, y: 2 }, body: { a: 1 },
  }, true)
  assert.deepEqual(reordered, reorderedAgain)
  assert.deepEqual(verifyPreparedCallToken(issuePreparedCallToken(reordered, listing, 100), reorderedAgain, listing, 101), { ok: true })
  assert.deepEqual(verifyPreparedCallToken(token, { ...prepared, api_id: '22222222-2222-4222-8222-222222222222' }, listing, 101), { ok: false, code: 'prepared_call_mismatch' })
})

test('prepared bodies are recursively canonicalized for byte-stable Stage A and Stage B requests', () => {
  const first = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, body: { z: 1, a: { y: 2, b: 3 } } }, true)
  const second = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, body: { a: { b: 3, y: 2 }, z: 1 } }, true)
  assert.deepEqual(first, second)
  const postListing = { ...listing, method: 'POST' as const, proxy_style: 'path' as const, request: { ...listing.request, outer_method: 'POST' as const, body: { ...listing.request.body, supported: true } } }
  assert.equal(buildProxyRequest(postListing, first, 'https://mahshar.xyz').init.body, buildProxyRequest(postListing, second, 'https://mahshar.xyz').init.body)
})

test('Stage B rejects changed path, query, body, and wallet before proxy execution', async () => {
  let paidCalls = 0
  const handler = handlerWith((_input, init) => {
    if (new Headers(init?.headers).has('payment-signature')) paidCalls += 1
    return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') } })
  })
  const base = { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }
  const probe = await call(handler, 'execute_api_call', base)
  const prepared_call_token = probe.result.structuredContent.prepared_call_token
  for (const changed of [
    { ...base, query_values: { city: 'Ankara' } },
    { ...base, path_values: { item: 'x' } },
    { ...base, body: { a: 2 } },
    { ...base, buyer_wallet: OTHER_WALLET },
  ]) {
    const response = await call(handler, 'execute_api_call', { ...changed, prepared_call_token, payment_signature: PAYMENT_SIGNATURE })
    assert.equal(response.result.structuredContent.error, 'prepared_call_mismatch')
  }
  assert.equal(paidCalls, 0)
})

test('proxy validation failures, malformed payment, rate limits, and signed transport ambiguity retain bounded distinctions', async () => {
  const cases: Array<[Response | Error, string]> = [
    [new Response(JSON.stringify({ error: 'invalid_dynamic_path' }), { status: 400 }), 'request_rejected'],
    [new Response(JSON.stringify({ error: 'invalid_payment' }), { status: 400 }), 'payment_rejected'],
    [new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'retry-after': '10' } }), 'rate_limited'],
  ]
  for (const [outcome, expected] of cases) {
    const handler = handlerWith(() => outcome instanceof Error ? Promise.reject(outcome) : outcome)
    if (expected === 'request_rejected') {
      const response = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: '../secret' } })
      assert.equal(response.result.structuredContent.status, expected)
      continue
    }
    const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }, false)
    const token = issuePreparedCallToken(prepared, listing)
    const response = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE })
    assert.equal(response.result.structuredContent.status, expected)
    if (expected === 'rate_limited') assert.equal(response.result.structuredContent.retry_after, '10')
  }
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }, false)
  const unknown = await call(handlerWith(() => Promise.reject(new Error('socket reset'))), 'execute_api_call', {
    api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: issuePreparedCallToken(prepared, listing), payment_signature: PAYMENT_SIGNATURE,
  })
  assert.equal(unknown.result.structuredContent.status, 'transport_outcome_unknown')
  assert.match(unknown.result.structuredContent.warning, /Do not create a fresh authorization/)
})

test('existing delivery finality and retryability states pass through without new retry rules', async () => {
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }, false)
  const token = issuePreparedCallToken(prepared, listing)
  for (const [delivery_state, retryable] of [['FAILED_RETRYABLE', true], ['FAILED_FINAL', false], ['UNKNOWN', false]] as const) {
    const settlement = { success: true, payer: WALLET, transaction: 'synthetic-tx', network: 'eip155:5042' }
    const handler = handlerWith(() => new Response(JSON.stringify({ error: 'existing_delivery_state', delivery_state, retryable, attemptId: 'attempt-1', purchase_access_token: PURCHASE_TOKEN }), {
      status: 503,
      headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settlement)).toString('base64') },
    }))
    const response = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE })
    assert.equal(response.result.structuredContent.status, 'paid_result')
    assert.equal(response.result.structuredContent.delivery_state, delivery_state)
    assert.equal(response.result.structuredContent.retryable, retryable)
  }

  const uncertain = handlerWith(() => new Response(JSON.stringify({ error: 'delivery_state_unavailable', delivery_state: 'UNKNOWN', retryable: false, attemptId: 'attempt-1' }), { status: 503 }))
  const response = await call(uncertain, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE })
  assert.equal(response.result.structuredContent.status, 'payment_state_error')

  for (const error of ['delivery_request_mismatch', 'settlement_acknowledgement_missing', 'accounting_incomplete']) {
    const handler = handlerWith(() => new Response(JSON.stringify({ error, delivery_state: 'UNKNOWN', retryable: false, attemptId: 'attempt-1' }), { status: 409 }))
    const mapped = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE })
    assert.equal(mapped.result.structuredContent.status, 'payment_state_error')
    assert.equal(mapped.result.structuredContent.result.error, error)
  }
})

test('a terminal credential-reflection block exposes only the generic paid delivery result', async () => {
  const credential = 'synthetic-seller-secret'
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET,
    query_values: { city: 'Istanbul' } }, false)
  const settlement = { success: true, payer: WALLET, transaction: 'synthetic-tx', network: 'eip155:5042' }
  const handler = handlerWith(() => new Response(JSON.stringify({
    response: { error: 'Upstream response blocked' }, payment: 'ACCOUNTING_COMPLETE',
    delivery_state: 'FAILED_FINAL', retryable: false, attemptId: 'attempt-1',
    purchase_access_token: PURCHASE_TOKEN,
  }), {
    status: 502,
    headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settlement)).toString('base64') },
  }))
  const response = await call(handler, 'execute_api_call', {
    api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' },
    prepared_call_token: issuePreparedCallToken(prepared, listing), payment_signature: PAYMENT_SIGNATURE,
  })
  assert.equal(response.result.structuredContent.status, 'paid_result')
  assert.equal(response.result.structuredContent.delivery_state, 'FAILED_FINAL')
  assert.deepEqual(response.result.structuredContent.proxy_result.response, { error: 'Upstream response blocked' })
  assert.equal(JSON.stringify(response).includes(credential), false)
})

test('buyer wallet remains a normalized hint while PAYMENT-RESPONSE payer stays authoritative', async () => {
  const mixedCaseWallet = `0x${'Aa'.repeat(20)}`
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: mixedCaseWallet, query_values: { city: 'Istanbul' } }, false)
  assert.equal(prepared.buyer_wallet, mixedCaseWallet.toLowerCase())
  const token = issuePreparedCallToken(prepared, listing)
  const settlement = { success: true, payer: OTHER_WALLET, transaction: 'synthetic-tx', network: 'eip155:5042' }
  const response = await call(handlerWith(() => new Response(JSON.stringify({ response: { ok: true }, delivery_state: 'SUCCEEDED' }), {
    status: 200,
    headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settlement)).toString('base64') },
  })), 'execute_api_call', {
    api_id: API_ID, buyer_wallet: mixedCaseWallet, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE,
  })
  assert.equal(response.result.structuredContent.status, 'paid_result')
  assert.equal(response.result.structuredContent.settlement.payer, OTHER_WALLET)
})

test('payment signatures are bounded and must accompany a prepared token', async () => {
  const handler = handlerWith(() => { throw new Error('must not fetch') })
  for (const args of [
    { payment_signature: PAYMENT_SIGNATURE },
    { prepared_call_token: 'a.b' },
    { payment_signature: '*' },
    { payment_signature: 'a'.repeat((32 * 1024) + 1) },
  ]) {
    const response = await call(handler, 'execute_api_call', { api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, ...args })
    assert.equal(response.result.isError, true)
  }
})

test('get_purchase_response uses only the capability header, never cookies, and maps access failures', async () => {
  for (const [status, expected] of [[200, 'paid_result'], [401, 'recovery_denied'], [403, 'recovery_denied'], [404, 'recovery_not_found']] as const) {
    const handler = handlerWith((input, init) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/calls/last-response')
      assert.equal(url.searchParams.get('api_id'), API_ID)
      assert.equal(url.searchParams.get('buyer_wallet'), WALLET)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-mahshar-purchase-access'), PURCHASE_TOKEN)
      assert.equal(headers.has('cookie'), false)
      return new Response(JSON.stringify(status === 200 ? { response_body: { ok: true }, purchase_access_token: PURCHASE_TOKEN } : { error: 'denied' }), { status })
    })
    const response = await call(handler, 'get_purchase_response', { api_id: API_ID, buyer_wallet: WALLET, purchase_access_token: PURCHASE_TOKEN })
    assert.equal(response.result.structuredContent.status, expected)
  }
})

test('get_purchase_response rejects malformed capability scope before transport', async () => {
  let fetches = 0
  const handler = handlerWith(() => { fetches += 1; return new Response('{}') })
  for (const args of [
    { api_id: 'invalid', buyer_wallet: WALLET, purchase_access_token: PURCHASE_TOKEN },
    { api_id: API_ID, buyer_wallet: '0x0', purchase_access_token: PURCHASE_TOKEN },
    { api_id: API_ID, buyer_wallet: WALLET, purchase_access_token: 'not-a-capability' },
    { api_id: API_ID, buyer_wallet: WALLET, purchase_access_token: PURCHASE_TOKEN, cookie: 'forbidden' },
  ]) {
    const response = await call(handler, 'get_purchase_response', args)
    assert.equal(response.result.isError, true)
  }
  assert.equal(fetches, 0)
})

test('oversized paid and recovery responses fail explicitly without truncation', async () => {
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }, false)
  const signed = await call(handlerWith(() => new Response('{}', { status: 200, headers: { 'content-length': '4200001' } })), 'execute_api_call', {
    api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: issuePreparedCallToken(prepared, listing), payment_signature: PAYMENT_SIGNATURE,
  })
  assert.equal(signed.result.structuredContent.status, 'mcp_response_too_large')
  const recovered = await call(handlerWith(() => new Response('{}', { status: 200, headers: { 'content-length': '4200001' } })), 'get_purchase_response', {
    api_id: API_ID, buyer_wallet: WALLET, purchase_access_token: PURCHASE_TOKEN,
  })
  assert.equal(recovered.result.structuredContent.status, 'mcp_response_too_large')
})

test('near-limit paid responses remain complete once while streamed over-limit responses fail explicitly', async () => {
  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }, false)
  const token = issuePreparedCallToken(prepared, listing)
  const settlement = { success: true, payer: WALLET, transaction: 'synthetic-tx', network: 'eip155:5042' }
  const nearMarker = 'N'.repeat(4_000_000)
  const near = await call(handlerWith(() => new Response(JSON.stringify({ response: nearMarker, delivery_state: 'SUCCEEDED', purchase_access_token: PURCHASE_TOKEN }), {
    status: 200,
    headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settlement)).toString('base64') },
  })), 'execute_api_call', {
    api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE,
  })
  assert.equal(near.result.structuredContent.status, 'paid_result')
  assert.equal(near.result.structuredContent.proxy_result.response.length, nearMarker.length)
  assert.equal(near.result.content[0].text.includes('NNNN'), false)

  const over = await call(handlerWith(() => new Response('X'.repeat(4_200_001), { status: 200 })), 'execute_api_call', {
    api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: token, payment_signature: PAYMENT_SIGNATURE,
  })
  assert.equal(over.result.structuredContent.status, 'mcp_response_too_large')
})

test('MCP Phase 2 imports are isolated and sensitive bearer values are never logged', async () => {
  const paths = ['server.ts', 'discovery-client.ts', 'prepared-call.ts', 'request-builder.ts', 'paid-client.ts']
  const sources = await Promise.all(paths.map(path => readFile(new URL(`../../src/lib/mcp/${path}`, import.meta.url), 'utf8')))
  const imports = sources.join('\n').split('\n').filter(line => /^import\s/.test(line)).join('\n').toLowerCase()
  for (const forbidden of ['supabase', '@/lib/proxy', 'gateway', 'settlement', 'payments/delivery', 'purchase-access', 'upstream-auth', 'withdraw', 'accounting', 'decrypt']) {
    assert.equal(imports.includes(forbidden), false, forbidden)
  }

  const prepared = normalizePreparedCall({ api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' } }, false)
  const preparedToken = issuePreparedCallToken(prepared, listing)
  const privateSentinels = [PAYMENT_SIGNATURE, preparedToken, PURCHASE_TOKEN, 'seller-credential-sentinel', 'private-endpoint-sentinel']
  const captured: string[] = []
  const original = console.error
  console.error = (...values: unknown[]) => { captured.push(values.map(String).join(' ')) }
  try {
    await call(handlerWith(() => Promise.reject(new Error(privateSentinels.join(' ')))), 'execute_api_call', {
      api_id: API_ID, buyer_wallet: WALLET, query_values: { city: 'Istanbul' }, prepared_call_token: preparedToken, payment_signature: PAYMENT_SIGNATURE,
    })
    await call(handlerWith(() => Promise.reject(new Error(`never log ${PAYMENT_SIGNATURE} ${PURCHASE_TOKEN}`))), 'get_purchase_response', {
      api_id: API_ID, buyer_wallet: WALLET, purchase_access_token: PURCHASE_TOKEN,
    })
  } finally { console.error = original }
  for (const sentinel of privateSentinels) assert.equal(captured.join('\n').includes(sentinel), false, sentinel)
})
