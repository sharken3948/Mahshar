import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { walletState } from './navbar-ui-register.mjs'
import { NavBar } from '../../src/components/NavBar'

function renderNav(props: React.ComponentProps<typeof NavBar>) {
  return renderToStaticMarkup(React.createElement(NavBar, { pollBalance: false, balanceOverride: '12.5', ...props }))
}

beforeEach(() => {
  walletState.connected = true
  walletState.unsupported = false
  walletState.sessionStatus = 'authenticated'
  walletState.networkStatus = 'ready'
  walletState.authenticationActions = 0
})

test('homepage keeps the premium Dashboard primary action', () => {
  const html = renderNav({ landing: true })
  assert.match(html, /href="\/dashboard"[^>]*aria-label="Dashboard"/)
  assert.match(html, />Dashboard</)
  assert.doesNotMatch(html, /aria-label="Home"/)
})

test('homepage removes the ambiguous balance funding control and preserves remaining control order', () => {
  const html = renderNav({ landing: true })
  const positions = ['>Explore ', '>Dashboard<', 'Arc Mainnet', 'Open account actions for']
    .map(marker => html.indexOf(marker))
  assert.ok(positions.every(position => position >= 0), String(positions))
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
  assert.doesNotMatch(html, /Mahshar Balance:|>Add USDC<|\$12\.5 USDC/)
  assert.doesNotMatch(readFileSync('src/components/NavBar.tsx', 'utf8'), /OnrampTrigger/)
})

test('application pages reuse the homepage logo treatment and header width', () => {
  const html = renderNav({})
  const css = readFileSync('src/components/nav-bar.module.css', 'utf8')
  assert.match(html, /data-variant="landing"/)
  assert.match(css, /\.landingNavInner,\s*\.appNavInner\s*\{[^}]*width:\s*calc\(100% - 124px\)[^}]*max-width:\s*1560px[^}]*height:\s*100%/)
})

test('dashboard routes replace Dashboard with a Home action to the homepage', () => {
  const html = renderNav({ dashboard: true })
  assert.match(html, /href="\/"[^>]*aria-label="Home"/)
  assert.match(html, />Home</)
  assert.match(html, /m4 11 8-7 8 7/)
  assert.doesNotMatch(html, /href="\/dashboard"/)
})

test('Arc Mainnet renders as status, not as a selectable control', () => {
  const html = renderNav({ landing: true })
  const status = html.match(/<span class="networkPill"[\s\S]*?<\/span>/)?.[0]
  assert.ok(status)
  assert.match(status, /role="status"/)
  assert.match(status, /Arc Mainnet/)
  assert.doesNotMatch(status, /<button|aria-haspopup|aria-expanded|<svg/)
})

test('connected wallet renders a shortened EVM identity and retains account actions', () => {
  walletState.connected = true
  walletState.unsupported = false
  const html = renderNav({ landing: true })
  assert.match(html, /Open account actions for 0x1111111111111111111111111111111111111111/)
  assert.match(html, /0x1111…1111/)
  assert.match(html, /src="\/provider-icon\.svg"/)
  assert.doesNotMatch(html, /display-name-must-not-render|chain-should-not-render/)

  const source = readFileSync('src/components/NavBar.tsx', 'utf8')
  assert.match(source, /className=\{`\$\{styles\.walletButton\} \$\{styles\.walletIdentityButton\} \$\{compact \? styles\.mobileWalletButton : ''\}`\} onClick=\{openAccountModal\}/)
  assert.match(source, /chain\.unsupported[\s\S]*onClick=\{openChainModal\}/)
})

test('a rejected login leaves a clear manual Sign in action without hiding the connected wallet', () => {
  walletState.sessionStatus = 'unauthenticated'
  const html = renderNav({ landing: true })
  assert.match(html, />Sign in<\/button>/)
  assert.match(html, /Open account actions for 0x1111111111111111111111111111111111111111/)
  assert.doesNotMatch(html, /href="\/dashboard"/)
})

test('session validation renders a neutral state and authenticated completion swaps in Dashboard immediately', () => {
  walletState.sessionStatus = 'checking'
  let html = renderNav({ landing: true })
  assert.match(html, />Checking…<\/button>/)
  assert.match(html, /href="\/dashboard"[^>]*aria-label="Dashboard"/)
  assert.doesNotMatch(html, />Sign in<\/button>|>Signing in…<\/button>/)
  walletState.sessionStatus = 'authenticated'
  html = renderNav({ landing: true })
  assert.match(html, /href="\/dashboard"[^>]*aria-label="Dashboard"/)
  assert.doesNotMatch(html, />Sign in<\/button>|>Checking…<\/button>/)
})

test('Signing in is transient, keeps Dashboard visible, and clears on every terminal state', () => {
  walletState.sessionStatus = 'signing'
  let html = renderNav({ landing: true })
  assert.match(html, /href="\/dashboard"[^>]*aria-label="Dashboard"/)
  assert.match(html, />Signing in…<\/button>/)

  for (const status of ['authenticated', 'unauthenticated', 'error'] as const) {
    walletState.sessionStatus = status
    html = renderNav({ landing: true })
    assert.doesNotMatch(html, />Signing in…<\/button>/)
  }
})

test('disconnected mobile header offers wallet connection and keeps Dashboard in the mobile menu', () => {
  walletState.connected = false
  walletState.sessionStatus = 'disconnected'
  const html = renderNav({ landing: true })
  assert.match(html, />Connect Wallet<\/button>/)
  assert.doesNotMatch(html, /href="\/dashboard"|>Sign in<\/button>/)
  const source = readFileSync('src/components/NavBar.tsx', 'utf8')
  assert.match(source, /<MobileMenuLink href="\/dashboard"[^>]*>Dashboard<\/MobileMenuLink>/)
})

test('approved mobile header is isolated below 768px and uses bounded two-row geometry', () => {
  const css = readFileSync('src/components/nav-bar.module.css', 'utf8')
  const mobile = css.slice(css.indexOf('@media (max-width: 767px)'), css.indexOf('@media (max-width: 430px)'))
  assert.match(mobile, /\.desktopHeader\s*\{\s*display:\s*none/)
  assert.match(mobile, /\.mobileHeader[^}]*display:\s*grid[^}]*width:\s*100%[^}]*min-width:\s*0/)
  assert.match(mobile, /\.mobileTopRow,\s*\.mobileStatusRow[^}]*min-width:\s*0/)
  assert.match(mobile, /\.mobileStatusRow[^}]*gap:\s*8px[^}]*min-height:\s*40px/)
  assert.match(mobile, /\.mobileNetworkStatus[^}]*min-width:\s*0[^}]*overflow:\s*hidden/)
  assert.match(mobile, /\.walletButton\.mobileWalletButton[^}]*max-width:\s*min\(172px, 58vw\)[^}]*overflow:\s*hidden/)
  assert.match(mobile, /\.mobileMenuPanel[^}]*right:\s*0[^}]*left:\s*0[^}]*overflow-y:\s*auto/)
  assert.doesNotMatch(css, /(?:html|body|\*)[^{}]*\{[^}]*overflow-x:\s*hidden/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/)
  for (const width of [320, 360, 375, 390, 412, 430, 480]) {
    const walletCap = width <= 430 ? 158 : Math.min(172, width * .58)
    assert.ok(116 + 8 + walletCap <= width - 24, `${width}px compact row`)
  }
})

test('mobile menu maps every available approved item to a real route without placeholders', () => {
  const source = readFileSync('src/components/NavBar.tsx', 'utf8')
  const menu = source.slice(source.indexOf('id="mahshar-mobile-menu"'), source.indexOf('</div>\n      </>}', source.indexOf('id="mahshar-mobile-menu"')))
  for (const [label, href] of [
    ['Marketplace', '/marketplace'], ['What is Mahshar?', '/about'], ['For API Providers', '/providers'],
    ['Agents', '/agents'], ['Docs', '/docs'],
    ['Dashboard', '/dashboard'], ['Wallet', '/dashboard/wallet'],
    ['Settings', '/dashboard/settings'], ['Support', '/support'],
  ]) assert.match(menu, new RegExp(`href="${href.replaceAll('/', '\\/')}"[^>]*>${label}`), label)
  assert.doesNotMatch(menu, /Mahshar Balance|Add USDC/)
  assert.doesNotMatch(menu, /href="(?:#|javascript:)|Community/)
  assert.match(menu, /mobileMenuStatus[^>]*><span>Arc Mainnet<\/span>/)
})

test('every approved mobile page renders the same shared NavBar and Dashboard keeps it first', () => {
  for (const path of ['src/app/page.tsx', 'src/app/seller/page.tsx', 'src/app/buyer/page.tsx']) {
    assert.match(readFileSync(path, 'utf8'), /<NavBar(?:\s|\/|>)/, path)
  }
  const dashboardVisuals = readFileSync('src/app/dashboard/dashboard-visuals.tsx', 'utf8')
  const dashboardLayout = readFileSync('src/app/dashboard/layout.tsx', 'utf8')
  const dashboardCss = readFileSync('src/app/dashboard/dashboard.module.css', 'utf8')
  assert.match(dashboardVisuals, /return <NavBar dashboard/)
  assert.match(dashboardLayout, /<div className=\{styles\.topbar\}><DashboardNavBar \/><\/div>/)
  assert.match(dashboardCss, /@media \(max-width: 767px\)[\s\S]*\.topbar \{ order: 0; \}[\s\S]*\.sidebar \{ order: 1; \}[\s\S]*\.main \{ order: 2; \}/)
})

test('desktop Explore exposes the ordered public education and discovery destinations', () => {
  const source = readFileSync('src/components/NavBar.tsx', 'utf8')
  const menu = source.match(/id="landing-explore-menu"[\s\S]*?<\/div>\n\s*\)}/)?.[0] ?? ''
  const destinations = [
    ['Marketplace', '/marketplace'], ['What is Mahshar?', '/about'], ['For API Providers', '/providers'],
    ['Agents', '/agents'], ['Docs', '/docs'], ['Support', '/support'],
  ] as const
  for (const [title, href] of destinations) {
    assert.ok(menu.includes(`href="${href}" title="${title}"`), title)
  }
  const positions = destinations.map(([, href]) => menu.indexOf(`href="${href}"`))
  assert.ok(positions.every(position => position >= 0))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.doesNotMatch(menu, /title="(?:Build|Community)"/)
  assert.equal((menu.match(/<ExploreLink /g) ?? []).length, 6)
})

test('Explore remains closed initially and retains every close path', () => {
  const source = readFileSync('src/components/NavBar.tsx', 'utf8')
  assert.match(source, /useState\(false\)/)
  assert.match(source, /onClick=\{\(\) => setIsOpen\(open => !open\)\}/)
  assert.match(source, /document\.addEventListener\('pointerdown', closeOnOutsidePointer\)/)
  assert.match(source, /event\.key !== 'Escape'/)
  assert.match(source, /buttonRef\.current\?\.focus\(\)/)
  assert.match(source, /onSelect=\{\(\) => setIsOpen\(false\)\}/)
  assert.match(source, /onBlur=\{\(event\) =>[\s\S]*setIsOpen\(false\)/)
})
