import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { MarketplaceError } from '../../src/lib/marketplace/operation-authorization'
import { createMahsharOnrampSession } from '../../src/lib/onramp-server'
import { ONRAMP_ASSET_SELECTION, ONRAMP_DESTINATION_CHAIN, onrampSessionRequest } from '../../src/lib/onramp-policy'
import { walletRefreshResources } from '../../src/lib/wallet-refresh'
import { NextRequest } from 'next/server'
import { POST as createSession } from '../../src/app/api/onramp/session/route'

const wallet = '0x1111111111111111111111111111111111111111'
const otherWallet = '0x2222222222222222222222222222222222222222'

afterEach(() => { delete process.env.CIRCLE_ONRAMP_API_KEY })

test('session route rejects an unauthenticated browser without contacting Circle', async () => {
  const response = await createSession(new NextRequest('http://localhost:3000/api/onramp/session', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
    body: JSON.stringify({ destinationAddress: wallet }),
  }))
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Wallet session required' })
})

test('session derivation accepts only the authenticated destination and fixes Arc USDC', () => {
  const request = onrampSessionRequest({ destinationAddress: wallet }, wallet)
  assert.equal(request.destinationAddress, wallet)
  assert.equal(request.destinationChain, ONRAMP_DESTINATION_CHAIN)
  assert.deepEqual(request.assets, ONRAMP_ASSET_SELECTION)
  assert.match(request.appUserId, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(request).includes(wallet), true)
  assert.equal('provider' in request, false)
})

test('arbitrary network, token, provider, amount, and metadata inputs are rejected', () => {
  for (const extra of [
    { network: 'ethereum' }, { destinationChain: 'Ethereum' }, { token: 'USDT' },
    { assets: { pairs: [{ token: 'USDT', chain: 'ethereum' }] } }, { provider: 'other' },
    { amount: '1000' }, { metadata: { mode: 'override' } },
  ]) {
    assert.throws(() => onrampSessionRequest({ destinationAddress: wallet, ...extra }, wallet),
      (error: unknown) => error instanceof MarketplaceError && error.status === 400)
  }
  assert.throws(() => onrampSessionRequest({ destinationAddress: otherWallet }, wallet),
    (error: unknown) => error instanceof MarketplaceError && error.status === 403)
  assert.throws(() => onrampSessionRequest({ destinationAddress: 'not-a-wallet' }, wallet),
    (error: unknown) => error instanceof MarketplaceError && error.status === 400)
  assert.throws(() => onrampSessionRequest({ destinationAddress: '0x0000000000000000000000000000000000000000' }, wallet),
    (error: unknown) => error instanceof MarketplaceError && error.status === 400)
})

test('Onramp remains unavailable without server configuration and mint failures stay isolated', async () => {
  await assert.rejects(() => createMahsharOnrampSession({ destinationAddress: wallet }, wallet),
    (error: unknown) => error instanceof MarketplaceError && error.status === 503 && error.message === 'Onramp is not configured')
  await assert.rejects(() => createMahsharOnrampSession({ destinationAddress: wallet }, wallet, async () => { throw new Error('provider detail') }),
    (error: unknown) => error instanceof MarketplaceError && error.status === 503 && error.message === 'Onramp is temporarily unavailable')
})

test('server sends only the fixed request and returns only official short-lived session material', async () => {
  let captured: unknown
  const expected = {
    sessionId: 'session-id', sessionToken: 'short-lived-token', traceId: 'trace-id',
    widgetUrl: 'https://onramp.arc.io/launch?sessionToken=short-lived-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const result = await createMahsharOnrampSession({ destinationAddress: wallet }, wallet, async request => {
    captured = request
    return expected
  })
  assert.deepEqual(captured, onrampSessionRequest({ destinationAddress: wallet }, wallet))
  assert.deepEqual(result, expected)
})

test('route is authenticated POST-only and the secret stays server-only', () => {
  const route = readFileSync('src/app/api/onramp/session/route.ts', 'utf8')
  const server = readFileSync('src/lib/onramp-server.ts', 'utf8')
  const browser = [
    'src/components/OnrampProvider.tsx', 'src/components/NavBar.tsx', 'src/app/providers.tsx',
    'src/app/dashboard/wallet/page.tsx', 'src/app/buyer/page.tsx',
  ].map(path => readFileSync(path, 'utf8')).join('\n')
  assert.match(route, /export const POST = withWalletSession/)
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.doesNotMatch(route, new RegExp(`export const ${method}`))
  assert.match(server, /process\.env\.CIRCLE_ONRAMP_API_KEY/)
  assert.match(server, /requestTimeoutMs: ONRAMP_REQUEST_TIMEOUT_MS/)
  assert.doesNotMatch(browser, /CIRCLE_ONRAMP_API_KEY|createOnrampServerKit|NEXT_PUBLIC_.*ONRAMP/)
})

test('UI uses Circle hosted collection, loads lazily, and never resumes an API purchase', () => {
  const provider = readFileSync('src/components/OnrampProvider.tsx', 'utf8')
  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  const walletPage = readFileSync('src/app/dashboard/wallet/page.tsx', 'utf8')
  const nav = readFileSync('src/components/NavBar.tsx', 'utf8')
  assert.match(provider, /import\('@circle-fin\/onramp-kit'\)/)
  assert.match(provider, /kit\.openWindow/)
  assert.doesNotMatch(provider, /cardNumber|card_number|CVV|identity document|\/api\/proxy/)
  assert.match(walletPage, /OnrampTrigger variant="walletCard"/)
  assert.doesNotMatch(nav, /OnrampTrigger|Mahshar Balance:/)
  assert.match(buyer, /OnrampTrigger variant="insufficient" onBalanceRefresh={refreshArcWalletAfterOnramp}/)
  assert.equal((`${walletPage}\n${buyer}\n${nav}`.match(/<OnrampTrigger/g) ?? []).length, 2)
  const onrampBuyerSection = buyer.slice(buyer.indexOf('walletFundingNeeded && <p>'), buyer.indexOf('{listingsLoading'))
  assert.doesNotMatch(onrampBuyerSection, /submitConfirmedPayment|handleUseApi|\/api\/proxy/)
})

test('presentation explains the fixed destination without predicting provider payment methods', () => {
  const provider = readFileSync('src/components/OnrampProvider.tsx', 'utf8')
  const walletPage = readFileSync('src/app/dashboard/wallet/page.tsx', 'utf8')
  assert.match(provider, /Fund your Arc Mainnet wallet through Circle Onramp\./)
  assert.match(provider, /Supported fiat payment methods/)
  assert.match(provider, /Available options are shown by Circle and vary by region and provider\./)
  assert.match(provider, /<span>FUND<\/span>[\s\S]*<strong>Arc USDC<\/strong>[\s\S]*<b>Arc Mainnet<\/b><b>USDC<\/b>/)
  assert.doesNotMatch(provider, /Debit card|Apple Pay|Google Pay|Bank transfer/)
  assert.match(walletPage, />Arc USDC Balance<\/p>/)
  assert.match(walletPage, /Buy USDC with your Card/)
  assert.match(walletPage, /Available payment methods vary by region and provider\./)
  assert.doesNotMatch(walletPage, /Debit card|Credit card|Apple Pay|Google Pay|Bank transfer/)
})

test('Wallet keeps the balance cards informational and places one Onramp card above them', () => {
  const walletPage = readFileSync('src/app/dashboard/wallet/page.tsx', 'utf8')
  const cardStart = walletPage.indexOf('<section className={styles.walletOnrampCard}')
  const summaryStart = walletPage.indexOf('<div className={`${styles.walletSummary}')
  const summaryEnd = walletPage.indexOf('<div className={`${styles.cards} ${styles.walletActions}`}', summaryStart)
  assert.ok(cardStart >= 0 && summaryStart > cardStart && summaryEnd > summaryStart)
  const summary = walletPage.slice(summaryStart, summaryEnd)
  const arcCard = summary.slice(summary.indexOf('<section'), summary.indexOf('</section>') + '</section>'.length)
  assert.match(arcCard, /Arc USDC Balance/)
  assert.match(arcCard, /Held in your own wallet on Arc\./)
  assert.doesNotMatch(arcCard, /OnrampTrigger|Add USDC|Bridge USDC|walletBridgeEntry/)
  assert.equal((walletPage.match(/<OnrampTrigger/g) ?? []).length, 1)
})

test('Wallet and modal use the unmodified official Circle USDC token asset', () => {
  const asset = readFileSync('public/brand/usdc-token.svg', 'utf8')
  const walletPage = readFileSync('src/app/dashboard/wallet/page.tsx', 'utf8')
  const provider = readFileSync('src/components/OnrampProvider.tsx', 'utf8')
  assert.equal(createHash('sha256').update(asset).digest('hex'), 'fe4f9d5f34ef4ebeb5d80e1f5ff63dcaf5a0d5495f4adf206e4c3011d1f5c57d')
  assert.equal((`${walletPage}\n${provider}`.match(/src="\/brand\/usdc-token\.svg"/g) ?? []).length, 2)
  assert.doesNotMatch(provider, /function UsdcIcon|<svg viewBox="0 0 48 48"/)
})

test('required consent, hosted Circle CTA, and provider disclosures remain intact', () => {
  const provider = readFileSync('src/components/OnrampProvider.tsx', 'utf8')
  assert.match(provider, /checked={phoneConsent}/)
  assert.match(provider, /disabled={!phoneConsent} onClick={launch}>Open Circle Onramp/)
  assert.match(provider, /You authorize your wireless carrier to use or disclose information about your account and your wireless device/)
  assert.match(provider, /Fiat onramp transactions are processed by third-party payment processors\./)
  assert.match(provider, /You will review applicable provider terms in Circle’s flow\./)
  assert.match(provider, /Offramp functionality is not currently available through this feature\./)
})

test('completion refreshes only the existing Arc wallet balance resource', () => {
  assert.deepEqual(walletRefreshResources({ kind: 'onramp' }), ['arcWallet'])
  const provider = readFileSync('src/components/OnrampProvider.tsx', 'utf8')
  assert.match(provider, /onDepositSettled: \(\) => finish\('settled'\)/)
  assert.match(provider, /onDepositNotCompleted:/)
  assert.doesNotMatch(provider, /setInterval|poll/)
})

test('Onramp has no imports in Bridge, x402, agent, seller, or Admin execution paths', () => {
  const protectedPaths = [
    'src/hooks/useBridge.ts', 'src/hooks/useBridgeBalances.ts', 'src/lib/gateway.ts',
    'src/app/api/proxy/route.ts', 'src/app/api/agent/discover/route.ts',
    'src/app/api/seller/withdraw/route.ts', 'src/app/admin/operations/operations-shell.tsx',
  ]
  for (const path of protectedPaths) assert.doesNotMatch(readFileSync(path, 'utf8'), /onramp/i, path)
})

test('funding panel remains readable and horizontally bounded at approved mobile widths', () => {
  const css = readFileSync('src/components/onramp.module.css', 'utf8')
  const walletCss = readFileSync('src/app/dashboard/dashboard.module.css', 'utf8')
  assert.match(css, /box-sizing: border-box; width: min\(100%, 560px\); max-width: 100%/)
  assert.match(css, /max-height: calc\(100dvh - 48px\)/)
  assert.match(css, /overflow-x: hidden/)
  assert.match(css, /@media \(max-width: 620px\)/)
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(css, /@media \(max-width: 360px\)/)
  assert.match(css, /overflow-wrap: anywhere/)
  assert.match(walletCss, /\.walletOnrampCard[^}]*grid-template-columns: auto minmax\(0, 1fr\) minmax\(180px, auto\)/)
  assert.match(walletCss, /@media \(max-width: 767px\)[\s\S]*\.walletOnrampCard \{ grid-template-columns: minmax\(0, 1fr\); align-items: start; justify-items: stretch/)
  assert.match(walletCss, /\.walletOnrampAction \{ grid-column: auto; width: 100%/)
  assert.match(walletCss, /@media \(max-width: 430px\)[\s\S]*\.walletOnrampIndicators \{ display: grid; justify-items: start/)
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.trigger_walletCard \{ width: 100%; min-width: 0/)
  for (const width of [320, 360, 375, 390, 412, 430, 480]) {
    const overlayPadding = width <= 430 ? 8 : 12
    assert.ok(width - (overlayPadding * 2) >= 304, `${width}px modal content width`)
    assert.ok(width - 32 >= 288, `${width}px Wallet content width`)
  }
})
