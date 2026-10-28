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

test('Seller API rows and Recent Sells use call results, including zero success and no calls', () => {
  const original = { myApis: world.myApis, sellerEarnings: world.sellerEarnings, sellCallGroups: world.sellCallGroups }
  const names = ['Star Trek API', 'Strictly Better API', 'No calls API', 'Failed request API']
  world.myApis = names.map((name, index) => ({ ...original.myApis[0], id: String(index), name }))
  world.sellerEarnings = {
    ...original.sellerEarnings,
    earnings_by_api: [0, 1, 3].map(index => ({ api_id: String(index), api_name: names[index], calls: index === 1 ? 2 : 1, total: index === 1 ? 0.0022 : 0.0011 })),
  }
  world.sellCallGroups = [0, 1, 3].map(index => ({
    api_id: String(index), api_name: names[index], count: index === 1 ? 2 : 1,
    successRate: index === 3 ? 0 : 100, avgLatency: 100, lastCalled: '2026-10-28', calls: [],
  }))
  try {
    const html = renderToStaticMarkup(createElement(ApisPage))
    const table = html.split('My Listed APIs')[1].split('</table>')[0]
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1])
    const successCell = (name: string) => {
      const row = rows.find(value => value.includes(name))!
      return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][4][1].replace(/<[^>]*>/g, '')
    }
    assert.equal(successCell('Star Trek API'), '100%')
    assert.equal(successCell('Strictly Better API'), '100%')
    assert.equal(successCell('No calls API'), '—')
    assert.equal(successCell('Failed request API'), '0%', 'payment alone must not imply success')
    const recentSells = html.split('Recent Sells')[1]
    assert.match(recentSells, /Star Trek API/)
    assert.match(recentSells, /Strictly Better API/)
    assert.doesNotMatch(recentSells, /No one has called your APIs yet/)
  } finally {
    Object.assign(world, original)
  }
})
