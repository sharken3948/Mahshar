import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../../tests/marketplace/fixtures'
import { boundary } from '../../tests/admin/fixture'
import { clearOperationsCacheForTests } from './admin/operations-cache'
import { LISTINGS_DEFAULT_PAGE_SIZE, LISTINGS_MAX_PAGE_SIZE, OPERATIONS_TTL, listingOperationsDto, runAdminDbRead } from './admin/operations-data'
import { ArcBalanceReader } from './arc-balance-read'
import { getPlatformTreasuryBalance, readPlatformTreasuryBalance, TREASURY_BALANCE_TTL_MS } from './admin/treasury-data'
import { verifyPlatformWalletConfiguration } from './platform-wallet-config'
import { TreasuryCard } from '../app/admin/operations/treasury-card'
import * as counts from '../app/api/admin/operations/counts/route'
import * as snapshot from '../app/api/admin/operations/snapshot/route'
import * as payments from '../app/api/admin/operations/recent-payments/route'
import * as listings from '../app/api/admin/operations/listings/route'
import * as treasury from '../app/api/admin/operations/treasury/route'
import * as publicListings from '../app/api/apis/route'

const listingId = '11111111-1111-4111-8111-111111111111'
const attemptId = '22222222-2222-4222-8222-222222222222'
const purchaseId = '33333333-3333-4333-8333-333333333333'
const alicePrivateKey = `0x${'11'.repeat(32)}`
const bobPrivateKey = `0x${'22'.repeat(32)}`

function unsigned(path: string) { return new NextRequest(origin + path) }
function authorized(path: string, account = alice) { return new NextRequest(origin + path, { headers: sessionHeaders(account) }) }

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: listingId, name: '<img src=x onerror=alert(1)>', category: 'Data', price_per_call: 0.001,
    seller_wallet: bob.address.toLowerCase(), is_active: true, verified_at: null, source: 'seller', score: 8,
    endpoint_url: 'https://api.example.test/v1', method: 'GET', auth_type: 'apikey', auth_param_name: null,
    encrypted_key: 'ciphertext-never-return', example_request: null, body_required: false,
    dynamic_path_supported: false, path_parameters: null, query_parameters: null, created_at: '2026-09-30T10:00:00.000Z',
    response_body: 'private-response-never-return', ...overrides,
  }
}

beforeEach(() => {
  reset(); clearOperationsCacheForTests(); boundary.actions = 0; boundary.unavailable = false; boundary.unavailableTable = null; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
  process.env.PLATFORM_WALLET_ADDRESS = alice.address
  process.env.PLATFORM_WALLET_PRIVATE_KEY = alicePrivateKey
  state.tables.api_listings.push(listing())
  state.tables.x402_settlement_attempts.push({
    id: attemptId, api_id: listingId, state: 'SETTLEMENT_UNKNOWN', purchase_id: purchaseId,
    transaction_id: '0xabc123', reason: 'settlement_transport_uncertain', created_at: '2026-09-30T10:01:00.000Z',
    updated_at: '2026-09-30T10:02:00.000Z', delivery_state: 'UNKNOWN', delivery_http_status: 502,
    delivery_error_code: 'upstream_unavailable', api_listings: { id: listingId, name: 'Weather' },
    binding: { payer: alice.address, signature: 'never-return' }, fingerprint: 'a'.repeat(64),
    authorization_key: 'b'.repeat(64), submission_token: 'never-return', delivery_token: 'never-return',
  })
})

test('operations reads fail closed for missing and non-admin sessions', async () => {
  assert.equal((await counts.GET(unsigned('/api/admin/operations/counts'))).status, 401)
  assert.equal((await listings.GET(authorized('/api/admin/operations/listings', bob))).status, 403)
  assert.equal((await treasury.GET(unsigned('/api/admin/operations/treasury'))).status, 401)
  assert.equal((await treasury.GET(authorized('/api/admin/operations/treasury', bob))).status, 403)
  assert.equal(boundary.actions, 2, 'only the two non-admin session lookups may reach storage')
})

test('platform wallet configuration normalizes a matching signer and fails closed without leaking secrets', () => {
  const matched = verifyPlatformWalletConfiguration({ address: alice.address.toLowerCase(), privateKey: alicePrivateKey })
  assert.equal(matched.address, alice.address)
  assert.equal(matched.privateKey, alicePrivateKey)

  const logged: unknown[] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => { logged.push(values) }
  try {
    for (const input of [
      { address: bob.address, privateKey: alicePrivateKey },
      { address: 'not-an-address', privateKey: alicePrivateKey },
      { address: alice.address, privateKey: `0x${'private-secret-marker'.padEnd(64, '0')}` },
    ]) {
      let message = ''
      assert.throws(() => verifyPlatformWalletConfiguration(input), error => {
        message = error instanceof Error ? error.message : String(error)
        return /Platform wallet configuration/.test(message)
      })
      assert.equal(message.includes(input.privateKey), false)
      assert.equal(message.includes(input.address), false)
    }
  } finally {
    console.error = originalError
  }
  assert.equal(JSON.stringify(logged).includes(alicePrivateKey), false)
})

test('treasury balance uses the configured platform wallet and an Arc Mainnet USDC observation', async () => {
  const observedAt = Date.parse('2026-10-04T10:00:00.000Z')
  let observedWallet = ''
  const result = await readPlatformTreasuryBalance({
    platformAddress: bob.address,
    platformPrivateKey: bobPrivateKey,
    readBalance: async wallet => {
      observedWallet = wallet
      return { wallet, value: BigInt('12345678'), status: 'fresh', source: 'server-fallback', updatedAt: observedAt }
    },
  })
  assert.equal(observedWallet.toLowerCase(), bob.address.toLowerCase())
  assert.equal(result.wallet.toLowerCase(), bob.address.toLowerCase())
  assert.equal(result.balance_usdc, '12.345678')
  assert.equal(result.chain_id, 5042)
  assert.equal(result.status, 'fresh')
  assert.equal(result.as_of, '2026-10-04T10:00:00.000Z')
  assert.match(result.explorer_url, /^https:\/\/explorer\.arc\.io\/address\/0x/i)
  assert.deepEqual(Object.keys(result).sort(), ['as_of','balance_usdc','chain_id','explorer_url','status','wallet'])
})

test('treasury balance rejects missing configuration and unavailable reads instead of reporting zero', async () => {
  await assert.rejects(() => readPlatformTreasuryBalance({ platformAddress: 'not-an-address', platformPrivateKey: bobPrivateKey }), /configuration/)
  await assert.rejects(() => readPlatformTreasuryBalance({ platformAddress: bob.address, platformPrivateKey: alicePrivateKey }), /mismatch/)
  await assert.rejects(() => readPlatformTreasuryBalance({
    platformAddress: bob.address,
    platformPrivateKey: bobPrivateKey,
    readBalance: async wallet => ({ wallet, value: undefined, status: 'unknown' }),
  }), /unavailable/)
})

test('treasury cache uses a 60-second TTL and coalesces concurrent reads', async () => {
  assert.equal(TREASURY_BALANCE_TTL_MS, 60_000)
  let reads = 0
  const dependencies = {
    platformAddress: alice.address,
    platformPrivateKey: alicePrivateKey,
    readBalance: async (wallet: typeof alice.address) => {
      reads += 1
      return { wallet, value: BigInt(42), status: 'fresh' as const, updatedAt: Date.now(), source: 'server-fallback' as const }
    },
  }
  await getPlatformTreasuryBalance(dependencies)
  await getPlatformTreasuryBalance(dependencies)
  assert.equal(reads, 1)

  clearOperationsCacheForTests()
  let release: (() => void) | undefined
  const blocked = new Promise<void>(resolve => { release = resolve })
  const concurrentDependencies = {
    ...dependencies,
    readBalance: async (wallet: typeof alice.address) => {
      reads += 1
      await blocked
      return { wallet, value: BigInt(43), status: 'fresh' as const, updatedAt: Date.now(), source: 'server-fallback' as const }
    },
  }
  const first = getPlatformTreasuryBalance(concurrentDependencies)
  const second = getPlatformTreasuryBalance(concurrentDependencies)
  assert.equal(reads, 2)
  release?.()
  assert.equal((await first).balance_usdc, '0.000043')
  assert.deepEqual(await second, await first)
  assert.equal(reads, 2)
})

test('a later Arc read failure preserves the stale treasury value and UI labels it Last known', async () => {
  let now = 1_000
  let fail = false
  const reader = new ArcBalanceReader({ now: () => now, cacheMs: 10 })
  const source = { name: 'server-fallback' as const, read: async () => {
    if (fail) throw new Error('RPC unavailable')
    return BigInt(1234567)
  } }
  const dependencies = {
    platformAddress: alice.address,
    platformPrivateKey: alicePrivateKey,
    now: () => now,
    readBalance: (wallet: typeof alice.address) => reader.read(wallet, [source], { force: true }),
  }
  const live = await readPlatformTreasuryBalance(dependencies)
  assert.equal(live.status, 'fresh')
  now += 11
  fail = true
  const stale = await readPlatformTreasuryBalance(dependencies)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.balance_usdc, live.balance_usdc)
  const html = renderToStaticMarkup(React.createElement(TreasuryCard, {
    resource: { phase: 'degraded', data: stale }, onRetry: async () => {},
  }))
  assert.match(html, /Last known/)
  assert.match(html, /1\.234567/)
})

test('treasury card renders live and unavailable states with explicit balance semantics', () => {
  const dto = {
    wallet: alice.address, balance_usdc: '12.5', status: 'fresh' as const, chain_id: 5042 as const,
    explorer_url: `https://explorer.arc.io/address/${alice.address}`, as_of: '2026-10-04T10:00:00.000Z',
  }
  const live = renderToStaticMarkup(React.createElement(TreasuryCard, {
    resource: { phase: 'ready', data: dto }, onRetry: async () => {},
  }))
  assert.match(live, /Arc Mainnet wallet USDC balance/)
  assert.match(live, /Direct wallet balance only/)
  assert.match(live, /excludes the separate Circle Gateway balance/)
  assert.match(live, /not an exact accumulated platform-fee total/)
  assert.match(live, /manual or unrelated USDC/)
  assert.match(live, /Updated/)

  const unavailable = renderToStaticMarkup(React.createElement(TreasuryCard, {
    resource: { phase: 'unavailable', data: null }, onRetry: async () => {},
  }))
  assert.match(unavailable, /Unavailable/)
  assert.doesNotMatch(unavailable, />0(?:\.0+)?\s*<small>USDC/)
})

test('authorized Admin treasury read succeeds from the verified cached observation', async () => {
  await getPlatformTreasuryBalance({
    platformAddress: alice.address,
    platformPrivateKey: alicePrivateKey,
    readBalance: async wallet => ({ wallet, value: BigInt(5000000), status: 'fresh', updatedAt: Date.now(), source: 'server-fallback' }),
  })
  const response = await treasury.GET(authorized('/api/admin/operations/treasury'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).balance_usdc, '5')
})

test('treasury route remains Admin-only and isolates balance failures', async () => {
  const previousAddress = process.env.PLATFORM_WALLET_ADDRESS
  delete process.env.PLATFORM_WALLET_ADDRESS
  try {
    const failed = await treasury.GET(authorized('/api/admin/operations/treasury'))
    assert.equal(failed.status, 503)
    assert.equal(failed.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await failed.json(), { error: 'treasury_balance_unavailable' })
  } finally {
    if (previousAddress === undefined) delete process.env.PLATFORM_WALLET_ADDRESS
    else process.env.PLATFORM_WALLET_ADDRESS = previousAddress
  }
})

test('authorized operations routes return only allowlisted DTO fields', async () => {
  for (const [route, path] of [[counts, '/api/admin/operations/counts'], [snapshot, '/api/admin/operations/snapshot'],
    [payments, '/api/admin/operations/recent-payments'], [listings, '/api/admin/operations/listings']] as const) {
    const response = await route.GET(authorized(path))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const serialized = JSON.stringify(await response.json())
    for (const secret of ['endpoint_url','encrypted_key','response_body','binding','fingerprint','authorization_key',
      'submission_token','delivery_token','signature','nonce','purchase_access_token','ciphertext-never-return','private-response-never-return']) {
      assert.equal(serialized.includes(secret), false, `${path} leaked ${secret}`)
    }
  }
})

test('malicious listing metadata stays inert text in the DTO and React source', async () => {
  const response = await listings.GET(authorized('/api/admin/operations/listings'))
  const body = await response.json()
  assert.equal(body.listings[0].name, '<img src=x onerror=alert(1)>')
  const source = readFileSync('src/app/admin/operations/listings/listings-client.tsx', 'utf8')
  assert.match(source, /\{row\.name\}/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
})

test('listing DTO keeps visibility and execution eligibility separate', () => {
  const dto = listingOperationsDto(listing() as any)
  assert.equal(dto?.contract.status, 'VALID')
  assert.equal(dto?.discovery.status, 'VISIBLE')
  assert.equal(dto?.execution.status, 'BLOCKED')
  assert.equal(dto?.execution.reason_code, 'verification_required')
  assert.equal(dto?.seller_wallet.includes(bob.address.toLowerCase()), false)
  assert.equal(JSON.stringify(dto).includes('api.example.test'), false)

  const invalid = listingOperationsDto(listing({ method: 'TRACE' }) as any)
  assert.deepEqual([invalid?.contract.status, invalid?.discovery.status, invalid?.execution.status], ['INVALID','EXCLUDED','BLOCKED'])
  assert.equal(invalid?.contract.reason_code, 'invalid_method')
})

test('listing pagination defaults to 25 and rejects more than 50', async () => {
  const response = await listings.GET(authorized('/api/admin/operations/listings'))
  const body = await response.json()
  assert.equal(LISTINGS_DEFAULT_PAGE_SIZE, 25)
  assert.equal(LISTINGS_MAX_PAGE_SIZE, 50)
  assert.equal(body.pagination.page_size, 25)
  assert.equal((await listings.GET(authorized('/api/admin/operations/listings?page_size=51'))).status, 400)
})

test('operations failures report unavailable rather than synthetic zero', async () => {
  boundary.unavailableTable = 'api_listings'
  const response = await counts.GET(authorized('/api/admin/operations/counts'))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'listing_counts_unavailable' })
})

test('an Admin read failure leaves the public Marketplace route independent', async () => {
  boundary.unavailableTable = 'api_listings'
  assert.equal((await counts.GET(authorized('/api/admin/operations/counts'))).status, 503)
  boundary.unavailableTable = null
  const response = await publicListings.GET(unsigned('/api/apis'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).apis.length, 1)
})

test('process-local cache deduplicates reads and enforces approved TTL values', async () => {
  assert.equal(OPERATIONS_TTL.listingCounts, 300_000)
  assert.equal(OPERATIONS_TTL.settlementSnapshot, 60_000)
  assert.equal(OPERATIONS_TTL.recentPayments, 60_000)
  await counts.GET(authorized('/api/admin/operations/counts'))
  const afterFirst = boundary.actions
  await counts.GET(authorized('/api/admin/operations/counts'))
  assert.equal(boundary.actions, afterFirst + 1, 'the second request performs only its required session lookup')
})

test('database read gate never permits more than two in flight', async () => {
  let active = 0, maximum = 0
  await Promise.all(Array.from({ length: 6 }, () => runAdminDbRead(async () => {
    active += 1; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
  })))
  assert.equal(maximum, 2)
})

test('operations routes are GET-only and UI has no mutation or unsafe HTML path', () => {
  for (const route of [counts, snapshot, payments, listings, treasury]) {
    for (const method of ['POST','PATCH','PUT','DELETE']) assert.equal(method in route, false)
  }
  const files = [
    'src/app/admin/operations/operations-shell.tsx', 'src/app/admin/operations/overview-client.tsx',
    'src/app/admin/operations/treasury-card.tsx',
    'src/app/admin/operations/listings/listings-client.tsx',
  ].map(path => readFileSync(path, 'utf8')).join('\n')
  assert.doesNotMatch(files, /dangerouslySetInnerHTML/)
  assert.doesNotMatch(files, /\/api\/discovery|method:\s*['"](?:POST|PATCH|PUT|DELETE)/)
  assert.match(files, /document\.visibilityState/)
  assert.match(files, /visibilitychange/)
  assert.match(files, /\/api\/admin\/operations\/treasury/)
  assert.match(files, /excludes the separate Circle Gateway balance/)
  assert.match(files, /Last known/)
  const overviewSource = readFileSync('src/app/admin/operations/overview-client.tsx', 'utf8')
  assert.match(overviewSource, /useEffect\(\(\) => \{\s*mounted\.current = true\s*return \(\) => \{ mounted\.current = false \}/)
  assert.doesNotMatch(readFileSync('src/app/admin/operations/listings/listings-client.tsx', 'utf8'), /setInterval/)
  const dataSource = readFileSync('src/lib/admin/operations-data.ts', 'utf8')
  assert.match(dataSource, /\.limit\(SNAPSHOT_ROW_LIMIT\)/)
  assert.match(dataSource, /const RECENT_PAYMENT_LIMIT = OPERATIONS_DEFAULT_LIMIT/)
  assert.match(dataSource, /\.limit\(limit\)/)
  assert.match(dataSource, /\.range\(from, from \+ input\.pageSize - 1\)/)
})

test('responsive source includes desktop, tablet, and mobile-safe layouts', () => {
  const css = readFileSync('src/app/admin/operations/operations.module.css', 'utf8')
  assert.match(css, /overflow-x:\s*clip/)
  assert.match(css, /@media \(max-width:\s*1180px\)/)
  assert.match(css, /@media \(max-width:\s*820px\)/)
  assert.match(css, /@media \(max-width:\s*580px\)/)
  assert.match(css, /\.sidebarOpen/)
  assert.match(css, /content:\s*attr\(data-label\)/)
})

test('shared Operations readability uses a comfortable text floor without zooming or widening', () => {
  const css = readFileSync('src/app/admin/operations/operations.module.css', 'utf8')
  assert.match(css, /\.main\s*\{[^}]*max-width:\s*1680px/)
  assert.match(css, /\.navItem\s*\{[^}]*font-size:\s*17px/)
  assert.match(css, /\.pageHeading p\s*\{[^}]*font-size:\s*17px/)
  assert.match(css, /\.table th\s*\{[^}]*font-size:\s*13\.5px/)
  assert.match(css, /\.table td\s*\{[^}]*font-size:\s*15px/)
  assert.match(css, /\.table td > small\s*\{[^}]*font-size:\s*14px/)
  assert.match(css, /\.statusBadge\s*\{[^}]*font-size:\s*13px/)
  assert.match(css, /\.filterField select,[\s\S]*?font-size:\s*15px/)
  assert.match(css, /font-size:\s*12\.5px[^}]*content:\s*attr\(data-label\)/)
  assert.doesNotMatch(css, /\bzoom\s*:|transform:\s*scale\(/)
})

test('Need review badge fits the fixed sidebar and restores in the mobile drawer', () => {
  const shell = readFileSync('src/app/admin/operations/operations-shell.tsx', 'utf8')
  const css = readFileSync('src/app/admin/operations/operations.module.css', 'utf8')
  assert.match(shell, /styles\.navItemWithCount/)
  assert.match(shell, /Need review/)
  assert.match(css, /\.navItemWithCount\s*\{[\s\S]*?grid-template-columns:\s*18px minmax\(0, 1fr\)/)
  assert.match(css, /\.navItemWithCount\s*>\s*small\s*\{[\s\S]*?justify-self:\s*start;[\s\S]*?margin-left:\s*0/)
  assert.match(css, /\.shellCollapsed \.navItemWithCount\s*\{[\s\S]*?display:\s*flex;[\s\S]*?min-height:\s*52px/)
  assert.match(css, /\.sidebarOpen \.navItemWithCount\s*\{[\s\S]*?display:\s*grid;[\s\S]*?min-height:\s*68px/)
  assert.doesNotMatch(css, /\.navItemWithCount[^}]*overflow-x:\s*(auto|scroll)/)
})

test('core source does not import Admin operations modules', () => {
  const roots = ['src/app/api', 'src/lib']
  const walk = (path: string): string[] => readdirSync(path).flatMap(name => {
    const child = join(path, name)
    if (child.includes('src/app/api/admin') || child.includes('src/lib/admin')) return []
    return statSync(child).isDirectory() ? walk(child) : /\.(?:ts|tsx)$/.test(child) ? [child] : []
  })
  for (const file of roots.flatMap(walk)) {
    if (file.endsWith('admin-operations.test.ts')) continue
    assert.doesNotMatch(readFileSync(file, 'utf8'), /@\/lib\/admin\/operations|admin\/operations-/i, file)
  }
})
