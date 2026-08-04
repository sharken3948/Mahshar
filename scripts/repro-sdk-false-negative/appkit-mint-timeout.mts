import { config } from 'dotenv'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  WaitForTransactionReceiptTimeoutError,
  type Hex,
  type PublicClient,
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
if (loadedFrom) console.log(`[repro-appkit-timeout] loaded env from ${loadedFrom}`)

const pkgPath = resolve(repoRoot, 'node_modules/@circle-fin/app-kit/package.json')
const sdkVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
console.log(`[repro-appkit-timeout] @circle-fin/app-kit version: ${sdkVersion}`)

const PK = (process.env.PLATFORM_WALLET_PK ?? process.env.PLATFORM_WALLET_PRIVATE_KEY) as Hex | undefined
if (!PK || !/^0x[a-fA-F0-9]{64}$/.test(PK)) {
  console.error('[repro-appkit-timeout] neither PLATFORM_WALLET_PK nor PLATFORM_WALLET_PRIVATE_KEY is set to a valid key (0x + 64 hex chars)')
  process.exit(1)
}

const DIRECT_RPC = 'https://rpc.testnet.arc.network'
const RECIPIENT = '0x052650D1764406d702252B20B2294346A594A1ef' as const
const AMOUNT = '0.0009'
const ARC_CHAIN_ID = 5042002
const LET_TX_LAND_MS = 3_000

const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'ARC Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [DIRECT_RPC] } },
  testnet: true,
})

// External capture — proves the "wrapped getPublicClient" mitigation works.
let capturedMintHash: Hex | undefined

function wrapClientForcingTimeout(real: PublicClient): PublicClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'waitForTransactionReceipt') {
        return async (args: { hash: Hex; confirmations?: number; timeout?: number }) => {
          console.log(`[intercept] waitForTransactionReceipt(hash=${args.hash}) — capturing hash then throwing synthetic WaitForTransactionReceiptTimeoutError`)
          capturedMintHash = args.hash
          // let the actual tx settle so on-chain verification is meaningful
          await new Promise((r) => setTimeout(r, LET_TX_LAND_MS))
          throw new WaitForTransactionReceiptTimeoutError({ hash: args.hash })
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as PublicClient
}

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
    if (cause !== undefined && depth < 5) dumpError(`${label}.cause`, cause, depth + 1)
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

async function main(): Promise<void> {
  const account = privateKeyToAccount(PK!)
  console.log(`[repro-appkit-timeout] wallet: ${account.address}`)

  const adapter = createViemAdapterFromPrivateKey({
    privateKey: PK!,
    getPublicClient: ({ chain }) => {
      const real = createPublicClient({
        chain: chain.id === ARC_CHAIN_ID ? arcTestnet : chain,
        transport: http(DIRECT_RPC),
      })
      // Only intercept Arc receipt polls; other chains untouched.
      return chain.id === ARC_CHAIN_ID ? wrapClientForcingTimeout(real) : real
    },
    getWalletClient: ({ chain, account: acc }) => createWalletClient({
      chain: chain.id === ARC_CHAIN_ID ? arcTestnet : chain,
      account: acc,
      transport: http(DIRECT_RPC),
    }),
  })

  const appKit = new AppKit()

  const balances = await appKit.unifiedBalance.getBalances({
    token: 'USDC',
    sources: { address: account.address, chains: 'Arc_Testnet' },
  })
  console.log(`[repro-appkit-timeout] totalConfirmed: ${balances.totalConfirmedBalance}`)
  const arcSlot = balances.breakdown?.[0]?.breakdown?.find(b => b.chain === 'Arc_Testnet')
  console.log(`[repro-appkit-timeout] Arc_Testnet confirmed: ${arcSlot?.confirmedBalance ?? '0'}`)
  if (!arcSlot || Number(arcSlot.confirmedBalance) < Number(AMOUNT)) {
    console.error(`[repro-appkit-timeout] insufficient Arc_Testnet balance: need >= ${AMOUNT}`)
    process.exit(1)
  }

  console.log(`[repro-appkit-timeout] calling spend — mint tx will submit for real, then wrapped client will throw synthetic timeout`)

  try {
    const result = await appKit.unifiedBalance.spend({
      from: { adapter },
      to: { adapter, chain: 'Arc_Testnet', recipientAddress: RECIPIENT },
      token: 'USDC',
      amount: AMOUNT,
    })
    console.log(`[repro-appkit-timeout] UNEXPECTED: spend returned. txHash=${result.txHash}`)
    process.exit(2)
  } catch (err: unknown) {
    console.log(`\n[repro-appkit-timeout] === SDK threw. dumping error tree ===`)
    dumpError('top', err)
    console.log(`\n[repro-appkit-timeout] === structured trace inspection ===`)

    const anyErr = err as { cause?: { trace?: { attestation?: string; signature?: string; cause?: unknown } } }
    const trace = anyErr.cause?.trace
    console.log(`[repro-appkit-timeout] trace.attestation present? ${!!trace?.attestation} (${trace?.attestation ? trace.attestation.slice(0, 20) + '...' : 'n/a'})`)
    console.log(`[repro-appkit-timeout] trace.signature   present? ${!!trace?.signature}   (${trace?.signature ? trace.signature.slice(0, 20) + '...' : 'n/a'})`)

    const underlying = trace?.cause as { hash?: string; name?: string; message?: string; constructor?: { name?: string } } | undefined
    console.log(`[repro-appkit-timeout] underlying cause ctor: ${underlying?.constructor?.name}  name: ${underlying?.name}`)
    console.log(`[repro-appkit-timeout] underlying cause .hash property (viem does NOT set this): ${underlying?.hash ?? 'undefined'}`)

    const msgHashMatch = underlying?.message?.match(/hash "(0x[a-fA-F0-9]{64})"/)
    console.log(`[repro-appkit-timeout] hash extracted from underlying message: ${msgHashMatch?.[1] ?? 'none'}`)

    console.log(`\n[repro-appkit-timeout] externally captured (via wrapped getPublicClient): ${capturedMintHash ?? 'undefined'}`)

    const hashForVerify = capturedMintHash ?? (msgHashMatch?.[1] as Hex | undefined)
    if (hashForVerify) {
      console.log(`[repro-appkit-timeout] verifying on-chain via direct RPC (fresh, unwrapped client)...`)
      const direct = createPublicClient({ chain: arcTestnet, transport: http(DIRECT_RPC) })
      try {
        const receipt = await direct.waitForTransactionReceipt({ hash: hashForVerify, timeout: 60_000 })
        console.log(`[repro-appkit-timeout] on-chain receipt: status=${receipt.status} block=${receipt.blockNumber}`)
        if (receipt.status === 'success') {
          console.log(`[repro-appkit-timeout] CONFIRMED: mint landed on-chain despite SDK error. False-negative safe-recovery path works.`)
          console.log(`[repro-appkit-timeout] config.retry MUST NOT be called in this state — it would submit a second mint that reverts on TransferSpecHashUsed.`)
        }
      } catch (e) {
        console.log(`[repro-appkit-timeout] verification failed: ${(e as Error).message?.slice(0, 200)}`)
      }
    }
  }
}

main().catch((err) => {
  console.error(`[repro-appkit-timeout] fatal:`, err)
  process.exit(1)
})
