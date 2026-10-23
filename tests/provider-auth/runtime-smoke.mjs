// Production Next.js/Node 24 boot and unauthenticated guard checks, using synthetic config.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync, openSync, closeSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.MAHSHAR_PLAYWRIGHT_MODULE ?? 'playwright-core')
const base = 'http://127.0.0.1:3059'
const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  ENCRYPTION_KEY: 'ab'.repeat(32), MARKETPLACE_ORIGIN: base,
  NEXT_PUBLIC_SUPABASE_URL: 'https://disposable.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture', PROVIDER_OAUTH_PROFILES: '[]', GROQ_API_KEY: 'fixture',
  ARC_MAINNET_RPC_URL: 'https://rpc.disposable.invalid', PLATFORM_WALLET_PRIVATE_KEY: '0x' + 'ab'.repeat(32) }
// Production marketplaceOrigin deliberately disallows HTTP; no authenticated action is attempted here.
env.MARKETPLACE_ORIGIN = 'https://mahshar.xyz'
for (const name of Object.keys(env)) if (name.startsWith('VERCEL') || ['DATABASE_URL','DIRECT_URL','SUPABASE_DB_URL'].includes(name)) delete env[name]
const log = openSync('validation/evidence/runtime-server.log', 'w')
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3059'], { env, stdio: ['ignore', log, log] })
let browser
try {
  const deadline = Date.now() + 60000
  while (true) {
    if (server.exitCode !== null) throw new Error('Production test server exited')
    try { const response = await fetch(base + '/seller'); if (response.ok) break } catch {}
    if (Date.now() >= deadline) throw new Error('Production test server did not become ready')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  browser = await chromium.launch({ headless: true,
    ...(process.env.MAHSHAR_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MAHSHAR_CHROMIUM_EXECUTABLE } : {}) })
  const context = await browser.newContext()
  const blocked = [], errors = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue()
    blocked.push(new URL(route.request().url()).origin); return route.abort()
  })
  await context.routeWebSocket('**/*', ws => ws.close())
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/seller')
  await page.getByRole('heading', { name: 'Connect Your Wallet' }).waitFor()
  const statuses = {}
  for (const [path, method] of [['/api/apis','POST'],['/api/provider-oauth/synthetic','GET']]) {
    const result = await context.request.fetch(base + path, { method, headers: { origin: env.MARKETPLACE_ORIGIN } })
    statuses[method + ' ' + path] = result.status()
    assert.equal(result.status(), 401)
  }
  assert.deepEqual(errors, [])
  await page.screenshot({ path: 'validation/evidence/runtime-seller.png', fullPage: true })
  writeFileSync('validation/evidence/runtime-smoke.json', JSON.stringify({ node: process.version, seller: 'rendered',
    unauthenticated_guards: statuses, pageErrors: errors, blockedExternalOrigins: [...new Set(blocked)] }, null, 2))
  console.log('PASS Node 24 production Next runtime, Seller rendering, and unauthenticated listing/OAuth guards')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve))
  closeSync(log)
}
