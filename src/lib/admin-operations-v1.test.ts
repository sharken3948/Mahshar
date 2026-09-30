import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../../tests/marketplace/fixtures'
import { boundary } from '../../tests/admin/fixture'
import { clearOperationsCacheForTests } from './admin/operations-cache'
import { arcChainIdFromRpc, gatewaySupportsArc, GATEWAY_CAPABILITIES_URL } from './admin/infrastructure-data'
import { ISSUE_EXPLANATIONS, isLegacyDeliveryInformational } from './admin/issues-data'
import * as payments from '../app/api/admin/operations/payments/route'
import * as purchases from '../app/api/admin/operations/purchases/route'
import * as purchaseDetail from '../app/api/admin/operations/purchases/[id]/route'
import * as infrastructure from '../app/api/admin/operations/infrastructure/route'
import * as systemHealth from '../app/api/admin/operations/system-health/route'
import * as issues from '../app/api/admin/operations/issues/route'

const listingId = '11111111-1111-4111-8111-111111111111'
const attemptId = '22222222-2222-4222-8222-222222222222'
const purchaseId = '33333333-3333-4333-8333-333333333333'
const callId = '44444444-4444-4444-8444-444444444444'
const withdrawalId = '55555555-5555-4555-8555-555555555555'
const invalidListingId = '77777777-7777-4777-8777-777777777777'
const legacyAttemptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const legacyPurchaseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const forbiddenFetch = async () => { throw new Error('Network forbidden in test') }

function unsigned(path: string) { return new NextRequest(origin + path) }
function authorized(path: string, account = alice) { return new NextRequest(origin + path, { headers: sessionHeaders(account) }) }

beforeEach(() => {
  reset(); clearOperationsCacheForTests(); boundary.actions = 0; boundary.unavailable = false; boundary.unavailableTable = null; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
  process.env.ARC_MAINNET_RPC_URL = 'https://fixed-rpc.example'
  process.env.GROQ_API_KEY = 'configured-test-value'
  process.env.PLATFORM_WALLET_ADDRESS = bob.address
  globalThis.fetch = forbiddenFetch as typeof fetch
  const listing = {
    id: listingId, name: '<img src=x onerror=alert(1)>', category: 'Data', price_per_call: '0.100000',
    seller_wallet: bob.address.toLowerCase(), is_active: true, verified_at: new Date().toISOString(), source: 'seller', score: 8,
    endpoint_url: 'https://api.example.test/v1', method: 'GET', auth_type: 'public', auth_param_name: null,
    encrypted_key: null, example_request: null, body_required: false, dynamic_path_supported: false,
    path_parameters: null, query_parameters: null, created_at: '2026-09-30T10:00:00.000Z',
  }
  state.tables.api_listings.push(listing)
  state.tables.api_listings.push({ ...listing, id: invalidListingId, name: 'Invalid contract', method: 'TRACE' })
  const attempt = {
    id: attemptId, api_id: listingId, state: 'SETTLEMENT_UNKNOWN', purchase_id: purchaseId,
    transaction_id: '0xabc123', reason: 'settlement_transport_uncertain', submitted_at: '2026-09-30T10:00:30.000Z',
    created_at: '2026-09-30T10:01:00.000Z', updated_at: '2026-09-30T10:02:00.000Z', delivery_state: 'UNKNOWN', delivery_http_status: 502,
    delivery_error_code: 'upstream_unavailable', api_listings: { id: listingId, name: listing.name },
    binding: { payer: alice.address.toLowerCase(), seller: bob.address.toLowerCase(), amount_atomic: '110000', seller_atomic: '90000', authorization: { signature: 'never-return' } },
    fingerprint: 'a'.repeat(64), authorization_key: 'b'.repeat(64), submission_token: 'never-return', delivery_token: 'never-return',
  }
  state.tables.x402_settlement_attempts.push(attempt)
  state.tables.x402_settlement_attempts.push({ ...attempt, id: '88888888-8888-4888-8888-888888888888', purchase_id: null,
    state: 'SETTLEMENT_SUBMITTED', delivery_state: 'FAILED_RETRYABLE', submitted_at: '2020-01-01T00:00:00.000Z', reason: null })
  state.tables.x402_settlement_attempts.push({ ...attempt, id: '99999999-9999-4999-8999-999999999999',
    state: 'ACCOUNTING_COMPLETE', delivery_state: 'FAILED_FINAL', reason: null })
  state.tables.x402_settlement_attempts.push({ ...attempt, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', purchase_id: null,
    state: 'MANUAL_REVIEW', delivery_state: 'NOT_STARTED', reason: 'settlement_acknowledgement_missing' })
  state.tables.x402_settlement_attempts.push({ ...attempt, id: legacyAttemptId, purchase_id: legacyPurchaseId,
    state: 'ACCOUNTING_COMPLETE', delivery_state: 'UNKNOWN', reason: null,
    delivery_request_hash: null, delivery_token: null, delivery_started_at: null, delivery_completed_at: null,
    delivery_http_status: null, delivery_error_code: null })
  state.tables.purchases.push({
    id: purchaseId, buyer_wallet: alice.address.toLowerCase(), api_id: listingId, amount_usdc: '0.110000', seller_share_usdc: '0.090000',
    settlement_attempt_id: attemptId, created_at: '2026-09-30T10:03:00.000Z', api_listings: { id: listingId, name: listing.name, seller_wallet: bob.address.toLowerCase() },
    x402_settlement_attempts: attempt,
  })
  state.tables.purchases.push({ id: '66666666-6666-4666-8666-666666666666', buyer_wallet: alice.address.toLowerCase(), api_id: listingId,
    amount_usdc: '0.100000', seller_share_usdc: null, settlement_attempt_id: null, created_at: '2026-09-29T10:03:00.000Z',
    api_listings: { id: listingId, name: listing.name, seller_wallet: bob.address.toLowerCase() } })
  state.tables.api_calls.push({ id: callId, purchase_id: purchaseId, success: false, latency_ms: 425, payment_type: 'pay-per-call',
    created_at: '2026-09-30T10:04:00.000Z', response_body: { secret: 'never-return' }, request_body: 'never-return',
    purchase_access_token: 'never-return', response_expires_at: '2026-09-29T10:04:00.000Z' })
  state.tables.seller_withdrawals.push({ id: withdrawalId, seller_wallet: bob.address.toLowerCase(), status: 'failed',
    created_at: '2026-09-30T09:00:00.000Z', updated_at: '2026-09-30T09:05:00.000Z', last_error: 'raw-secret-error-never-return', burn_intent: 'never-return' })
  state.tables.seller_withdrawals.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', seller_wallet: bob.address.toLowerCase(), status: 'submission_unknown', created_at: '2026-09-30T09:00:00.000Z' })
  state.tables.seller_withdrawals.push({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', seller_wallet: bob.address.toLowerCase(), status: 'mint_unknown', created_at: '2026-09-30T09:00:00.000Z' })
})

test('new operations routes require Admin authorization and expose GET only', async () => {
  for (const [route, path] of [[payments, '/api/admin/operations/payments'], [purchases, '/api/admin/operations/purchases'],
    [infrastructure, '/api/admin/operations/infrastructure'], [systemHealth, '/api/admin/operations/system-health'], [issues, '/api/admin/operations/issues']] as const) {
    assert.equal((await route.GET(unsigned(path))).status, 401)
    assert.equal((await route.GET(authorized(path, bob))).status, 403)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(method in route, false)
  }
})

test('payments parse binding server-side into bounded sanitized DTOs', async () => {
  const response = await payments.GET(authorized('/api/admin/operations/payments'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.limit, 25)
  assert.equal(body.payments[0].payer.includes(alice.address.toLowerCase()), false)
  assert.equal(body.payments[0].seller.includes(bob.address.toLowerCase()), false)
  assert.equal(body.payments[0].buyer_charge_usdc, '0.110000')
  assert.equal(body.payments[0].seller_share_usdc, '0.090000')
  assert.equal(body.payments[0].settlement_state, 'SETTLEMENT_UNKNOWN')
  const serialized = JSON.stringify(body)
  for (const forbidden of ['binding', 'signature', 'fingerprint', 'authorization_key', 'submission_token', 'delivery_token', 'never-return']) assert.equal(serialized.includes(forbidden), false, forbidden)
  assert.equal((await payments.GET(authorized('/api/admin/operations/payments?limit=50'))).status, 200)
  assert.equal((await payments.GET(authorized('/api/admin/operations/payments?limit=51'))).status, 400)
})

test('purchases preserve historical unlinked state and load safe call detail on demand', async () => {
  const listResponse = await purchases.GET(authorized('/api/admin/operations/purchases'))
  assert.equal(listResponse.status, 200)
  const list = await listResponse.json()
  assert.equal(list.limit, 25)
  assert.equal(list.purchases.find((row: { id: string }) => row.id === purchaseId).historical_unlinked, false)
  assert.equal(list.purchases.find((row: { historical_unlinked: boolean }) => row.historical_unlinked).seller_share_usdc, null)
  const detailResponse = await purchaseDetail.GET(authorized(`/api/admin/operations/purchases/${purchaseId}`), { params: Promise.resolve({ id: purchaseId }) })
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  assert.equal(detail.api_calls.length, 1)
  assert.deepEqual(Object.keys(detail.api_calls[0]).sort(), ['created_at', 'id', 'latency_ms', 'payment_type', 'success'])
  const serialized = JSON.stringify(detail)
  for (const forbidden of ['response_body', 'request_body', 'purchase_access_token', 'never-return', 'endpoint_url']) assert.equal(serialized.includes(forbidden), false, forbidden)
  assert.equal((await purchases.GET(authorized('/api/admin/operations/purchases?limit=51'))).status, 400)
})

test('infrastructure uses fixed read-only probes and validates Arc 5042 plus Gateway support', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init })
    if (url === process.env.ARC_MAINNET_RPC_URL) return new Response(JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: '0x13b2' }, { jsonrpc: '2.0', id: 2, result: '0x2a' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === GATEWAY_CAPABILITIES_URL) return new Response(JSON.stringify({ kinds: [{ network: 'eip155:5042' }], extensions: [], signers: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    throw new Error('unexpected destination')
  }) as typeof fetch
  const response = await infrastructure.GET(authorized('/api/admin/operations/infrastructure?url=https://evil.example'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.signals.find((item: { id: string }) => item.id === 'arc-rpc').state, 'ready')
  assert.equal(body.signals.find((item: { id: string }) => item.id === 'circle-gateway').state, 'ready')
  assert.equal(arcChainIdFromRpc([{ id: 1, result: '0x13b2' }]), 5042)
  assert.equal(gatewaySupportsArc({ kinds: [{ network: 'eip155:5042' }] }), true)
  assert.deepEqual(calls.map(call => call.url).sort(), ['https://fixed-rpc.example', GATEWAY_CAPABILITIES_URL].sort())
  assert.equal(calls.find(call => call.url === GATEWAY_CAPABILITIES_URL)?.init?.method, 'GET')
  const gatewayHeaders = calls.find(call => call.url === GATEWAY_CAPABILITIES_URL)?.init?.headers as Record<string, string>
  assert.equal(gatewayHeaders['X-ARC-PRIVATE-MAINNET-ENABLED'], 'true')
  const source = readFileSync('src/lib/admin/infrastructure-data.ts', 'utf8')
  assert.doesNotMatch(source, /\.settle\(|\.verify\(|\.pay\(|groq\(|mahshar_take_rate_limit/)
})

test('system health reports configured facts without inventing maintenance success', async () => {
  const response = await systemHealth.GET(authorized('/api/admin/operations/system-health'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.response_retention_days, 7)
  assert.equal(body.signals.find((item: { id: string }) => item.id === 'x402-storage').state, 'ready')
  assert.equal(body.signals.find((item: { id: string }) => item.id === 'chain-config').metadata, 'eip155:5042')
  assert.doesNotMatch(JSON.stringify(body), /last maintenance succeeded/i)
  assert.match(JSON.stringify(body), /does not prove maintenance ran/i)
})

test('issues use current durable taxonomy, templates, masked wallets, and no raw errors', async () => {
  const response = await issues.GET(authorized('/api/admin/operations/issues?limit=50'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.taxonomy, 'current_durable_v1')
  assert.equal(body.complete, true)
  assert.ok(body.sources.every((source: { state: string }) => source.state === 'ready'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'SETTLEMENT_UNKNOWN'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'DELIVERY_UNKNOWN'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'WITHDRAWAL_FAILED'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'MANUAL_REVIEW'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'STALE_SETTLEMENT_SUBMITTED'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'FAILED_RETRYABLE'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'FAILED_FINAL'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'WITHDRAWAL_SUBMISSION_UNKNOWN'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'WITHDRAWAL_MINT_UNKNOWN'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'INVALID_LISTING_REQUEST_CONTRACT'))
  assert.ok(body.issues.every((item: { explanation: string }) => Object.values(ISSUE_EXPLANATIONS).includes(item.explanation as never)))
  assert.deepEqual(body.counts, {
    needs_attention_entities: 8,
    needs_attention_conditions: 10,
    informational_conditions: 1,
    all_conditions: 11,
  })
  const unresolved = body.issues.filter((item: { entity_id: string }) => item.entity_id === attemptId)
  assert.equal(unresolved.length, 2)
  assert.ok(unresolved.every((item: { presentation: string }) => item.presentation === 'needs_attention'))
  const legacy = body.issues.find((item: { entity_id: string }) => item.entity_id === legacyAttemptId)
  assert.equal(legacy.presentation, 'informational')
  assert.equal(legacy.severity, 'informational')
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes('raw-secret-error-never-return'), false)
  assert.equal(serialized.includes(alice.address.toLowerCase()), false)
  assert.equal(serialized.includes('burn_intent'), false)
})

test('legacy delivery classification requires accounting, purchase linkage, and every null signature field', () => {
  const signature = {
    state: 'ACCOUNTING_COMPLETE', delivery_state: 'UNKNOWN', purchase_id: legacyPurchaseId,
    delivery_request_hash: null, delivery_token: null, delivery_started_at: null, delivery_completed_at: null,
    delivery_http_status: null, delivery_error_code: null,
  }
  assert.equal(isLegacyDeliveryInformational(signature), true)
  assert.equal(isLegacyDeliveryInformational({ ...signature, state: 'SETTLEMENT_UNKNOWN' }), false)
  assert.equal(isLegacyDeliveryInformational({ ...signature, purchase_id: null }), false)
  assert.equal(isLegacyDeliveryInformational({ ...signature, delivery_started_at: '2026-09-30T10:00:00.000Z' }), false)
  assert.equal(isLegacyDeliveryInformational({ ...signature, delivery_error_code: 'delivery_worker_interrupted' }), false)
  const classifier = isLegacyDeliveryInformational.toString()
  for (const forbidden of ['name', 'wallet', 'created_at', 'updated_at']) assert.equal(classifier.includes(forbidden), false)
})

test('issues support limits 1 and 25 while preserving the full current count', async () => {
  const source = readFileSync('src/lib/admin/issues-data.ts', 'utf8')
  assert.match(source, /seller_withdrawals'\)\.select\('id, seller_wallet, status, created_at'\)/)
  assert.doesNotMatch(source, /seller_withdrawals'\)\.select\([^)]*updated_at/)
  const oneResponse = await issues.GET(authorized('/api/admin/operations/issues?limit=1'))
  assert.equal(oneResponse.status, 200)
  const one = await oneResponse.json()
  assert.equal(one.issues.length, 1)
  assert.ok(one.count > one.issues.length)
  const twentyFiveResponse = await issues.GET(authorized('/api/admin/operations/issues?limit=25'))
  assert.equal(twentyFiveResponse.status, 200)
  const twentyFive = await twentyFiveResponse.json()
  assert.equal(twentyFive.count, one.count)
  assert.equal(twentyFive.issues.length, Math.min(25, one.count))
  const withdrawal = twentyFive.issues.find((item: { type: string }) => item.type === 'WITHDRAWAL_FAILED')
  assert.equal(withdrawal.updated_at, '2026-09-30T09:00:00.000Z')
})

test('one unavailable issue source returns an explicit partial feed without hiding healthy sources', async () => {
  boundary.unavailableTable = 'seller_withdrawals'
  const response = await issues.GET(authorized('/api/admin/operations/issues?limit=25'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.complete, false)
  assert.deepEqual(body.sources.find((source: { id: string }) => source.id === 'withdrawals'), {
    id: 'withdrawals', label: 'Withdrawals', state: 'unavailable',
  })
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'SETTLEMENT_UNKNOWN'))
  assert.ok(body.issues.some((item: { type: string }) => item.type === 'INVALID_LISTING_REQUEST_CONTRACT'))
  assert.equal(JSON.stringify(body).includes('fixture unavailable'), false)
})

test('new Admin UI uses safe text rendering, on-demand detail, visible-only issue polling, and FUTURE stays inert', () => {
  const files = [
    'src/app/admin/operations/payments/payments-client.tsx', 'src/app/admin/operations/purchases/purchases-client.tsx',
    'src/app/admin/operations/issues/issues-client.tsx', 'src/app/admin/operations/signal-page-client.tsx',
  ].map(path => readFileSync(path, 'utf8')).join('\n')
  assert.doesNotMatch(files, /dangerouslySetInnerHTML/)
  assert.match(readFileSync('src/app/admin/operations/purchases/purchases-client.tsx', 'utf8'), /openDetail/)
  const shell = readFileSync('src/app/admin/operations/operations-shell.tsx', 'utf8')
  assert.match(shell, /document\.visibilityState === 'visible'/)
  assert.match(shell, /60_000/)
  assert.match(readFileSync('src/app/admin/operations/issues/issues-client.tsx', 'utf8'), /Partial issue coverage/)
  assert.match(shell, /Need review/)
  const issueClient = readFileSync('src/app/admin/operations/issues/issues-client.tsx', 'utf8')
  for (const label of ['Needs Attention', 'Informational', 'All Durable Conditions']) assert.match(issueClient, new RegExp(label))
  for (const future of ['Earnings', 'Logs & Events', 'Analytics']) assert.match(shell, new RegExp(`label: '${future.replace(/[&]/g, '\\&')}'[^\n]+(?!href)`))
})
