// After an isolated production build using http://127.0.0.1:54321 and dummy keys.
// Only the optional ARC_MAINNET_RPC_URL may point outside localhost (read calls).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

const dbCalls = []
const db = createServer((req, res) => {
  dbCalls.push(`${req.method} ${req.url}`)
  if (req.method !== 'POST' || req.url !== '/rest/v1/rpc/mahshar_take_rate_limit') {
    res.writeHead(500); res.end('Unexpected database access'); return
  }
  req.resume()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify([{ allowed: true, remaining: 29, retry_after_seconds: 60 }]))
})
// Fail if another local service owns this port; never use an existing database.
db.listen(54321, '127.0.0.1')
await once(db, 'listening')
const port = 33219
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'isolated-build-anon', SUPABASE_SERVICE_ROLE_KEY: 'isolated-build-service',
    MARKETPLACE_ORIGIN: 'https://mahshar.xyz' }, stdio: ['ignore', 'pipe', 'pipe'],
})
// Drain logs without printing provider/configuration details on a failed run.
server.stdout.resume(); server.stderr.resume()
const base = `http://127.0.0.1:${port}/api/agent/identity`
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error('Local Next server exited')
    try { ready = (await fetch(base, { signal: AbortSignal.timeout(1000) })).status === 200 } catch {}
    if (ready) break
    await sleep(500)
  }
  assert.ok(ready, 'local production server becomes ready')
  const descriptor = await fetch(base)
  assert.equal(descriptor.headers.get('cache-control'), 'no-store')
  assert.equal((await descriptor.json()).persistent_binding_supported, false)
  assert.equal(dbCalls.length, 0)
  assert.equal((await fetch(`${base}?agent_id=0`)).status, 400)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await fetch(base, { method })).status, 405)
  }
  assert.equal(dbCalls.length, 0)
  const query = new URLSearchParams({ chain_id: '5042',
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agent_id: '0' })
  const lookup = await fetch(`${base}?${query}`)
  assert.equal(lookup.status, process.env.ARC_MAINNET_RPC_URL ? 200 : 503)
  const body = await lookup.json()
  assert.equal(body.requester_authenticated, false)
  assert.equal(body.binding_created, false)
  if (process.env.ARC_MAINNET_RPC_URL) {
    assert.equal(body.agent_id, '0')
    assert.equal(body.chain_id, 5042)
    assert.match(body.owner, /^0x[0-9a-f]{40}$/)
    query.set('agent_id', ((1n << 256n) - 1n).toString())
    const absent = await fetch(`${base}?${query}`)
    assert.equal(absent.status, 404)
    assert.equal((await absent.json()).error, 'agent_not_found')
  }
  assert.deepEqual(dbCalls, Array(process.env.ARC_MAINNET_RPC_URL ? 2 : 1).fill('POST /rest/v1/rpc/mahshar_take_rate_limit'))
  console.log(JSON.stringify({ production_http_smoke: 'passed', descriptor: 200, invalid_query: 400,
    mutation_methods: 405, lookup: lookup.status, database_operations: 'isolated rate-limit fixture only' }))
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), sleep(5000)])
  if (server.exitCode === null) server.kill('SIGKILL')
  db.closeAllConnections(); await new Promise(resolve => db.close(resolve))
}
