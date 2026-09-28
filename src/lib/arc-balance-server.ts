import 'server-only'

import { createPublicClient, erc20Abi, getAddress, http, type Address } from 'viem'
import { ARC } from '@/lib/arc'
import { arcMainnet } from '@/lib/chains'
import { ArcBalanceReader, type ArcBalanceSnapshot } from '@/lib/arc-balance-read'

const SERVER_RPC_TIMEOUT_MS = 6_000
const serverReader = new ArcBalanceReader()
let serverClient: ReturnType<typeof createPublicClient> | undefined
let serverClientUrl: string | undefined

function getServerClient() {
  const rpcUrl = process.env.ARC_MAINNET_RPC_URL?.trim()
  if (!rpcUrl) throw new Error('ARC_MAINNET_RPC_URL is required for Arc balance fallback')
  if (serverClient && serverClientUrl === rpcUrl) return serverClient
  serverClientUrl = rpcUrl
  serverClient = createPublicClient({
    chain: arcMainnet,
    transport: http(rpcUrl, { timeout: SERVER_RPC_TIMEOUT_MS, retryCount: 1, retryDelay: 150 }),
  })
  return serverClient
}

export function readServerArcWalletUsdc(wallet: Address, force = false): Promise<ArcBalanceSnapshot> {
  const normalized = getAddress(wallet)
  return serverReader.read(normalized, [{
    name: 'server-fallback',
    read: address => getServerClient().readContract({
      address: ARC.usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    }),
  }], { force })
}
