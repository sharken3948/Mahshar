import assert from 'node:assert/strict'
import test from 'node:test'
import { createPaidClient } from '../../src/lib/mcp/paid-client'
import type { AgentListing } from '../../src/lib/mcp/discovery-client'
import { issuePreparedCallToken } from '../../src/lib/mcp/prepared-call'
import { buildProxyRequest, normalizePreparedCall } from '../../src/lib/mcp/request-builder'
import { agentExecutionContract } from '../../src/lib/marketplace/agent-contract'
import contracts from './published-contracts.fixture.json'

process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
const wallet = `0x${'11'.repeat(20)}`
const signature = Buffer.from('{"synthetic":"never-a-real-payment"}').toString('base64')
const capability = 'synthetic-capability.signature'
const settlement = { success: true, payer: wallet, transaction: 'synthetic-acknowledgement', network: 'eip155:5042' }
const acknowledgement = Buffer.from(JSON.stringify(settlement)).toString('base64')
function listing(row = contracts.apis[0]): AgentListing {
  const execution = agentExecutionContract(row)
  return {
    ...execution, id: row.id, name: row.name, description: 'Public contract fixture; no provider execution', category: 'test',
    price_per_call_usdc: row.price_per_call, payment_model: 'x402-pay-per-call',
    auth: { type: row.auth_type, injected_by: row.auth_type === 'public' ? 'none' : 'mahshar',
      credential_location: row.auth_type === 'bearer' ? 'header Authorization: Bearer' : null, seller_credentials_exposed: false },
    auth_type: row.auth_type, score: null, verified: true, example_request: null, example_response: null,
    total_calls: 0, success_rate: null, avg_latency_ms: null,
  } as AgentListing
}
const api = listing()
const prepared = normalizePreparedCall({ api_id: api.id, buyer_wallet: wallet, body: { input: true } }, true)
const signedInput = () => ({ prepared_call_token: issuePreparedCallToken(prepared, api), payment_signature: signature })
function interrupted(headers: HeadersInit = {}, status = 200) {
  let reads = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"response":"PARTIAL_PRIVATE_SENTINEL'))
      else controller.error(new Error(`PRIVATE_ERROR_SENTINEL ${signature} ${capability}`))
    },
  }), { status, headers })
}

test('interrupted signed bodies preserve only validated payment acknowledgement without partial data or retry execution', async () => {
  for (const header of [undefined, acknowledgement, 'bad-header', Buffer.from('{"success":false}').toString('base64'), 'X'.repeat(16 * 1024 + 1)]) {
    let calls = 0
    const client = createPaidClient({ origin: 'https://mahshar.xyz', fetcher: async () => {
      calls++
      return interrupted(header ? { 'payment-response': header } : {})
    } })
    const result = await client.execute(api, prepared, signedInput())
    assert.equal(result.status, 'transport_outcome_unknown')
    assert.equal(calls, 1)
    const record = result as Record<string, unknown>
    assert.equal(record.http_status, 200)
    assert.match(String(record.warning), /Do not create a fresh authorization or automatically repeat execution/)
    assert.equal('proxy_result' in record, false)
    assert.equal('delivery_state' in record, false)
    assert.equal('retryable' in record, false)
    assert.equal('purchase_access_token' in record, false)
    assert.equal('payment_response' in record, header === acknowledgement)
    if (header === acknowledgement) assert.deepEqual(record.settlement, settlement)
    for (const value of ['PARTIAL_PRIVATE_SENTINEL', 'PRIVATE_ERROR_SENTINEL', signature, capability]) {
      assert.equal(JSON.stringify(result).includes(value), false)
    }
  }
})

test('interrupted unsigned challenge reads return a bounded rejection and never request a signature', async () => {
  let calls = 0
  const result = await createPaidClient({ origin: 'https://mahshar.xyz', fetcher: async (_target, init) => {
    calls++
    assert.equal(new Headers(init?.headers).has('payment-signature'), false)
    return interrupted({}, 402)
  } }).execute(api, prepared, {})
  assert.deepEqual(result, { status: 'request_rejected', http_status: 402, error: 'proxy_response_interrupted' })
  assert.equal(calls, 1)
})

test('interrupted recovery can be repeated on a fresh client with only the original read capability', async () => {
  let calls = 0
  const fetcher: typeof fetch = async (target, init) => {
    calls++
    assert.equal(new URL(String(target)).pathname, '/api/calls/last-response')
    assert.equal(init?.method, 'GET')
    assert.deepEqual([...new Headers(init?.headers)], [['x-mahshar-purchase-access', capability]])
    return calls === 1 ? interrupted({ 'payment-response': acknowledgement }) : Response.json({ response_body: { complete: true }, purchase_access_token: capability })
  }
  const input = { api_id: api.id, buyer_wallet: wallet, purchase_access_token: capability }
  const failed = await createPaidClient({ origin: 'https://mahshar.xyz', fetcher }).recover(input)
  assert.equal(failed.status, 'request_rejected')
  assert.equal((failed as Record<string, unknown>).error, 'purchase_response_interrupted')
  assert.match(String((failed as Record<string, unknown>).warning), /Retry only get_purchase_response/)
  for (const key of ['recovery_result', 'payment_response', 'settlement', 'retryable']) assert.equal(key in failed, false)
  assert.equal(JSON.stringify(failed).includes('SENTINEL'), false)
  const recovered = await createPaidClient({ origin: 'https://mahshar.xyz', fetcher }).recover(input)
  assert.equal(recovered.status, 'paid_result')
  assert.deepEqual((recovered as { recovery_result: unknown }).recovery_result, { response_body: { complete: true }, purchase_access_token: capability })
  assert.equal(calls, 2)
})

test('complete legacy paid and recovered payload formats remain exact, including null recovery', async () => {
  const paid = { response: { complete: true }, payment: 'ACCOUNTING_COMPLETE', delivery_state: 'SUCCEEDED', retryable: false,
    attemptId: 'attempt', purchaseId: 'purchase', purchase_access_token: capability, retrieve_response: '/api/calls/last-response' }
  const client = createPaidClient({ origin: 'https://mahshar.xyz', fetcher: async () => Response.json(paid, { headers: { 'payment-response': acknowledgement } }) })
  assert.deepEqual(await client.execute(api, prepared, signedInput()), {
    status: 'paid_result', http_status: 200, payment_response: acknowledgement, settlement,
    delivery_state: 'SUCCEEDED', retryable: false, attempt_id: 'attempt', purchase_id: 'purchase', purchase_access_token: capability,
    retrieve_response: '/api/calls/last-response', proxy_result: paid,
  })
  for (const response_body of [null, false, 0, '', { historical: true }]) {
    const body = { response_body, purchase_access_token: capability }
    const recovery = createPaidClient({ origin: 'https://mahshar.xyz', fetcher: async () => Response.json(body) })
    assert.deepEqual(await recovery.recover({ api_id: api.id, buyer_wallet: wallet, purchase_access_token: capability }), {
      status: 'paid_result', http_status: 200, purchase_access_token: capability, recovery_result: body,
    })
  }
})

test('all five published contracts retain request transport, signatures and successful response formats', async () => {
  assert.equal(contracts.apis.length, 5)
  for (const row of contracts.apis) {
    const current = listing(row)
    const query = row.method === 'GET' ? { limit: 1, sort: 'volume24h', graduated: false, q: 'fixture' } : undefined
    const call = normalizePreparedCall({ api_id: row.id, buyer_wallet: wallet,
      ...(row.method === 'POST' ? { body: { synthetic: true } } : { query_values: query }) }, row.method === 'POST')
    const unsignedRequest = buildProxyRequest(current, call, 'https://mahshar.xyz')
    assert.equal(unsignedRequest.init.method, row.method, row.name)
    assert.equal(unsignedRequest.url.pathname, `/api/proxy/${row.id}`)
    assert.equal(unsignedRequest.init.body, row.method === 'POST' ? JSON.stringify({ synthetic: true }) : undefined)
    if (query) assert.deepEqual(Object.fromEntries(unsignedRequest.url.searchParams), { graduated: 'false', limit: '1', q: 'fixture', sort: 'volume24h' })
    const paidBody = { response: { listing: row.name }, delivery_state: 'SUCCEEDED', retryable: false, purchase_access_token: capability }
    let calls = 0
    const client = createPaidClient({ origin: 'https://mahshar.xyz', fetcher: async (target, init) => {
      calls++
      assert.equal(String(target), unsignedRequest.url.toString())
      assert.equal(init?.method, unsignedRequest.init.method)
      assert.equal(init?.body, unsignedRequest.init.body)
      assert.equal(new Headers(init?.headers).get('payment-signature'), signature)
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return Response.json(paidBody, { headers: { 'payment-response': acknowledgement } })
    } })
    const result = await client.execute(current, call, { prepared_call_token: issuePreparedCallToken(call, current), payment_signature: signature })
    assert.equal(result.status, 'paid_result', row.name)
    assert.deepEqual((result as { proxy_result: unknown }).proxy_result, paidBody)
    assert.equal(calls, 1)
  }
})
