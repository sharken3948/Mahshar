// Verifies the RpcTransientError classifier in src/lib/gateway.ts without
// touching the payment path. Runs three checks:
//   1. Synthetic errors — every branch of isTransientRpcError classified correctly
//   2. Transient poll against Arc testnet — nonexistent hash + short timeout
//   3. Network-layer transient — unreachable RPC URL
//
// Usage:
//   npx tsx scripts/verify-transient-classifier.mts
//
// Exit code 0 if all cases pass, 1 otherwise. No on-chain writes, no USDC spent.
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { createPublicClient, http } from 'viem'
import { defineChain } from 'viem'

const scriptDir = dirname(fileURLToPath(import.meta.url))
for (const p of [resolve(process.cwd(), '.env.local'), resolve(scriptDir, '..', '.env.local')]) {
  if (existsSync(p)) { config({ path: p, override: false }); break }
}
// gateway.ts validates these at import time. The classifier itself doesn't use
// them — provide regex-passing placeholders so we can import the real module.
if (!process.env.PLATFORM_WALLET_ADDRESS) {
  process.env.PLATFORM_WALLET_ADDRESS = '0x' + '0'.repeat(40)
}
if (!process.env.PLATFORM_WALLET_PRIVATE_KEY) {
  process.env.PLATFORM_WALLET_PRIVATE_KEY = '0x' + '0'.repeat(64)
}

const { isTransientRpcError, RpcTransientError } = await import('../src/lib/gateway')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  PASS  ${label}`) }
  else    { failed++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ---- Step 1: synthetic errors ----
console.log('\n[1] Classifier synthetic cases')

const transientCases: Array<[string, Error]> = [
  ['viem WaitForTransactionReceiptTimeoutError', Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' })],
  ['viem HttpRequestError',                       Object.assign(new Error('HTTP request failed'), { name: 'HttpRequestError' })],
  ['viem InvalidRequestRpcError',                 Object.assign(new Error('Invalid Request'),     { name: 'InvalidRequestRpcError' })],
  ['viem InternalRpcError',                       Object.assign(new Error('Internal error'),      { name: 'InternalRpcError' })],
  ['viem LimitExceededRpcError',                  Object.assign(new Error('rate limited'),        { name: 'LimitExceededRpcError' })],
  ['Arc v0.7.0 gas-cap message',                  new Error('rpc error: gas cap exceeded (30000000)')],
  ['exceeds block gas limit',                     new Error('call exceeds block gas limit')],
  ['JSON-RPC -32600 (batch cap)',                 new Error('JSON-RPC error -32600: batch too large')],
  ['JSON-RPC -32603 (internal)',                  new Error('server responded with -32603')],
  ['network ECONNRESET',                          new Error('socket error: ECONNRESET')],
  ['network fetch failed',                        new Error('fetch failed')],
  ['429 rate-limit',                              new Error('HTTP 429 Too Many Requests')],
]
for (const [label, err] of transientCases) {
  check(`transient → true: ${label}`, isTransientRpcError(err) === true)
}

const genuineCases: Array<[string, Error]> = [
  ['execution reverted',                new Error('execution reverted: insufficient balance')],
  ['nonce too low',                     new Error('nonce too low')],
  ['plain string, no keywords',         new Error('something went wrong')],
  ['revert with unrelated numeric',     new Error('reverted at 32600 bytes')], // no isolated -32600 token
]
for (const [label, err] of genuineCases) {
  check(`genuine → false: ${label}`, isTransientRpcError(err) === false)
}

// Sanity: RpcTransientError carries cause
{
  const cause = new Error('underlying')
  const w = new RpcTransientError('wrapped', cause)
  check('RpcTransientError.name === "RpcTransientError"', w.name === 'RpcTransientError')
  check('RpcTransientError.cause preserved',              w.cause === cause)
  check('RpcTransientError instanceof Error',             w instanceof Error)
}

// ---- Step 2: real Arc testnet poll, nonexistent hash, short timeout ----
console.log('\n[2] Arc testnet poll timeout (nonexistent hash, 2s budget)')
const arcTestnet = defineChain({
  id: 5042002,
  name: 'ARC Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
})
const arcClient = createPublicClient({ chain: arcTestnet, transport: http() })
const bogusHash = ('0x' + '11'.repeat(32)) as `0x${string}`
try {
  await arcClient.waitForTransactionReceipt({ hash: bogusHash, timeout: 2_000 })
  check('Arc poll threw', false, 'unexpected success — bogus hash somehow resolved')
} catch (err) {
  const name = err instanceof Error ? err.name : ''
  const msg  = err instanceof Error ? err.message.split('\n')[0] : String(err)
  check(`Arc poll classified transient (name=${name || '<none>'})`, isTransientRpcError(err), msg)
}

// ---- Step 3: unreachable RPC, single-shot HTTP-layer error ----
// A single-shot RPC call (not waitForTransactionReceipt) is required here.
// waitForTransactionReceipt polls internally and swallows per-call transport
// errors, so the outer timeout would fire first and yield the same
// WaitForTransactionReceiptTimeoutError as step 2, duplicating that test
// instead of exercising the HttpRequestError branch.
console.log('\n[3] Unreachable RPC (single-shot HTTP error)')
const deadChain = defineChain({
  id: 5042002,
  name: 'dead',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:1/'] } },
})
const deadClient = createPublicClient({
  chain: deadChain,
  transport: http('http://127.0.0.1:1/', { retryCount: 0, timeout: 1_500 }),
})
try {
  await deadClient.getBlockNumber()
  check('Dead RPC threw', false, 'unexpected success — dead port somehow answered')
} catch (err) {
  const name = err instanceof Error ? err.name : ''
  const msg  = err instanceof Error ? err.message.split('\n')[0] : String(err)
  // Assert we actually reached the HTTP-layer branch, not another timeout.
  check(`Dead RPC surfaced HTTP-layer error (name=${name || '<none>'})`, name === 'HttpRequestError', msg)
  check(`Dead RPC classified transient`, isTransientRpcError(err), msg)
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
