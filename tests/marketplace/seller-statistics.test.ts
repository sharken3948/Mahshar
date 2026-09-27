import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateSellerStatistics, paidCallCount } from '../../src/lib/marketplace/seller-statistics'

const IOSCOPE = '34c7a931-81de-4b8b-81ac-0916b4316989'

test('historical ioscope purchases remain gross revenue and paid calls without becoming withdrawable again', () => {
  const result = aggregateSellerStatistics([
    { id: 'legacy-1', api_id: IOSCOPE, amount_usdc: '0.001100', seller_share_usdc: null },
    { id: 'legacy-2', api_id: IOSCOPE, amount_usdc: '0.001100', seller_share_usdc: null },
    { id: 'current-1', api_id: IOSCOPE, amount_usdc: '0.001100', seller_share_usdc: '0.000900' },
  ], [
    { amount_usdc: '0.000200', status: 'pending_mint' },
    { amount_usdc: '0.000100', status: 'minted' },
    { amount_usdc: '0.000100', status: 'failed' },
    { amount_usdc: '0.000300', status: 'expired' },
  ], new Map([[IOSCOPE, 'ioscope']]))

  assert.equal(result.total_earnings, 0.0033)
  assert.equal(result.accumulated_share, 0.0009)
  assert.equal(result.in_flight_withdrawals, 0.0004)
  assert.equal(result.withdrawable_balance, 0.0005)
  assert.deepEqual(result.earnings_by_api, [{ api_id: IOSCOPE, api_name: 'ioscope', total: 0.0033, calls: 3 }])
  assert.equal(paidCallCount(result), 3)
})

test('multiple purchases and APIs aggregate once per durable purchase row', () => {
  const other = '11111111-1111-1111-1111-111111111111'
  const result = aggregateSellerStatistics([
    { id: 'settlement-a', api_id: IOSCOPE, amount_usdc: 1.1, seller_share_usdc: 0.9 },
    { id: 'settlement-b', api_id: IOSCOPE, amount_usdc: 1.1, seller_share_usdc: 0.9 },
    { id: 'settlement-c', api_id: other, amount_usdc: 2.2, seller_share_usdc: 1.8 },
  ], [], new Map([[IOSCOPE, 'ioscope'], [other, 'Other API']]))

  assert.equal(result.total_earnings, 4.4)
  assert.equal(result.accumulated_share, 3.6)
  assert.equal(result.withdrawable_balance, 3.6)
  assert.equal(paidCallCount(result), 3)
  assert.deepEqual(result.earnings_by_api.map(row => [row.api_name, row.calls, row.total]), [
    ['ioscope', 2, 2.2],
    ['Other API', 1, 2.2],
  ])
})
