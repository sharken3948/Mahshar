import { config } from 'dotenv'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, http, type Hex } from 'viem'
import { GatewayClient } from '@circle-fin/x402-batching/client'

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
if (loadedFrom) console.log(`[repro] loaded env from ${loadedFrom}`)

const pkgPath = resolve(repoRoot, 'node_modules/@circle-fin/x402-batching/package.json')
const sdkVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
console.log(`[repro] @circle-fin/x402-batching version: ${sdkVersion}`)

const PK = process.env.PLATFORM_WALLET_PK as Hex | undefined
if (!PK || !/^0x[a-fA-F0-9]{64}$/.test(PK)) {
  console.error('[repro] PLATFORM_WALLET_PK is missing or malformed (expected 0x + 64 hex chars)')
  process.exit(1)
}

const PROXY_URL = 'http://127.0.0.1:8546'
const DIRECT_RPC = 'https://rpc.testnet.arc.network'
const RECIPIENT = '0x052650D1764406d702252B20B2294346A594A1ef' as const
const AMOUNT = '0.0009'
// BigInt(900), not `900n` — literal requires ES2020 target; call form works under ES2017.
const MIN_AVAILABLE_ATOMIC = BigInt(900) // 0.0009 USDC in 6-decimals atomic units

const arcTestnet = defineChain({
  id: 5042002,
  name: 'ARC Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [DIRECT_RPC] } },
  testnet: true,
})

async function main(): Promise<void> {
  const gateway = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: PK as Hex,
    rpcUrl: PROXY_URL,
  })

  console.log(`[repro] wallet address: ${gateway.address}`)
  console.log(`[repro] fetching balances via proxy...`)
  const balances = await gateway.getBalances()
  console.log(`[repro] wallet USDC: ${balances.wallet.formatted}`)
  console.log(
    `[repro] gateway total=${balances.gateway.formattedTotal} available=${balances.gateway.formattedAvailable} withdrawable=${balances.gateway.formattedWithdrawable}`,
  )

  if (balances.gateway.available < MIN_AVAILABLE_ATOMIC) {
    console.error(
      `[repro] insufficient Gateway available balance: need >= 0.0009 USDC, have ${balances.gateway.formattedAvailable}. Deposit more before running.`,
    )
    process.exit(1)
  }

  console.log(`[repro] calling gateway.transfer('${AMOUNT}', 'arcTestnet', '${RECIPIENT}')`)
  console.log(`[repro] expecting SDK to throw "Mint transaction failed" because proxy blocks eth_getTransactionReceipt`)

  try {
    const result = await gateway.transfer(AMOUNT, 'arcTestnet', RECIPIENT)
    console.log(`[repro] UNEXPECTED: transfer returned without throwing. mintTxHash=${result.mintTxHash}`)
    process.exit(2)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`[repro] SDK threw as expected:`)
    console.log(`--- error message ---`)
    console.log(message)
    console.log(`--- end error ---`)

    const hashMatch = message.match(/Mint transaction failed: (0x[a-fA-F0-9]{64})/)
    if (!hashMatch) {
      console.error(`[repro] could not extract mint tx hash from error message`)
      process.exit(3)
    }
    const mintTxHash = hashMatch[1] as Hex
    console.log(`[repro] extracted mint tx hash: ${mintTxHash}`)

    console.log(`[repro] verifying on-chain via direct RPC (bypassing proxy): ${DIRECT_RPC}`)
    const direct = createPublicClient({ chain: arcTestnet, transport: http(DIRECT_RPC) })
    const receipt = await direct.waitForTransactionReceipt({ hash: mintTxHash, timeout: 60_000 })
    console.log(`[repro] on-chain receipt: status=${receipt.status} gasUsed=${receipt.gasUsed.toString()}`)

    if (receipt.status === 'success') {
      console.log(`[repro] CONFIRMED: SDK reported failure but tx succeeded on-chain. False-negative reproduced.`)
    } else {
      console.log(`[repro] tx actually reverted on-chain — this is not the false-negative case.`)
    }
  }
}

main().catch((err) => {
  console.error(`[repro] fatal:`, err)
  process.exit(1)
})
