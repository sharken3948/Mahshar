// In-process test harness for the unified-balance payout branch of transferToSeller.
// Sets PAYOUT_USE_UNIFIED_BALANCE=true in the current process only (no file writes),
// calls transferToSeller directly with a tiny self-payout, and greps captured console
// output for the [transfer-ub], [transfer-ub-ok-despite-sdk-error], and
// [transfer-ub-retry-ok] tags emitted by src/lib/gateway.ts.
//
// This does not touch any listing, purchase, or database row — verifyAndSettlePayment
// is bypassed entirely. Only Circle Gateway is exercised.

// Set feature flag BEFORE anything else. The flag is actually read per-call by
// payoutUsesUnifiedBalance(), so late-setting also works, but this is the least
// surprising order.
process.env.PAYOUT_USE_UNIFIED_BALANCE = 'true'

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const envPath = resolve(repoRoot, '.env.local')
if (!existsSync(envPath)) {
  console.error(`[test-ub-payout] .env.local not found at ${envPath}`)
  process.exit(1)
}
config({ path: envPath, override: false })

if (!process.env.PLATFORM_WALLET_ADDRESS || !process.env.PLATFORM_WALLET_PRIVATE_KEY) {
  console.error('[test-ub-payout] PLATFORM_WALLET_ADDRESS and PLATFORM_WALLET_PRIVATE_KEY must be set in .env.local')
  process.exit(1)
}
const recipient = process.env.PLATFORM_WALLET_ADDRESS as `0x${string}`

// Wrap console before importing gateway.ts so its emitted lines are captured too.
// We keep bound references to the originals for the final report so those lines
// don't get double-captured.
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

// Dynamic import so env is loaded before gateway.ts's module-load env validation runs.
// Relative path avoids depending on tsx's tsconfig-paths handling for the entry;
// transitive `@/` imports inside gateway.ts still rely on tsx's paths resolution.
const gw = await import('../../src/lib/gateway')

origLog(`[test-ub-payout] PAYOUT_USE_UNIFIED_BALANCE=${process.env.PAYOUT_USE_UNIFIED_BALANCE}`)
origLog(`[test-ub-payout] recipient (self-payout): ${recipient}`)
origLog(`[test-ub-payout] amount: 0.000900 USDC on eip155:5042002 (Arc Testnet)`)
origLog(`[test-ub-payout] calling transferToSeller(...)`)

const network: Parameters<typeof gw.transferToSeller>[3] = 'eip155:5042002'
let result: Awaited<ReturnType<typeof gw.transferToSeller>>
try {
  result = await gw.transferToSeller(recipient, 0.0009, 'test-ub-payout', network)
} catch (err: unknown) {
  origErr(`[test-ub-payout] transferToSeller THREW (should return, not throw): ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

origLog(`\n[test-ub-payout] === return value ===`)
origLog(JSON.stringify(result, null, 2))

origLog(`\n[test-ub-payout] === log grep ===`)
const tags = [
  '[transfer-ub]',
  '[transfer-ub-ok-despite-sdk-error]',
  '[transfer-ub-retry-ok]',
  // Sanity: if this fires, the flag routing is broken and we hit the legacy path.
  '[transfer]',
]
for (const tag of tags) {
  const matches = captured.filter((l) => l.includes(tag))
  origLog(`${tag}: ${matches.length} match(es)`)
  for (const m of matches) origLog('  ' + m)
}

const hitLegacy = captured.some((l) => l.includes('[transfer]') && !l.includes('[transfer-ub'))
if (hitLegacy) {
  origErr(`\n[test-ub-payout] WARN: legacy [transfer] tag fired — flag routing may be broken`)
}

if (!result.success && !result.transient) {
  origErr(`\n[test-ub-payout] result: non-transient failure`)
  process.exit(1)
}
if (result.transient) {
  origLog(`\n[test-ub-payout] result: transient — on-chain state unknown, mint may or may not have landed`)
  process.exit(0)
}
origLog(`\n[test-ub-payout] result: success`)
process.exit(0)
