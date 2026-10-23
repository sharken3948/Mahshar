/** Test-only HTTP adapter: actual Seller handlers; synthetic wallet, DB, AI and outbound boundaries. */
import { boundary, resetBoundary } from './register.mjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const http = require('node:http')
const fs = require('node:fs')
const fixture = require('../marketplace/fixtures.ts')
const { NextRequest } = require('next/server')
const listingRoutes = require('../../src/app/api/apis/route.ts')
const ownerRoutes = require('../../src/app/api/apis/[id]/route.ts')
const verifyRoutes = require('../../src/app/api/apis/[id]/verify/route.ts')
const scoreRoutes = require('../../src/app/api/ai/score/route.ts')

globalThis.fetch = async () => { throw new Error('Unmocked network forbidden in browser fixture') }
const requests = []
let session
function resetFixture() {
  fixture.reset(); resetBoundary(); requests.length = 0
  session = fixture.sessionHeaders()
  boundary.respond = () => Response.json({ result: 'safe-browser-result' })
}
resetFixture()
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/fixture/reset') { resetFixture(); res.end('{}'); return }
    if (path === '/fixture/evidence') {
      // This synthetic-only endpoint is never included in the application.
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ requests, listings: fixture.state.tables.api_listings.map(row => ({
        id: row.id, auth_type: row.auth_type, is_active: row.is_active, verified_at: row.verified_at,
      })), settled: fixture.state.settled, outbound: boundary.requests.map(call => ({ url: call.url, method: call.init.method })) })); return
    }
    if (path === '/browser.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(process.env.MAHSHAR_BROWSER_BUNDLE)); return }
    if (path === '/browser.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(process.env.MAHSHAR_BROWSER_BUNDLE.replace(/\.js$/, '.css'))); return }
    if (!path.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/browser.css"></head><body><div id="root"></div><script src="/browser.js"></script></body></html>'); return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const headers = { ...session, 'content-type': 'application/json',
      cookie: session.cookie + (req.headers.cookie ? '; ' + req.headers.cookie : '') }
    if (req.headers['x-browser-fixture-proof']) Object.assign(headers,
      await fixture.operationHeaders(req.url, req.method, body ? JSON.parse(body) : {}))
    const request = new NextRequest(fixture.origin + req.url, { method: req.method, headers,
      ...(['GET', 'HEAD'].includes(req.method) ? {} : { body }) })
    const match = path.match(/^\/api\/apis\/([^/]+)(?:\/(verify))?$/)
    const context = { params: Promise.resolve({ id: match?.[1] }) }
    const routes = path === '/api/apis' ? listingRoutes : path === '/api/ai/score' ? scoreRoutes
      : match?.[2] === 'verify' ? verifyRoutes : ownerRoutes
    const result = await routes[req.method](request, context)
    const responseBody = await result.text()
    requests.push({ path, method: req.method, status: result.status, bytes: Buffer.byteLength(body),
      sensitive: Boolean(req.headers['x-browser-fixture-proof']) })
    res.statusCode = result.status
    for (const [name, value] of result.headers) {
      if (name === 'location') { const target = new URL(value); res.setHeader(name, target.pathname + target.search) }
      else res.setHeader(name, value)
    }
    res.end(responseBody)
  } catch (error) {
    console.error(error)
    res.statusCode = 500; res.end(JSON.stringify({ error: 'Browser fixture failed' }))
  }
})
server.listen(Number(process.env.MAHSHAR_BROWSER_PORT ?? 3057), '127.0.0.1', () => console.log('Browser fixture ready'))
