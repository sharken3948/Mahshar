import './transactions-register.mjs'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state, createServiceClient } from '../marketplace/fixtures'
import {
  arcTransaction,
  earningTransaction,
  getWalletTransactions,
  purchaseTransaction,
  sortTransactionRecords,
  transactionQuery,
  withdrawalTransaction,
  type TransactionHistory,
  type TransactionRecord,
} from '../../src/lib/dashboard-transactions'
import { TransactionHistoryContent } from '../../src/app/dashboard/transactions/transactions-content'
import * as route from '../../src/app/api/dashboard/transactions/route'

const listingA = '11111111-1111-4111-8111-111111111111'
const listingB = '22222222-2222-4222-8222-222222222222'
const purchaseA = '33333333-3333-4333-8333-333333333333'
const purchaseB = '44444444-4444-4444-8444-444444444444'
const attemptA = '55555555-5555-4555-8555-555555555555'
const withdrawalA = '66666666-6666-4666-8666-666666666666'
const withdrawalB = '77777777-7777-4777-8777-777777777777'
const txHash = `0x${'ab'.repeat(32)}`

function listing(id: string, seller: string, name: string) {
  return { id, seller_wallet: seller.toLowerCase(), name }
}

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    id: purchaseA,
    buyer_wallet: alice.address.toLowerCase(),
    api_id: listingB,
    amount_usdc: '0.11',
    seller_share_usdc: '0.099',
    tx_hash: `circle:eip155:5042:facilitator-123:${'c'.repeat(64)}`,
    settlement_attempt_id: attemptA,
    created_at: '2026-10-04T12:00:00.000Z',
    api_listings: { name: 'Ioscope Wallet Risk Scoring' },
    ...overrides,
  }
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: attemptA,
    state: 'ACCOUNTING_COMPLETE',
    transaction_id: txHash,
    settlement_identity: `circle:eip155:5042:${txHash}:${'c'.repeat(64)}`,
    delivery_state: 'FAILED_FINAL',
    delivery_http_status: 404,
    ...overrides,
  }
}

function history(records: TransactionRecord[], degradedSources: TransactionHistory['degradedSources'] = []): TransactionHistory {
  return {
    records, page: 1, limit: 25, maxPage: 10, maxAccessibleRecords: 250, hasMore: false,
    degradedSources, limitations: [], asOf: '2026-10-04T13:00:00.000Z',
    summary: {
      visibleCount: records.length,
      visibleSpentUsdc: records.some(record => record.type === 'api_purchase') ? '0.11' : null,
      visibleEarnedUsdc: records.some(record => record.type === 'seller_earning') ? '0.099' : null,
      lastActivity: records[0] ? { type: records[0].type, occurredAt: records[0].occurredAt } : null,
    },
  }
}

function clientWithUnavailableTables(...names: string[]) {
  const unavailable = new Set(names)
  const base = createServiceClient()
  return {
    from(name: string) {
      if (!unavailable.has(name)) return base.from(name)
      const chain: Record<string, unknown> & PromiseLike<{ data: null; error: { message: string } }> = {
        then(resolve) { return Promise.resolve({ data: null, error: { message: `${name} unavailable` } }).then(resolve) },
      }
      for (const method of ['select', 'eq', 'ilike', 'in', 'not', 'order', 'limit']) chain[method] = () => chain
      return chain
    },
  }
}

function pagedPurchaseId(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function render(content: Partial<React.ComponentProps<typeof TransactionHistoryContent>> = {}) {
  return renderToStaticMarkup(React.createElement(TransactionHistoryContent, {
    history: history([]), loading: false, error: null, filter: 'all', selected: null, copied: false,
    onFilter() {}, onRefresh() {}, onRetry() {}, onPrevious() {}, onNext() {}, onSelect() {}, onClose() {}, onCopy() {},
    ...content,
  }))
}

beforeEach(() => {
  reset()
  state.tables.api_listings.push(
    listing(listingA, alice.address, 'Alice Seller API'),
    listing(listingB, bob.address, 'Ioscope Wallet Risk Scoring'),
  )
})

test('transaction identifier classification only links canonical 32-byte EVM hashes', () => {
  assert.equal(arcTransaction(txHash)?.explorerUrl, `https://explorer.arc.io/tx/${txHash}`)
  for (const invalid of ['facilitator-123', `0X${'ab'.repeat(32)}`, `0x${'ab'.repeat(31)}`, `0x${'zz'.repeat(32)}`, 'circle:eip155:5042:reference']) {
    assert.equal(arcTransaction(invalid), undefined)
  }
  const facilitator = purchaseTransaction(purchase(), attempt({ transaction_id: 'facilitator-123' }))!
  assert.equal(facilitator.onchainTransaction, undefined)
  assert.match(facilitator.settlementReference ?? '', /^circle:/)
  assert.equal(facilitator.settlementReferenceLabel, 'Settlement Reference')
})

test('purchase keeps settled payment and failed delivery as independent dimensions', () => {
  const record = purchaseTransaction(purchase(), attempt())!
  assert.equal(record.amountUsdc, '0.11')
  assert.equal(record.apiName, 'Ioscope Wallet Risk Scoring')
  assert.equal(record.occurredAt, '2026-10-04T12:00:00.000Z')
  assert.equal(record.paymentStatus, 'Settled')
  assert.equal(record.deliveryStatus, 'Failed')
  assert.equal(record.deliveryHttpStatus, 404)
  assert.equal(record.onchainTransaction?.hash, txHash)
  assert.equal(record.purchaseId, purchaseA)
})

test('seller earnings use exact credited share and do not invent historical null shares', () => {
  const record = earningTransaction(purchase(), attempt())!
  assert.equal(record.amountUsdc, '0.099')
  assert.equal(record.grossAmountUsdc, '0.11')
  assert.equal(record.platformShareUsdc, '0.011')
  assert.equal(record.status, 'Accounted')
  assert.equal(earningTransaction(purchase())?.status, 'Accounted')
  assert.equal(earningTransaction(purchase({ seller_share_usdc: null }), attempt()), null)
})

test('withdrawals distinguish completed and pending records and validate mint hashes', () => {
  const completed = withdrawalTransaction({ id: withdrawalA, amount_usdc: '12', net_amount_usdc: '11.99', status: 'minted', mint_tx_hash: txHash, created_at: '2026-10-02T10:00:00Z', minted_at: '2026-10-02T10:02:00Z' })!
  assert.equal(completed.status, 'Completed')
  assert.equal(completed.amountDirection, 'outflow')
  assert.equal(completed.netAmountUsdc, '11.99')
  assert.equal(completed.onchainTransaction?.hash, txHash)
  const pending = withdrawalTransaction({ id: randomUUID(), amount_usdc: '1', net_amount_usdc: '0.99', status: 'pending_mint', mint_tx_hash: null, gateway_transfer_id: 'gateway-transfer-reference', created_at: '2026-10-03T10:00:00Z' })!
  assert.equal(pending.status, 'Pending')
  assert.equal(pending.amountDirection, 'neutral')
  assert.equal(pending.netAmountUsdc, '0.99')
  assert.equal(pending.onchainTransaction, undefined)
  assert.equal(pending.settlementReferenceLabel, 'Withdrawal Reference')

  const expired = withdrawalTransaction({ id: randomUUID(), amount_usdc: '3', net_amount_usdc: '2.99', status: 'expired', created_at: '2026-10-03T09:00:00Z' })!
  assert.equal(expired.status, 'Expired')
  assert.equal(expired.amountDirection, 'neutral')
})

test('wallet session boundary prevents wallet override and isolates buyer, seller, and withdrawal rows', async () => {
  state.tables.purchases.push(
    purchase(),
    purchase({ id: purchaseB, buyer_wallet: bob.address.toLowerCase(), api_id: listingA, api_listings: { name: 'Alice Seller API' }, settlement_attempt_id: null, tx_hash: 'payment-b' }),
  )
  state.tables.x402_settlement_attempts.push(attempt())
  state.tables.seller_withdrawals.push({ id: withdrawalA, seller_wallet: alice.address.toLowerCase(), amount_usdc: '2', net_amount_usdc: '1.99', status: 'pending_mint', created_at: '2026-10-05T10:00:00Z' })
  state.tables.seller_withdrawals.push({ id: withdrawalB, seller_wallet: bob.address.toLowerCase(), amount_usdc: '8', net_amount_usdc: '7.99', status: 'minted', created_at: '2026-10-05T11:00:00Z' })
  const request = new NextRequest(`${origin}/api/dashboard/transactions?wallet=${bob.address}`, { headers: sessionHeaders(alice) })
  const response = await route.GET(request)
  assert.equal(response.status, 200)
  const body = await response.json() as TransactionHistory
  assert.deepEqual(new Set(body.records.map(record => record.id)), new Set([
    `purchase:${purchaseA}`,
    `earning:${purchaseB}`,
    `withdrawal:${withdrawalA}`,
  ]))
  assert.equal(body.records.some(record => record.id === `purchase:${purchaseB}`), false)
  assert.equal(body.records.some(record => record.id === `earning:${purchaseA}`), false)
  assert.equal(body.records.some(record => record.id === `withdrawal:${withdrawalB}`), false)
  assert.doesNotMatch(JSON.stringify(body), /buyer_wallet|seller_wallet|burn_intent|attestation|authorization|session_token/)
  assert.equal((await route.GET(new NextRequest(`${origin}/api/dashboard/transactions`))).status, 401)
})

test('same purchase is represented once per wallet role without double-counting a seller total', async () => {
  state.tables.purchases.push(purchase({ api_id: listingA, api_listings: { name: 'Alice Seller API' } }))
  state.tables.x402_settlement_attempts.push(attempt())
  const result = await getWalletTransactions(alice.address, { filter: 'all', limit: 25, page: 1 }, createServiceClient() as never)
  assert.equal(result.records.filter(record => record.type === 'api_purchase').length, 1)
  assert.equal(result.records.filter(record => record.type === 'seller_earning').length, 1)
  assert.equal(result.summary.visibleSpentUsdc, '0.11')
  assert.equal(result.summary.visibleEarnedUsdc, '0.099')
})

test('multiple settlement attempts cannot duplicate a purchase or its seller earning', async () => {
  const secondAttempt = '88888888-8888-4888-8888-888888888888'
  state.tables.purchases.push(purchase({ api_id: listingA, api_listings: { name: 'Alice Seller API' } }))
  state.tables.x402_settlement_attempts.push(attempt(), attempt({ id: secondAttempt, transaction_id: `0x${'cd'.repeat(32)}` }))
  const result = await getWalletTransactions(alice.address, { filter: 'all', limit: 25, page: 1 }, createServiceClient() as never)
  assert.equal(result.records.filter(record => record.id === `purchase:${purchaseA}`).length, 1)
  assert.equal(result.records.filter(record => record.id === `earning:${purchaseA}`).length, 1)
  assert.equal(result.summary.visibleSpentUsdc, '0.11')
  assert.equal(result.summary.visibleEarnedUsdc, '0.099')
})

test('ordering is newest-first with a stable ID tie-break and pagination is bounded', () => {
  const base = purchaseTransaction(purchase(), attempt())!
  const records = sortTransactionRecords([
    { ...base, id: 'purchase:a', occurredAt: '2026-10-04T12:00:00.000Z' },
    { ...base, id: 'purchase:b', occurredAt: '2026-10-04T12:00:00.000Z' },
    { ...base, id: 'purchase:c', occurredAt: '2026-10-05T12:00:00.000Z' },
  ])
  assert.deepEqual(records.map(record => record.id), ['purchase:c', 'purchase:b', 'purchase:a'])
  assert.deepEqual(transactionQuery(new URLSearchParams('limit=500&page=999&filter=withdrawals')), { filter: 'withdrawals', limit: 50, page: 10 })
  assert.deepEqual(transactionQuery(new URLSearchParams('limit=bad&page=bad&filter=invalid')), { filter: 'all', limit: 25, page: 1 })
})

test('bounded pagination uses both order keys and stops at page 10 even with more than 500 source records', async () => {
  for (let index = 0; index < 501; index += 1) {
    state.tables.purchases.push(purchase({
      id: pagedPurchaseId(index),
      settlement_attempt_id: null,
      created_at: '2026-10-04T12:00:00.000Z',
    }))
  }
  const ninth = await getWalletTransactions(alice.address, { filter: 'purchases', limit: 50, page: 9 }, createServiceClient() as never)
  const tenth = await getWalletTransactions(alice.address, { filter: 'purchases', limit: 50, page: 10 }, createServiceClient() as never)
  assert.equal(ninth.records.length, 50)
  assert.equal(ninth.hasMore, true)
  assert.equal(tenth.records.length, 50)
  assert.equal(tenth.hasMore, false)
  assert.equal(tenth.page, 10)
  assert.equal(tenth.maxPage, 10)
  assert.equal(tenth.maxAccessibleRecords, 500)
  assert.equal(new Set([...ninth.records, ...tenth.records].map(record => record.id)).size, 100)
  const expected = Array.from({ length: 501 }, (_, index) => `purchase:${pagedPurchaseId(index)}`).sort().reverse()
  assert.deepEqual(ninth.records.map(record => record.id), expected.slice(400, 450))
  assert.deepEqual(tenth.records.map(record => record.id), expected.slice(450, 500))

  const request = new NextRequest(`${origin}/api/dashboard/transactions?filter=purchases&limit=50&page=11`, { headers: sessionHeaders(alice) })
  const body = await (await route.GET(request)).json() as TransactionHistory
  assert.equal(body.page, 10)
  assert.equal(body.maxPage, 10)
  assert.equal(body.hasMore, false)
  const html = render({ history: body })
  assert.match(html, /Page 10 of 10/)
  assert.match(html, /<button type="button" disabled="">Next<\/button>/)
})

test('a failed source returns available partial history and marks degradation instead of zeroing it', async () => {
  state.tables.purchases.push(purchase())
  const base = createServiceClient()
  const unavailable = {
    from(name: string) {
      if (name !== 'seller_withdrawals') return base.from(name)
      const chain: Record<string, unknown> & PromiseLike<{ data: null; error: { message: string } }> = {
        then(resolve) { return Promise.resolve({ data: null, error: { message: 'withdrawals unavailable' } }).then(resolve) },
      }
      for (const method of ['select', 'ilike', 'order', 'limit']) chain[method] = () => chain
      return chain
    },
  }
  const result = await getWalletTransactions(alice.address, { filter: 'all', limit: 25, page: 1 }, unavailable as never)
  assert.equal(result.records.some(record => record.type === 'api_purchase'), true)
  assert.deepEqual(result.degradedSources, ['withdrawals'])
})

test('purchase, settlement-detail, and full source failures remain truthful and preserve safe partial records', async () => {
  state.tables.purchases.push(purchase())
  state.tables.x402_settlement_attempts.push(attempt())
  state.tables.seller_withdrawals.push({ id: withdrawalA, seller_wallet: alice.address.toLowerCase(), amount_usdc: '2', net_amount_usdc: '1.99', status: 'pending_mint', created_at: '2026-10-05T10:00:00Z' })

  const purchasesUnavailable = await getWalletTransactions(alice.address, { filter: 'purchases', limit: 25, page: 1 }, clientWithUnavailableTables('purchases') as never)
  assert.equal(purchasesUnavailable.records.length, 0)
  assert.deepEqual(purchasesUnavailable.degradedSources, ['purchases'])
  assert.equal(purchasesUnavailable.summary.visibleSpentUsdc, null)

  const settlementUnavailable = await getWalletTransactions(alice.address, { filter: 'all', limit: 25, page: 1 }, clientWithUnavailableTables('x402_settlement_attempts') as never)
  assert.equal(settlementUnavailable.records.some(record => record.type === 'api_purchase'), true)
  assert.equal(settlementUnavailable.records.some(record => record.type === 'withdrawal'), true)
  assert.deepEqual(settlementUnavailable.degradedSources, ['settlement_details'])
  assert.equal(settlementUnavailable.records.find(record => record.type === 'api_purchase')?.paymentStatus, 'Recorded')

  const fullyUnavailable = await getWalletTransactions(alice.address, { filter: 'all', limit: 25, page: 1 }, clientWithUnavailableTables('purchases', 'api_listings', 'seller_withdrawals') as never)
  assert.equal(fullyUnavailable.records.length, 0)
  assert.deepEqual(new Set(fullyUnavailable.degradedSources), new Set(['purchases', 'earnings', 'withdrawals']))
  assert.equal(fullyUnavailable.summary.visibleSpentUsdc, null)
  assert.equal(fullyUnavailable.summary.visibleEarnedUsdc, null)
  const html = render({ history: fullyUnavailable })
  assert.match(html, /Transaction history is partially unavailable/)
  assert.doesNotMatch(html, /No transactions yet/)
})

test('seller listing cap is a disclosed product limitation rather than a temporary source failure', async () => {
  for (let index = 0; index < 501; index += 1) {
    state.tables.api_listings.push(listing(pagedPurchaseId(index), alice.address, `Seller API ${index}`))
  }
  const result = await getWalletTransactions(alice.address, { filter: 'earnings', limit: 25, page: 1 }, createServiceClient() as never)
  assert.deepEqual(result.limitations, ['seller_listing_cap'])
  assert.deepEqual(result.degradedSources, [])
  assert.match(render({ history: result }), /Seller history is limited to 500 owned listings/)
  assert.doesNotMatch(render({ history: result }), /earnings.*temporarily unavailable/i)
})

test('transaction UI renders empty state and all lightweight filters', () => {
  const html = render()
  assert.match(html, /Recent Transactions/)
  assert.match(html, /History is limited to 10 pages/)
  assert.match(html, /No transactions yet/)
  assert.match(html, /Explore Marketplace/)
  for (const label of ['All', 'Purchases', 'Earnings', 'Withdrawals']) assert.match(html, new RegExp(`>${label}<`))
})

test('transaction UI does not mislabel an unavailable history as an empty wallet', () => {
  const html = render({ history: history([], ['purchases', 'withdrawals']) })
  assert.match(html, /Transaction history is partially unavailable/)
  assert.doesNotMatch(html, /No transactions yet/)
  assert.doesNotMatch(html, />0 USDC</)
})

test('detail drawer separates payment and delivery and only links a verified transaction hash', () => {
  const record = purchaseTransaction(purchase(), attempt())!
  const html = render({ history: history([record]), selected: record })
  assert.match(html, /Type<\/dt><dd[^>]*>API Purchase/)
  assert.match(html, /Payment<\/dt><dd[^>]*>Settled/)
  assert.match(html, /Delivery<\/dt><dd[^>]*>Failed · HTTP 404/)
  assert.match(html, /Onchain Transaction/)
  assert.match(html, new RegExp(`href="https://explorer.arc.io/tx/${txHash}"`))
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)

  const referenceOnly = purchaseTransaction(purchase(), attempt({ transaction_id: 'facilitator-id' }))!
  const referenceHtml = render({ history: history([referenceOnly]), selected: referenceOnly })
  assert.match(referenceHtml, /Settlement Reference/)
  assert.doesNotMatch(referenceHtml, /Open in Arc explorer/)
})

test('withdrawal presentation labels net amounts and signs according to completion state', () => {
  const completed = withdrawalTransaction({ id: withdrawalA, amount_usdc: '12', net_amount_usdc: '11.99', status: 'minted', mint_tx_hash: txHash, created_at: '2026-10-02T10:00:00Z', minted_at: '2026-10-02T10:02:00Z' })!
  const pending = withdrawalTransaction({ id: randomUUID(), amount_usdc: '2', net_amount_usdc: '1.99', status: 'pending_mint', created_at: '2026-10-03T10:00:00Z' })!
  const expired = withdrawalTransaction({ id: randomUUID(), amount_usdc: '3', net_amount_usdc: '2.99', status: 'expired', created_at: '2026-10-04T10:00:00Z' })!

  const completedHtml = render({ history: history([completed]), selected: completed })
  assert.match(completedHtml, /Requested amount<\/dt><dd[^>]*>−12 USDC/)
  assert.match(completedHtml, /Completed amount<\/dt><dd[^>]*>11.99 USDC/)

  const pendingHtml = render({ history: history([pending]), selected: pending })
  assert.match(pendingHtml, /Requested amount<\/dt><dd[^>]*>2 USDC/)
  assert.match(pendingHtml, /Expected net amount<\/dt><dd[^>]*>1.99 USDC/)
  assert.doesNotMatch(pendingHtml, /Completed amount/)
  assert.doesNotMatch(pendingHtml, /−2 USDC/)

  const expiredHtml = render({ history: history([expired]), selected: expired })
  assert.match(expiredHtml, /Requested amount<\/dt><dd[^>]*>3 USDC/)
  assert.doesNotMatch(expiredHtml, /Completed amount/)
  assert.doesNotMatch(expiredHtml, /−3 USDC/)
})
