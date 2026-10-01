import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const pages = ['about', 'providers', 'agents', 'docs', 'support'] as const

test('public education and reference routes use the shared hook-free public shell', () => {
  for (const page of pages) {
    const path = `src/app/${page}/page.tsx`
    assert.ok(existsSync(path), path)
    const source = readFileSync(path, 'utf8')
    assert.match(source, /<PublicPageShell>/)
    assert.doesNotMatch(source, /<NavBar|<PublicSiteFooter|<footer|<nav/)
  }

  const shell = readFileSync('src/components/PublicPageShell.tsx', 'utf8')
  const navigation = readFileSync('src/components/PublicOnlyNav.tsx', 'utf8')
  assert.match(shell, /<PublicOnlyNav \/>/)
  assert.doesNotMatch(shell, /<NavBar/)
  assert.match(shell, /<PublicSiteFooter \/>/)
  for (const source of [shell, navigation]) {
    assert.doesNotMatch(source, /useAccount|useMarketplaceSession|gateway\/balance|useVisibilityRefresh|pollBalance/)
  }
})

test('public pages avoid unsupported reference claims and destinations', () => {
  const source = pages.map(page => readFileSync(`src/app/${page}/page.tsx`, 'utf8')).join('\n')
  for (const unsupported of [
    /100\+ APIs/i, /<1s/i, /24[- ]?hour/i, /MCP Server/i, /Webhooks/i,
    /Status Page/i, /Community/i, /Changelog/i, /Python SDK/i, /TypeScript SDK/i,
  ]) assert.doesNotMatch(source, unsupported)
})

test('primary public-page calls to action resolve to implemented routes or verified resources', () => {
  const expectedRoutes = [
    'src/app/api/agent/discover/route.ts', 'src/app/api/openapi/route.ts',
    'src/app/buyer/page.tsx', 'src/app/seller/page.tsx', 'src/app/docs/page.tsx',
    'src/app/agents/page.tsx', 'src/app/support/page.tsx',
    'src/app/dashboard/wallet/page.tsx', 'src/app/dashboard/wallet/bridge/page.tsx',
    'src/app/dashboard/solana/page.tsx',
  ]
  for (const route of expectedRoutes) assert.ok(existsSync(route), route)

  const agents = readFileSync('src/app/agents/page.tsx', 'utf8')
  assert.match(agents, /View raw discovery JSON/)
  assert.match(agents, /Open OpenAPI specification/)
  assert.match(agents, /machine data, not a product page/)
  assert.doesNotMatch(agents, />Open discovery</)
  for (const file of ['docs/agent-integration.md', 'scripts/mahshar-agent-client.mts', 'scripts/mahshar-agent-e2e.mts']) {
    assert.ok(existsSync(file), file)
    if (file.startsWith('scripts/')) assert.match(agents, new RegExp(file.replace(/[./-]/g, '\\$&')))
  }
  const support = readFileSync('src/app/support/page.tsx', 'utf8')
  assert.match(support, /mailto:support@mahshar\.xyz/)
})

test('canonical production hosts permanently redirect without widening auth origins', () => {
  const config = readFileSync('next.config.ts', 'utf8')
  const server = readFileSync('src/lib/marketplace/server.ts', 'utf8')
  const layout = readFileSync('src/app/layout.tsx', 'utf8')
  for (const host of ['www.mahshar.xyz', 'mahshar.vercel.app']) assert.ok(config.includes(host), host)
  assert.match(config, /destination: 'https:\/\/mahshar\.xyz\/:path\*'/)
  assert.equal((config.match(/permanent: true/g) ?? []).length, 2)
  assert.match(layout, /metadataBase: new URL\('https:\/\/mahshar\.xyz'\)/)
  assert.match(server, /request\.headers\.get\('origin'\) !== marketplaceOrigin\(\)/)
  assert.doesNotMatch(server, /www\.mahshar\.xyz|vercel\.app/)
})

test('shared public layout has capped desktop width and explicit overflow safeguards', () => {
  const css = readFileSync('src/app/public-pages.module.css', 'utf8')
  const shellCss = readFileSync('src/components/public-page-shell.module.css', 'utf8')
  const navigationCss = readFileSync('src/components/public-only-nav.module.css', 'utf8')
  assert.match(css, /\.container\s*\{[^}]*max-width:\s*1560px[^}]*margin:\s*0 auto/)
  assert.match(shellCss, /overflow-x:\s*clip/)
  assert.match(css, /\.codePanel\s*\{[^}]*overflow-x:\s*auto/)
  assert.match(css, /overflow-wrap:\s*anywhere/)
  for (const breakpoint of ['1180px', '800px', '520px']) assert.ok(css.includes(`max-width: ${breakpoint}`), breakpoint)
  assert.match(css, /@media \(max-width: 800px\)[\s\S]*\.heroGrid[^}]*grid-template-columns:\s*1fr/)
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.featureGrid, \.topicGrid, \.resourceGrid[^}]*grid-template-columns:\s*1fr/)
  assert.match(navigationCss, /max-width:\s*1560px/)
  assert.match(navigationCss, /@media \(max-width: 1280px\)[\s\S]*\.desktopLinks\s*\{\s*display:\s*none/)
  assert.match(navigationCss, /width:\s*min\(280px, calc\(100vw - 32px\)\)/)
})

test('homepage uses the same extracted public footer without changing its body hierarchy', () => {
  const source = readFileSync('src/app/page.tsx', 'utf8')
  assert.match(source, /<NavBar landing \/>/)
  assert.match(source, /<PublicSiteFooter \/>/)
  assert.match(source, />MAHSHAR API MARKETPLACE<\/p>/)
})
