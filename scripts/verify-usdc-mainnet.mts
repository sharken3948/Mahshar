import { createPublicClient, getAddress, http, type Address } from 'viem'
import { discoverCircleRoutes } from '../src/lib/circle-bridge'

const ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

interface Row {
  displayName: string
  chainId: number
  bridgeChain: string
  usdcAddress: Address
  rpcUrl: string
}

const { routes } = await discoverCircleRoutes()
const CHAINS: Row[] = routes.flatMap(({ source }) => source.type === 'evm' ? [{
  displayName: source.name, chainId: source.chainId, bridgeChain: source.chain,
  usdcAddress: getAddress(source.usdcAddress!), rpcUrl: source.rpcEndpoints[0],
}] : [])

async function verifyOne(row: Row) {
  const client = createPublicClient({ transport: http(row.rpcUrl, { timeout: 15_000, retryCount: 1 }) })
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: row.usdcAddress, abi: ERC20_ABI, functionName: 'symbol' }),
      client.readContract({ address: row.usdcAddress, abi: ERC20_ABI, functionName: 'decimals' }),
    ])
    const ok = symbol === 'USDC' && decimals === 6
    return { ...row, symbol, decimals, ok, error: null as string | null }
  } catch (e: any) {
    return { ...row, symbol: null as string | null, decimals: null as number | null, ok: false, error: e?.shortMessage || e?.message || String(e) }
  }
}

const results = await Promise.all(CHAINS.map(verifyOne))

console.log('\n=== USDC verification results ===\n')
console.log('displayName          | chainId | bridgeChain    | symbol | decimals | status  | error')
console.log('---------------------|---------|----------------|--------|----------|---------|------')
for (const r of results) {
  const status = r.ok ? 'OK'.padEnd(7) : 'FAIL'.padEnd(7)
  const sym = (r.symbol ?? '-').padEnd(6)
  const dec = String(r.decimals ?? '-').padEnd(8)
  console.log(`${r.displayName.padEnd(20)} | ${String(r.chainId).padEnd(7)} | ${r.bridgeChain.padEnd(14)} | ${sym} | ${dec} | ${status} | ${r.error ?? ''}`)
}

const failed = results.filter(r => !r.ok)
if (failed.length) {
  console.log(`\n${failed.length} chain(s) failed verification:`)
  for (const f of failed) console.log(`  - ${f.displayName}: symbol=${f.symbol} decimals=${f.decimals} error=${f.error ?? 'mismatch'}`)
  process.exit(1)
}
console.log(`\nAll ${results.length} chains verified: symbol='USDC', decimals=6`)
