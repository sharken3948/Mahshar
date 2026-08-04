// Stress harness for the unified-balance payout branch of transferToSeller.
// Runs N sequential self-payouts on Arc Testnet, capturing per-run console output
// and reporting which log tags fired. Aborts cleanly if Gateway balance would fall
// below the per-call threshold. Exits non-zero if ANY run returns a non-transient
// failure — that's the specific signal we're testing for.
//
// Does not touch any listing, purchase, or database row.

process.env.PAYOUT_USE_UNIFIED_BALANCE = 'true'

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// --- CLI ---
const countArg = process.argv.find((a) => a.startsWith('--count='))
const RUN_COUNT = countArg ? parseInt(countArg.slice('--count='.length), 10) : 25
if (!Number.isFinite(RUN_COUNT) || RUN_COUNT < 1) {
  console.error(`[stress-ub] invalid --count value: ${countArg}`)
  process.exit(1)
}

const AMOUNT_USD = 0.0009
const DELAY_MS = 2500
// Empirically each Arc→Arc self-payout consumes ~0.017 USDC (amount + Circle
// Gateway fee + Arc mint gas paid in USDC). Set the per-call floor higher than
// the nominal amount so we abort before the SDK's own allocator would fail.
const MIN_PREFLIGHT_BALANCE = 0.02

// --- env setup ---
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const envPath = resolve(repoRoot, '.env.local')
if (!existsSync(envPath)) {
  console.error(`[stress-ub] .env.local not found at ${envPath}`)
  process.exit(1)
}
config({ path: envPath, override: false })

if (!process.env.PLATFORM_WALLET_ADDRESS || !process.env.PLATFORM_WALLET_PRIVATE_KEY) {
  console.error('[stress-ub] PLATFORM_WALLET_ADDRESS and PLATFORM_WALLET_PRIVATE_KEY must be set in .env.local')
  process.exit(1)
}
const recipient = process.env.PLATFORM_WALLET_ADDRESS as `0x${string}`

// --- console capture (wraps BEFORE gateway.ts is imported) ---
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

// --- helpers ---
async function fetchArcAvailable(): Promise<number> {
  const res = await fetch('https://gateway-api-testnet.circle.com/v1/balances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: recipient, domain: 26 }] }),
  })
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`)
  const data = (await res.json()) as { balances?: Array<{ balance: string }> }
  return parseFloat(data.balances?.[0]?.balance ?? '0')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const TAGS = [
  '[transfer-ub]',
  '[transfer-ub-ok-despite-sdk-error]',
  '[transfer-ub-retry-ok]',
  '[transfer]', // sanity: fires only if the flag routing broke
] as const
type Tag = (typeof TAGS)[number]

function extractTxHash(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(/tx=(0x[a-fA-F0-9]{64})/)
    if (m) return m[1]
  }
  return null
}

// Dynamic import so env is loaded before gateway.ts's module-load validation runs.
const gw = await import('../../src/lib/gateway')
type TransferResult = Awaited<ReturnType<typeof gw.transferToSeller>>
const network: Parameters<typeof gw.transferToSeller>[3] = 'eip155:5042002'

interface RunRecord {
  runNum: number
  ok: boolean
  transient: boolean
  error?: string
  tagsFired: Tag[]
  txHash: string | null
  elapsedMs: number
}

// --- pre-flight ---
origLog(`[stress-ub] plan: ${RUN_COUNT} runs × ${AMOUNT_USD} USDC on Arc Testnet (self-payout)`)
origLog(`[stress-ub] delay between runs: ${DELAY_MS} ms`)
origLog(`[stress-ub] recipient (self): ${recipient}`)

let preBalance: number
try {
  preBalance = await fetchArcAvailable()
} catch (e) {
  origErr(`[stress-ub] pre-flight balance query failed: ${(e as Error).message}`)
  process.exit(1)
}
origLog(`[stress-ub] pre-flight Arc_Testnet available: ${preBalance.toFixed(6)} USDC`)
const nominalNeed = RUN_COUNT * AMOUNT_USD
origLog(`[stress-ub] nominal transfer total (excl fees): ${nominalNeed.toFixed(6)} USDC`)
origLog(`[stress-ub] per-call floor (below which we early-stop): ${MIN_PREFLIGHT_BALANCE.toFixed(6)} USDC`)

if (preBalance < MIN_PREFLIGHT_BALANCE) {
  origErr(`[stress-ub] balance below single-call floor — nothing to test; aborting`)
  process.exit(1)
}

// --- signal handling ---
let interrupted = false
process.on('SIGINT', () => {
  origErr(`[stress-ub] SIGINT received — will finish current run and print summary`)
  interrupted = true
})

// --- run loop ---
const records: RunRecord[] = []
let earlyStop: string | null = null

for (let i = 1; i <= RUN_COUNT; i++) {
  if (interrupted) {
    earlyStop = `SIGINT before run ${i}`
    break
  }
  let avail: number
  try {
    avail = await fetchArcAvailable()
  } catch (e) {
    earlyStop = `balance query failed pre-run ${i}: ${(e as Error).message}`
    origErr(`[stress-ub] ${earlyStop}`)
    break
  }
  if (avail < MIN_PREFLIGHT_BALANCE) {
    earlyStop = `available ${avail.toFixed(6)} < ${MIN_PREFLIGHT_BALANCE.toFixed(6)} before run ${i}`
    origLog(`[stress-ub] ${earlyStop}`)
    break
  }

  origLog(`\n[stress-ub] --- run ${i}/${RUN_COUNT} (avail ${avail.toFixed(6)}) ---`)
  const startIdx = captured.length
  const startTime = Date.now()
  let result: TransferResult
  try {
    result = await gw.transferToSeller(recipient, AMOUNT_USD, `stress-${i}`, network)
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
  records.push(rec)
  origLog(
    `[stress-ub] run ${i}: success=${rec.ok} transient=${rec.transient} tags=${tagsFired.join(',') || 'none'} tx=${txHash ?? 'n/a'} elapsed=${elapsedMs}ms` +
      (rec.error ? ` error=${rec.error.slice(0, 200)}` : ''),
  )

  if (i < RUN_COUNT) await sleep(DELAY_MS)
}

// --- summary ---
const total = records.length
const successCount = records.filter((r) => r.ok).length
const transientCount = records.filter((r) => !r.ok && r.transient).length
const failureCount = records.filter((r) => !r.ok && !r.transient).length
const tagCounts: Record<Tag, number> = { '[transfer-ub]': 0, '[transfer-ub-ok-despite-sdk-error]': 0, '[transfer-ub-retry-ok]': 0, '[transfer]': 0 }
for (const r of records) for (const t of r.tagsFired) tagCounts[t] += 1

origLog(`\n[stress-ub] === summary ===`)
origLog(`runs completed:  ${total} / ${RUN_COUNT}${earlyStop ? ' (early stop: ' + earlyStop + ')' : ''}`)
origLog(`  success:       ${successCount}`)
origLog(`  transient:     ${transientCount}`)
origLog(`  failure:       ${failureCount}`)
origLog(`tag firings across all runs:`)
for (const t of TAGS) origLog(`  ${t.padEnd(38)} ${tagCounts[t]}`)

const legacyOnly = records.filter(
  (r) => r.tagsFired.includes('[transfer]') && !r.tagsFired.some((t) => t.startsWith('[transfer-ub')),
)
if (legacyOnly.length > 0) {
  origErr(`[stress-ub] WARN: ${legacyOnly.length} run(s) hit legacy [transfer] tag alone — flag routing may be broken`)
}

try {
  const postBalance = await fetchArcAvailable()
  const delta = postBalance - preBalance
  origLog(`\n[stress-ub] post-run Arc_Testnet available: ${postBalance.toFixed(6)} USDC (delta ${delta.toFixed(6)})`)
  if (total > 0) origLog(`[stress-ub] observed cost per run: ${(-delta / total).toFixed(6)} USDC`)
} catch (e) {
  origErr(`[stress-ub] post-run balance query failed: ${(e as Error).message}`)
}

if (failureCount > 0) {
  origErr(`\n[stress-ub] FAILED: ${failureCount} non-transient failure(s) — this is the regression signal we care about`)
  process.exit(1)
}
process.exit(0)
