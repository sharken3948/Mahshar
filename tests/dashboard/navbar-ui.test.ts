import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { walletState } from './navbar-ui-register.mjs'
import { NavBar } from '../../src/components/NavBar'

function renderNav(props: React.ComponentProps<typeof NavBar>) {
  return renderToStaticMarkup(React.createElement(NavBar, { pollBalance: false, balanceOverride: '12.5', ...props }))
}

test('homepage keeps the premium Dashboard primary action', () => {
  const html = renderNav({ landing: true })
  assert.match(html, /href="\/dashboard"[^>]*aria-label="Dashboard"/)
  assert.match(html, />Dashboard</)
  assert.doesNotMatch(html, /aria-label="Home"/)
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
  assert.match(source, /className=\{styles\.walletButton\} onClick=\{openAccountModal\}/)
  assert.match(source, /chain\.unsupported[\s\S]*onClick=\{openChainModal\}/)
})

test('responsive header rules preserve all controls without horizontal overflow affordances', () => {
  const css = readFileSync('src/components/nav-bar.module.css', 'utf8')
  const compact = css.match(/@media \(max-width: 800px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(compact, /flex-wrap:\s*wrap/)
  assert.match(compact, /\.landingNavRight, \.appNavRight[^}]*width:\s*100%/)
  assert.match(compact, /\.walletButton[^}]*max-width:\s*142px[^}]*overflow:\s*hidden/)
  assert.match(compact, /\.networkPill[^}]*min-width:\s*119px/)
  assert.doesNotMatch(css, /\.networkPill\s*\{[^}]*display:\s*none/)
  assert.doesNotMatch(css, /\.exploreGroup\s*\{[^}]*display:\s*none/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/)
})

test('Explore exposes only the three human-facing public destinations', () => {
  const source = readFileSync('src/components/NavBar.tsx', 'utf8')
  const menu = source.match(/id="landing-explore-menu"[\s\S]*?<\/div>\n\s*\)}/)?.[0] ?? ''
  for (const [title, href] of [['Agents', '/agents'], ['Docs', '/docs'], ['Support', '/support']]) {
    assert.match(menu, new RegExp(`href="${href}" title="${title}"`))
  }
  assert.doesNotMatch(menu, /title="(?:Marketplace|Build|Community)"/)
  assert.equal((menu.match(/<ExploreLink /g) ?? []).length, 3)
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
