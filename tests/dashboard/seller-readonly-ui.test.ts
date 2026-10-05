import './seller-readonly-register.mjs'
import { world } from './seller-readonly-register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ApisPage from '../../src/app/dashboard/apis/page'
import DashboardPage from '../../src/app/dashboard/page'

test('APIs page renders aggregate seller statistics without a Marketplace sign-in wall', () => {
  const html = renderToStaticMarkup(createElement(ApisPage))
  for (const text of ['Total APIs', 'Active APIs', 'Total Calls', 'Lifetime buyer payments', 'My Listed APIs', 'Buyer payments', 'ioscope', '0.0033']) {
    assert.ok(html.includes(text), text)
  }
  assert.doesNotMatch(html, /Total API Revenue|>Earned</)
  assert.doesNotMatch(html, /Private seller statistics|Sign in to Marketplace|Marketplace sign-in|Verify seller wallet/)
})

test('Dashboard Seller Earnings uses the read-only seller summary without SIWE', () => {
  const html = renderToStaticMarkup(createElement(DashboardPage))
  assert.match(html, /Seller Earnings/)
  assert.match(html, /0\.0020/)
  assert.match(html, /Buyer payments/)
  assert.doesNotMatch(html, /Gross revenue/)
  assert.doesNotMatch(html, /Sign in to Marketplace|Verify seller wallet/)
})

test('determined zero seller earnings render as 0.0000 instead of an em dash', () => {
  const original = world.sellerEarnings
  world.sellerEarnings = { ...original, total_earnings: 0, accumulated_share: 0, in_flight_withdrawals: 0, withdrawable_balance: 0, earnings_by_api: [] }
  try {
    const html = renderToStaticMarkup(createElement(DashboardPage))
    assert.match(html, /Seller Earnings[\s\S]*0\.0000/)
  } finally {
    world.sellerEarnings = original
  }
})
