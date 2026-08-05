// Comprehensive test of the unified-balance payout path in src/lib/gateway.ts.
// Exercises four scenarios that cover every reachable branch of the recovery flow
// in transferViaUnifiedBalance, using two mechanisms for fault injection:
//
//   - Chain RPC failures via inline HTTP proxies (self-hosted in this process, no
//     external services): controls the URL passed to the SDK adapter and to the
//     recovery client via PAYOUT_ADAPTER_RPC_URL / PAYOUT_RECOVERY_RPC_URL, the
//     env hooks added to gateway.ts specifically for this test surface.
//
//   - Circle API failures via global fetch monkeypatch (scoped to /v1/transfer),
//     used only for the pre-mint failure scenario. Blocking sendRawTransaction on
//     the chain proxy would have hit the same code branch but would leave the
//     Circle-side attestation issued and unminted (a ~0.017 USDC/run drain that
//     expires in 10 min and requires an out-of-band Circle refund to reclaim).
//     Blocking /v1/transfer at fetch-time fails BEFORE attestation issuance, so
//     no funds move.
//
// Scenarios:
//   A — Baseline (no injection). Confirms happy path — [transfer-ub] fires.
//   B — SDK receipt poll fails (proxy blocks eth_getTransactionReceipt) but the
//       recovery client on direct RPC finds the mint on chain. Expects
//       [transfer-ub-ok-despite-sdk-error].
//   C-pre-mint — Circle /v1/transfer POST is blocked. spend() throws BEFORE any
//       mint tx is submitted, capture.hash never sets, my code returns at the
//       !capturedHash guard. Expects success:false with no [transfer-ub*] tag.
//   D — Both the SDK adapter and the recovery client route through a proxy that
//       blocks eth_getTransactionReceipt AND eth_getTransactionByHash. Mint lands
//       on chain, but from the code's perspective the receipt poll fails, then
//       the getTransaction existence probe also fails transiently (HttpRequestError
//       is not TransactionNotFoundError), so the code returns transient:true
//       without calling config.retry.
//
// NOT COVERED: the config.retry branch itself ([transfer-ub-retry-ok]). Reaching it
// requires convincing the code that a mint tx was submitted (hash captured) but
// doesn't exist on chain — a state that Arc Testnet's sub-second finality does not
// produce organically without either faking sendRawTransaction responses or
// refactoring gateway.ts for injection. Correctness of the retry branch is
// enforced ON CHAIN by the GatewayMinter contract's TransferSpecHashUsed replay
// guard (verified in Step 2 investigation): a double-mint attempt against an
// already-consumed attestation reverts with that custom error, so incorrect
// local branching cannot cause double-spend regardless of how our code decides
// to retry.

process.env.PAYOUT_USE_UNIFIED_BALANCE = 'true'

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

// --- env setup ---
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const envPath = resolve(repoRoot, '.env.local')
if (!existsSync(envPath)) {
  console.error(`[comp-ub] .env.local not found at ${envPath}`)
  process.exit(1)
}
config({ path: envPath, override: false })

if (!process.env.PLATFORM_WALLET_ADDRESS || !process.env.PLATFORM_WALLET_PRIVATE_KEY) {
  console.error('[comp-ub] PLATFORM_WALLET_ADDRESS and PLATFORM_WALLET_PRIVATE_KEY required')
  process.exit(1)
}
const recipient = process.env.PLATFORM_WALLET_ADDRESS as `0x${string}`

// --- console capture (wraps BEFORE gateway.ts import) ---
const captured: string[] = []
const origLog = console.log.bind(console)
const origErr = console.error.bind(console)
const stringify = (a: unknown): string =>
  typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()
console.log = (...args: unknown[]) => {
  captured.push(args.map(stringify).join(' '))
  origLog(...args)
}
console.error = (...args: unknown[]) => {
  captured.push('[stderr] ' + args.map(stringify).join(' '))
  origErr(...args)
}

// --- constants ---
const AMOUNT_USD = 0.0009
const NETWORK = 'eip155:5042002' as const
const ARC_UPSTREAM = 'https://rpc.testnet.arc.network'
const CIRCLE_TESTNET_HOST = 'gateway-api-testnet.circle.com'
const DELAY_BETWEEN_RUNS_MS = 2000
const DELAY_BETWEEN_SCENARIOS_MS = 3000

// --- inline RPC proxy ---
interface ProxyState {
  server: Server
  port: number
  url: string
  blockMethods: Set<string>
}

function methodsOf(body: string): string[] {
  try {
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((r) => (typeof (r as { method?: unknown }).method === 'string' ? (r as { method: string }).method : ''))
  } catch {
    return []
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function startProxy(port: number, blockMethods: Set<string>): Promise<ProxyState> {
  const server = createServer((req, res) => {
    handle(req, res, blockMethods).catch((err) => {
      origErr(`[proxy:${port}] handler error:`, err instanceof Error ? err.message : String(err))
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
  return { server, port, url: `http://127.0.0.1:${port}`, blockMethods }
}

async function handle(req: IncomingMessage, res: ServerResponse, blockMethods: Set<string>): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const body = await readBody(req)
  const methods = methodsOf(body)
  if (methods.some((m) => blockMethods.has(m))) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `injected: ${methods.filter((m) => blockMethods.has(m)).join(',')}` }))
    return
  }
  try {
    const upstream = await fetch(ARC_UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const text = await upstream.text()
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(text)
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `upstream failed: ${err instanceof Error ? err.message : String(err)}` }))
  }
}

function stopProxy(p: ProxyState): Promise<void> {
  return new Promise((resolve) => p.server.close(() => resolve()))
}

// --- Circle API fetch monkeypatch (for scenario C-pre-mint) ---
const origFetch = globalThis.fetch
let circleTransferBlocked = false

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (circleTransferBlocked && url.includes(CIRCLE_TESTNET_HOST) && url.includes('/v1/transfer')) {
    return new Response(JSON.stringify({ code: -1, message: 'injected: /v1/transfer blocked' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
  return origFetch(input, init)
}) as typeof fetch

// --- balance helper ---
async function fetchArcAvailable(): Promise<number> {
  const res = await origFetch(`https://${CIRCLE_TESTNET_HOST}/v1/balances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: recipient, domain: 26 }] }),
  })
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`)
  const data = (await res.json()) as { balances?: Array<{ balance: string }> }
  return parseFloat(data.balances?.[0]?.balance ?? '0')
}

// --- dynamic import gateway (after env, console wrap, fetch monkeypatch) ---
const gw = await import('../../src/lib/gateway')
type TransferResult = Awaited<ReturnType<typeof gw.transferToSeller>>
const gwNetwork: Parameters<typeof gw.transferToSeller>[3] = NETWORK

const TAGS = [
  '[transfer-ub]',
  '[transfer-ub-ok-despite-sdk-error]',
  '[transfer-ub-retry-ok]',
  '[transfer]', // legacy path sanity
] as const
type Tag = (typeof TAGS)[number]

function extractTxHash(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(/tx=(0x[a-fA-F0-9]{64})/)
    if (m) return m[1]
  }
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface RunRecord {
  runNum: number
  ok: boolean
  transient: boolean
  error?: string
  tagsFired: Tag[]
  txHash: string | null
  elapsedMs: number
}

interface ExpectedOutcome {
  success: boolean
  transient?: boolean
  requiredTags: Tag[] // tags that MUST fire
  forbiddenTags: Tag[] // tags that must NOT fire
}

interface ScenarioResult {
  name: string
  runs: RunRecord[]
  expected: ExpectedOutcome
  passed: boolean
  failureReason?: string
}

interface ScenarioSpec {
  name: string
  count: number
  expected: ExpectedOutcome
  setup: () => Promise<void> | void
  teardown: () => Promise<void> | void
  minBalancePerRun: number // pre-flight per-run threshold
}

async function runScenario(spec: ScenarioSpec): Promise<ScenarioResult> {
  origLog(`\n[comp-ub] ============================================`)
  origLog(`[comp-ub] SCENARIO: ${spec.name}`)
  origLog(`[comp-ub] runs: ${spec.count}, expected: ${JSON.stringify(spec.expected)}`)
  origLog(`[comp-ub] ============================================`)
  await spec.setup()
  const runs: RunRecord[] = []
  try {
    for (let i = 1; i <= spec.count; i++) {
      const avail = await fetchArcAvailable()
      if (avail < spec.minBalancePerRun) {
        origErr(`[comp-ub] insufficient balance ${avail} < ${spec.minBalancePerRun} — stopping scenario early`)
        break
      }
      origLog(`\n[comp-ub] ${spec.name} — run ${i}/${spec.count} (avail ${avail.toFixed(6)})`)
      const startIdx = captured.length
      const startTime = Date.now()
      let result: TransferResult
      try {
        result = await gw.transferToSeller(recipient, AMOUNT_USD, `comp-${spec.name.split(' ')[0]}-${i}`, gwNetwork)
      } catch (err: unknown) {
        result = { success: false, error: `THREW: ${err instanceof Error ? err.message : String(err)}` }
      }
      const elapsedMs = Date.now() - startTime
      const runLines = captured.slice(startIdx)
      const tagsFired = TAGS.filter((t) => runLines.some((l) => l.includes(t)))
      const txHash = extractTxHash(runLines)
      const rec: RunRecord = {
        runNum: i,
        ok: !!result.success,
        transient: !!result.transient,
        error: result.error,
        tagsFired,
        txHash,
        elapsedMs,
      }
      runs.push(rec)
      origLog(
        `[comp-ub] run ${i}: success=${rec.ok} transient=${rec.transient} tags=${tagsFired.join(',') || 'none'} tx=${txHash ?? 'n/a'} elapsed=${elapsedMs}ms` +
          (rec.error ? ` error=${rec.error.slice(0, 160)}` : ''),
      )
      if (i < spec.count) await sleep(DELAY_BETWEEN_RUNS_MS)
    }
  } finally {
    await spec.teardown()
  }

  // Assess against expected outcome
  const { passed, failureReason } = assessRuns(runs, spec.expected)
  return { name: spec.name, runs, expected: spec.expected, passed, failureReason }
}

function assessRuns(runs: RunRecord[], expected: ExpectedOutcome): { passed: boolean; failureReason?: string } {
  if (runs.length === 0) return { passed: false, failureReason: 'no runs completed' }
  for (const r of runs) {
    if (r.ok !== expected.success) {
      return { passed: false, failureReason: `run ${r.runNum}: success=${r.ok} expected ${expected.success}` }
    }
    if (expected.transient !== undefined && r.transient !== expected.transient) {
      return { passed: false, failureReason: `run ${r.runNum}: transient=${r.transient} expected ${expected.transient}` }
    }
    for (const t of expected.requiredTags) {
      if (!r.tagsFired.includes(t)) {
        return { passed: false, failureReason: `run ${r.runNum}: missing required tag ${t}` }
      }
    }
    for (const t of expected.forbiddenTags) {
      if (r.tagsFired.includes(t)) {
        return { passed: false, failureReason: `run ${r.runNum}: forbidden tag ${t} fired` }
      }
    }
  }
  return { passed: true }
}

// --- proxies (started once, reused per scenario) ---
origLog(`[comp-ub] starting inline proxies...`)
const proxyReceiptOnly = await startProxy(18546, new Set(['eth_getTransactionReceipt', 'eth_getTransactionByHash']))
origLog(`[comp-ub] proxy on ${proxyReceiptOnly.url}: blocks ${[...proxyReceiptOnly.blockMethods].join(', ')}`)

// --- pre-flight ---
const preBalance = await fetchArcAvailable()
origLog(`\n[comp-ub] pre-flight Arc_Testnet available: ${preBalance.toFixed(6)} USDC`)
origLog(`[comp-ub] recipient (self-payout): ${recipient}`)

// --- scenario specifications ---
const scenarios: ScenarioSpec[] = [
  {
    name: 'A - baseline',
    count: 5,
    expected: {
      success: true,
      transient: false,
      requiredTags: ['[transfer-ub]'],
      forbiddenTags: ['[transfer]', '[transfer-ub-ok-despite-sdk-error]', '[transfer-ub-retry-ok]'],
    },
    minBalancePerRun: 0.005,
    setup: () => {
      delete process.env.PAYOUT_ADAPTER_RPC_URL
      delete process.env.PAYOUT_RECOVERY_RPC_URL
      circleTransferBlocked = false
    },
    teardown: () => {},
  },
  {
    name: 'B - SDK poll fails, recovery succeeds',
    count: 3,
    expected: {
      success: true,
      transient: false,
      // The SDK's mint step throws AFTER the tx lands, so my code's recovery re-poll
      // (on direct RPC) confirms success and [transfer-ub-ok-despite-sdk-error] fires.
      // The initial [transfer-ub] happy-path tag does NOT fire on this branch.
      requiredTags: ['[transfer-ub-ok-despite-sdk-error]'],
      forbiddenTags: ['[transfer]', '[transfer-ub]', '[transfer-ub-retry-ok]'],
    },
    minBalancePerRun: 0.005,
    setup: () => {
      process.env.PAYOUT_ADAPTER_RPC_URL = proxyReceiptOnly.url
      delete process.env.PAYOUT_RECOVERY_RPC_URL // recovery uses direct RPC
      circleTransferBlocked = false
    },
    teardown: () => {
      delete process.env.PAYOUT_ADAPTER_RPC_URL
    },
  },
  {
    name: 'C-pre-mint - Circle /v1/transfer blocked',
    count: 2,
    expected: {
      success: false,
      transient: false,
      // Failure happens BEFORE mint step; capture.hash never sets; my code returns
      // at the !capturedHash guard without emitting any [transfer-ub*] tag.
      requiredTags: [],
      forbiddenTags: ['[transfer]', '[transfer-ub]', '[transfer-ub-ok-despite-sdk-error]', '[transfer-ub-retry-ok]'],
    },
    minBalancePerRun: 0.001, // no fund movement expected, minimal check
    setup: () => {
      delete process.env.PAYOUT_ADAPTER_RPC_URL
      delete process.env.PAYOUT_RECOVERY_RPC_URL
      circleTransferBlocked = true
    },
    teardown: () => {
      circleTransferBlocked = false
    },
  },
  {
    name: 'D - transient with no resolution',
    count: 1,
    expected: {
      success: false,
      transient: true,
      // Mint lands on chain (sendRawTransaction is NOT blocked), but adapter poll
      // fails (getTransactionReceipt blocked), recovery poll also fails (same proxy),
      // and the existence probe (getTransactionByHash) also fails with HttpRequestError
      // — which is not TransactionNotFoundError, so my code returns transient:true.
      requiredTags: [],
      forbiddenTags: ['[transfer]', '[transfer-ub]', '[transfer-ub-ok-despite-sdk-error]', '[transfer-ub-retry-ok]'],
    },
    minBalancePerRun: 0.005,
    setup: () => {
      process.env.PAYOUT_ADAPTER_RPC_URL = proxyReceiptOnly.url
      process.env.PAYOUT_RECOVERY_RPC_URL = proxyReceiptOnly.url
      circleTransferBlocked = false
    },
    teardown: () => {
      delete process.env.PAYOUT_ADAPTER_RPC_URL
      delete process.env.PAYOUT_RECOVERY_RPC_URL
    },
  },
]

// --- run scenarios ---
const results: ScenarioResult[] = []
let sigintReceived = false
process.on('SIGINT', () => {
  origErr(`[comp-ub] SIGINT — finishing current scenario then stopping`)
  sigintReceived = true
})

for (const spec of scenarios) {
  if (sigintReceived) break
  results.push(await runScenario(spec))
  if (spec !== scenarios[scenarios.length - 1]) await sleep(DELAY_BETWEEN_SCENARIOS_MS)
}

// --- cleanup ---
await stopProxy(proxyReceiptOnly)
globalThis.fetch = origFetch

// --- summary ---
const postBalance = await fetchArcAvailable().catch(() => -1)

origLog(`\n[comp-ub] ============================================`)
origLog(`[comp-ub] SUMMARY`)
origLog(`[comp-ub] ============================================`)
origLog(`pre-flight balance:  ${preBalance.toFixed(6)} USDC`)
if (postBalance >= 0) {
  origLog(`post-run balance:    ${postBalance.toFixed(6)} USDC (delta ${(postBalance - preBalance).toFixed(6)})`)
}
origLog(``)
origLog(`scenario                                             runs  pass  ok   err  trans  tags`)
for (const r of results) {
  const okCount = r.runs.filter((x) => x.ok).length
  const errCount = r.runs.filter((x) => !x.ok && !x.transient).length
  const transCount = r.runs.filter((x) => !x.ok && x.transient).length
  const tagCounts = TAGS.map((t) => {
    const n = r.runs.reduce((acc, x) => acc + (x.tagsFired.includes(t) ? 1 : 0), 0)
    return n > 0 ? `${t.replace('[transfer-ub', '[ub').replace('[transfer', '[legacy').replace(']', '')}]:${n}` : null
  }).filter(Boolean).join(' ')
  const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
  origLog(`${pad(r.name, 52)} ${pad(String(r.runs.length), 5)} ${pad(r.passed ? 'PASS' : 'FAIL', 5)} ${pad(String(okCount), 4)} ${pad(String(errCount), 4)} ${pad(String(transCount), 6)} ${tagCounts}`)
  if (!r.passed) origLog(`  reason: ${r.failureReason}`)
}

const anyFailed = results.some((r) => !r.passed)
if (anyFailed) {
  origErr(`\n[comp-ub] FAILED: at least one scenario did not match expected outcome`)
  process.exit(1)
}
origLog(`\n[comp-ub] all scenarios matched expectations`)
process.exit(0)
