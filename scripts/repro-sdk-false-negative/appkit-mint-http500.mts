import { config } from 'dotenv'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AppKit } from '@circle-fin/app-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')

const envCandidates = [
  resolve(process.cwd(), '.env.local'),
  resolve(repoRoot, '.env.local'),
]
let loadedFrom: string | null = null
for (const p of envCandidates) {
  if (!existsSync(p)) continue
  const r = config({ path: p, override: true })
  if (r.error) continue
  loadedFrom = p
  break
}
if (loadedFrom) console.log(`[repro-appkit-http500] loaded env from ${loadedFrom}`)

const pkgPath = resolve(repoRoot, 'node_modules/@circle-fin/app-kit/package.json')
const sdkVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
console.log(`[repro-appkit-http500] @circle-fin/app-kit version: ${sdkVersion}`)

const PK = (process.env.PLATFORM_WALLET_PK ?? process.env.PLATFORM_WALLET_PRIVATE_KEY) as Hex | undefined
if (!PK || !/^0x[a-fA-F0-9]{64}$/.test(PK)) {
  console.error('[repro-appkit-http500] neither PLATFORM_WALLET_PK nor PLATFORM_WALLET_PRIVATE_KEY is set to a valid key (0x + 64 hex chars)')
  process.exit(1)
}

const PROXY_URL = 'http://127.0.0.1:8546'
const DIRECT_RPC = 'https://rpc.testnet.arc.network'
const RECIPIENT = '0x052650D1764406d702252B20B2294346A594A1ef' as const
const AMOUNT = '0.0009'
const ARC_CHAIN_ID = 5042002

const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'ARC Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [DIRECT_RPC] } },
  testnet: true,
})

function dumpError(label: string, err: unknown, depth = 0): void {
  const indent = '  '.repeat(depth)
  if (err instanceof Error) {
    console.log(`${indent}[${label}] name=${err.name} ctor=${err.constructor.name}`)
    const firstLine = err.message.split('\n', 1)[0]
    console.log(`${indent}[${label}] message: ${firstLine.slice(0, 220)}`)
    const props = Object.getOwnPropertyNames(err).filter(p => !['name', 'message', 'stack', 'cause'].includes(p))
    for (const p of props) {
      const v = (err as unknown as Record<string, unknown>)[p]
      const preview =
        typeof v === 'string' ? v.slice(0, 80)
        : typeof v === 'number' || typeof v === 'boolean' ? String(v)
        : v && typeof v === 'object' ? `[${(v as object).constructor.name}]`
        : String(v)
      console.log(`${indent}[${label}] .${p} = ${preview}`)
    }
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined && depth < 5) {
      dumpError(`${label}.cause`, cause, depth + 1)
    }
  } else if (err && typeof err === 'object') {
    const keys = Object.getOwnPropertyNames(err).slice(0, 10)
    console.log(`${indent}[${label}] object keys: ${keys.join(', ')}`)
    for (const k of keys) {
      const v = (err as Record<string, unknown>)[k]
      if (v && typeof v === 'object' && depth < 5) dumpError(`${label}.${k}`, v, depth + 1)
      else console.log(`${indent}  [${label}.${k}] = ${String(v).slice(0, 100)}`)
    }
  } else {
    console.log(`${indent}[${label}] ${typeof err}: ${String(err).slice(0, 200)}`)
  }
}

function collectStrings(v: unknown, acc: string[], seen = new WeakSet<object>()): void {
  if (typeof v === 'string') { acc.push(v); return }
  if (!v || typeof v !== 'object') return
  if (seen.has(v as object)) return
  seen.add(v as object)
  for (const k of Object.getOwnPropertyNames(v)) {
    try { collectStrings((v as Record<string, unknown>)[k], acc, seen) } catch {}
  }
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(PK!)
  console.log(`[repro-appkit-http500] wallet: ${account.address}`)
  console.log(`[repro-appkit-http500] proxy: ${PROXY_URL} (must be running: tsx scripts/repro-sdk-false-negative/proxy.mts)`)
  console.log(`[repro-appkit-http500] direct RPC (verification): ${DIRECT_RPC}`)

  const adapter = createViemAdapterFromPrivateKey({
    privateKey: PK!,
    getPublicClient: ({ chain }) => createPublicClient({
      chain: chain.id === ARC_CHAIN_ID ? arcTestnet : chain,
      transport: http(PROXY_URL),
    }),
    getWalletClient: ({ chain, account: acc }) => createWalletClient({
      chain: chain.id === ARC_CHAIN_ID ? arcTestnet : chain,
      account: acc,
      transport: http(PROXY_URL),
    }),
  })

  const appKit = new AppKit()

  console.log(`[repro-appkit-http500] fetching unified balance for ${account.address} ...`)
  const balances = await appKit.unifiedBalance.getBalances({
    token: 'USDC',
    sources: { address: account.address, chains: 'Arc_Testnet' },
  })
  console.log(`[repro-appkit-http500] totalConfirmedBalance: ${balances.totalConfirmedBalance}`)
  const arcSlot = balances.breakdown?.[0]?.breakdown?.find(b => b.chain === 'Arc_Testnet')
  console.log(`[repro-appkit-http500] Arc_Testnet confirmed: ${arcSlot?.confirmedBalance ?? '0'}`)
  if (!arcSlot || Number(arcSlot.confirmedBalance) < Number(AMOUNT)) {
    console.error(`[repro-appkit-http500] insufficient Arc_Testnet balance: need >= ${AMOUNT}, have ${arcSlot?.confirmedBalance ?? '0'}. Deposit more first.`)
    process.exit(1)
  }

  console.log(`[repro-appkit-http500] calling appKit.unifiedBalance.spend({ chain: Arc_Testnet, amount: ${AMOUNT} })`)
  console.log(`[repro-appkit-http500] expecting KitError during mint because proxy injects HTTP 500 on eth_getTransactionReceipt`)

  try {
    const result = await appKit.unifiedBalance.spend({
      from: { adapter },
      to: { adapter, chain: 'Arc_Testnet', recipientAddress: RECIPIENT },
      token: 'USDC',
      amount: AMOUNT,
    })
    console.log(`[repro-appkit-http500] UNEXPECTED: spend returned. txHash=${result.txHash} allocations=${JSON.stringify(result.allocations)}`)
    process.exit(2)
  } catch (err: unknown) {
    console.log(`\n[repro-appkit-http500] === SDK threw. dumping error tree ===`)
    dumpError('top', err)
    console.log(`\n[repro-appkit-http500] === structured trace inspection ===`)

    const anyErr = err as { cause?: { trace?: { attestation?: string; signature?: string; cause?: unknown } } }
    const trace = anyErr.cause?.trace
    console.log(`[repro-appkit-http500] trace.attestation present? ${!!trace?.attestation} (${trace?.attestation ? trace.attestation.slice(0, 20) + '...' : 'n/a'})`)
    console.log(`[repro-appkit-http500] trace.signature   present? ${!!trace?.signature}   (${trace?.signature ? trace.signature.slice(0, 20) + '...' : 'n/a'})`)

    const underlying = trace?.cause as { hash?: string; name?: string; constructor?: { name?: string } } | undefined
    console.log(`[repro-appkit-http500] underlying cause ctor: ${underlying?.constructor?.name} name: ${underlying?.name}`)
    console.log(`[repro-appkit-http500] underlying cause .hash property: ${underlying?.hash ?? 'undefined'}`)

    const parts: string[] = []
    collectStrings(err, parts)
    const combined = parts.join(' | ')
    const hashMatch = combined.match(/(0x[a-fA-F0-9]{64})/)

    if (hashMatch) {
      const hash = hashMatch[1] as Hex
      console.log(`\n[repro-appkit-http500] regex found a 32-byte hash somewhere in the error tree: ${hash}`)
      console.log(`[repro-appkit-http500] verifying on-chain via direct RPC (bypassing proxy)...`)
      const direct = createPublicClient({ chain: arcTestnet, transport: http(DIRECT_RPC) })
      try {
        const receipt = await direct.waitForTransactionReceipt({ hash, timeout: 60_000 })
        console.log(`[repro-appkit-http500] on-chain receipt: status=${receipt.status} block=${receipt.blockNumber}`)
        if (receipt.status === 'success') {
          console.log(`[repro-appkit-http500] CONFIRMED: SDK reported mint failure but tx actually succeeded on-chain (false-negative reproduced).`)
        } else {
          console.log(`[repro-appkit-http500] tx reverted on-chain — not a false-negative.`)
        }
      } catch (e) {
        console.log(`[repro-appkit-http500] on-chain verification: ${(e as Error).message?.slice(0, 200)}`)
      }
    } else {
      console.log(`\n[repro-appkit-http500] NO 32-byte hash present anywhere in the error tree.`)
      console.log(`[repro-appkit-http500] IMPLICATION: for this receipt-poll failure mode, the mint tx hash is unrecoverable from the SDK's error.`)
      console.log(`[repro-appkit-http500] config.retry is the only SDK-provided recovery, and it carries double-mint risk.`)
      console.log(`[repro-appkit-http500] mitigation: wrap getPublicClient to capture the hash before the receipt poll runs (see appkit-mint-timeout.mts).`)
    }
  }
}

main().catch((err) => {
  console.error(`[repro-appkit-http500] fatal:`, err)
  process.exit(1)
})
