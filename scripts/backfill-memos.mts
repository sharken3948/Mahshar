import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  createWalletClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  defineChain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const envCandidates = [
  resolve(process.cwd(), '.env.local'),
  resolve(scriptDir, '..', '.env.local'),
]
let loadedFrom: string | null = null
let loadedCount = 0
for (const p of envCandidates) {
  if (!existsSync(p)) continue
  const r = config({ path: p, override: true })
  if (r.error) continue
  loadedFrom = p
  loadedCount = Object.keys(r.parsed ?? {}).length
  break
}
if (!loadedFrom) {
  console.error('Could not find .env.local at:', envCandidates)
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PLATFORM_ADDRESS = process.env.PLATFORM_WALLET_ADDRESS as `0x${string}` | undefined
if (!SUPABASE_URL || !SERVICE_KEY || !PLATFORM_ADDRESS) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PLATFORM_WALLET_ADDRESS')
  process.exit(1)
}

const EXECUTE = process.argv.includes('--execute')
const DELAY_MS = Number(process.env.BACKFILL_DELAY_MS ?? 3000)

const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as `0x${string}`
const ARC_USDC = '0x3600000000000000000000000000000000000000' as `0x${string}`
const ARCSCAN_API = 'https://testnet.arcscan.app/api/v2'

const arcTestnet = defineChain({
  id: 5042002,
  name: 'ARC Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ARC Explorer', url: 'https://testnet.arcscan.app' } },
  testnet: true,
})

const MEMO_ABI = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

type Purchase = {
  id: string
  api_id: string
  created_at: string
  api_listings: { name: string; seller_wallet: string } | null
}

async function fetchPurchases(): Promise<Purchase[]> {
  const url = `${SUPABASE_URL}/rest/v1/purchases?select=id,api_id,created_at,api_listings(name,seller_wallet)&order=created_at.asc`
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY!}` },
  })
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchExistingMemoIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  let nextParams: Record<string, string> | null = null
  let page = 0
  while (page < 100) {
    page++
    const qs = new URLSearchParams({ filter: 'from', ...(nextParams ?? {}) })
    const url = `${ARCSCAN_API}/addresses/${PLATFORM_ADDRESS}/transactions?${qs}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`arcscan ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as {
      items: Array<{
        to?: { hash?: string } | null
        decoded_input?: { parameters?: Array<{ name: string; value: string }> } | null
      }>
      next_page_params: Record<string, string> | null
    }
    for (const t of data.items) {
      const to = t.to?.hash?.toLowerCase()
      if (to !== MEMO_CONTRACT.toLowerCase()) continue
      const idParam = t.decoded_input?.parameters?.find(p => p.name === 'memoId')
      if (idParam?.value) ids.add(idParam.value.toLowerCase())
    }
    if (!data.next_page_params) break
    nextParams = data.next_page_params
  }
  return ids
}

console.log(`[env] loaded ${loadedCount} vars from ${loadedFrom}`)
console.log(`[mode] ${EXECUTE ? 'EXECUTE (real txs will be sent)' : 'DRY-RUN (default, no txs) — pass --execute to send'}`)

const purchases = await fetchPurchases()
console.log(`[supabase] fetched ${purchases.length} purchases`)

const existing = await fetchExistingMemoIds()
console.log(`[arcscan]  platform wallet has ${existing.size} existing memoIds on-chain`)

type Missing = { id: string; apiName: string; seller: `0x${string}`; memoId: string; createdAt: string }
const missing: Missing[] = []
let skippedNoListing = 0
let skippedNoSeller = 0
for (const p of purchases) {
  if (!p.api_listings) { skippedNoListing++; continue }
  if (!p.api_listings.seller_wallet) { skippedNoSeller++; continue }
  const memoId = keccak256(toHex(p.id)).toLowerCase()
  if (existing.has(memoId)) continue
  missing.push({
    id: p.id,
    apiName: p.api_listings.name,
    seller: p.api_listings.seller_wallet as `0x${string}`,
    memoId,
    createdAt: p.created_at,
  })
}

console.log(`\n[summary]`)
console.log(`  total purchases       : ${purchases.length}`)
console.log(`  memos already on-chain: ${existing.size}`)
console.log(`  missing memos         : ${missing.length}`)
console.log(`  skipped no listing    : ${skippedNoListing}`)
console.log(`  skipped no seller     : ${skippedNoSeller}`)

if (missing.length === 0) {
  console.log('\nNothing to backfill.')
  process.exit(0)
}

console.log(`\n[missing memos]`)
for (const m of missing) {
  console.log(`  ${m.createdAt}  purchase=${m.id}  api=${m.apiName}  seller=${m.seller.slice(0, 12)}...  memoId=${m.memoId.slice(0, 18)}...`)
}

if (!EXECUTE) {
  console.log(`\nDry-run only. Re-run with --execute to write ${missing.length} memo txs.`)
  process.exit(0)
}

const PLATFORM_PRIVATE_KEY = process.env.PLATFORM_WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!PLATFORM_PRIVATE_KEY || !/^0x[a-fA-F0-9]{64}$/.test(PLATFORM_PRIVATE_KEY)) {
  console.error('PLATFORM_WALLET_PRIVATE_KEY missing or malformed — required for --execute')
  process.exit(1)
}
const account = privateKeyToAccount(PLATFORM_PRIVATE_KEY)
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() })
console.log(`\n[execute] sending ${missing.length} memo txs sequentially, ${DELAY_MS}ms between txs`)

let written = 0
let failed = 0
for (let i = 0; i < missing.length; i++) {
  const m = missing[i]
  try {
    const memoData = encodeAbiParameters(
      parseAbiParameters('string, address, string'),
      [m.apiName, m.seller, m.id],
    )
    const subcallData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [account.address, BigInt(0)],
    })
    const tx = await walletClient.writeContract({
      address: MEMO_CONTRACT,
      abi: MEMO_ABI,
      functionName: 'memo',
      args: [ARC_USDC, subcallData, m.memoId as `0x${string}`, memoData],
    })
    console.log(`  [ok]   purchase=${m.id} tx=${tx}`)
    written++
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  [fail] purchase=${m.id} error=${msg.split('\n')[0]}`)
    failed++
  }
  if (i < missing.length - 1) await new Promise(r => setTimeout(r, DELAY_MS))
}

console.log(`\n[done]`)
console.log(`  written : ${written}`)
console.log(`  failed  : ${failed}`)
