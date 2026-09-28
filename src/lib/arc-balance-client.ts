'use client'

import { createPublicClient, custom, erc20Abi, getAddress, http, type Address, type EIP1193Provider } from 'viem'
import { ARC } from '@/lib/arc'
import { arcMainnet } from '@/lib/chains'
import { arcBalanceReader, type ArcBalanceReader, type ArcBalanceSnapshot, type ArcBalanceSource } from '@/lib/arc-balance-read'

export const OFFICIAL_ARC_MAINNET_RPC_URL = 'https://rpc.mainnet.arc.io/'
const BROWSER_RPC_TIMEOUT_MS = 5_000
const SERVER_FALLBACK_TIMEOUT_MS = 7_000

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ArcBalanceClientOptions {
  wallet: Address
  activeChainId?: number
  getWalletProvider?: () => Promise<EIP1193Provider | undefined>
  force?: boolean
  configuredRpcUrl?: string
  fetcher?: FetchLike
  reader?: ArcBalanceReader
}

const rpcClients = new Map<string, ReturnType<typeof createPublicClient>>()

function rpcClient(url: string) {
  const existing = rpcClients.get(url)
  if (existing) return existing
  const client = createPublicClient({
    chain: arcMainnet,
    transport: http(url, { timeout: BROWSER_RPC_TIMEOUT_MS, retryCount: 0 }),
  })
  rpcClients.set(url, client)
  return client
}

async function rpcBalance(url: string, wallet: Address) {
  return rpcClient(url).readContract({
    address: ARC.usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet],
  })
}

function withTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function serverBalance(fetcher: FetchLike, wallet: Address) {
  const timeout = withTimeoutSignal(SERVER_FALLBACK_TIMEOUT_MS)
  try {
    const response = await fetcher(`/api/wallet/arc-balance?wallet=${encodeURIComponent(wallet)}`, {
      cache: 'no-store',
      signal: timeout.signal,
    })
    const payload = await response.json().catch(() => null) as { balance_raw?: unknown; chain_id?: unknown } | null
    if (!response.ok || payload?.chain_id !== ARC.chainId || typeof payload.balance_raw !== 'string' || !/^\d+$/.test(payload.balance_raw)) {
      throw new Error('Arc server balance unavailable')
    }
    return BigInt(payload.balance_raw)
  } finally {
    timeout.clear()
  }
}

async function walletProviderBalance(provider: EIP1193Provider, wallet: Address) {
  const providerChain = await provider.request({ method: 'eth_chainId' })
  const parsedChain = typeof providerChain === 'string' ? Number.parseInt(providerChain, 16) : Number(providerChain)
  if (parsedChain !== ARC.chainId) throw new Error('Wallet provider is not on Arc')
  const client = createPublicClient({ chain: arcMainnet, transport: custom(provider, { retryCount: 0 }) })
  return client.readContract({ address: ARC.usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
}

export function arcBalanceSources(options: Omit<ArcBalanceClientOptions, 'reader' | 'force'>): ArcBalanceSource[] {
  const sources: ArcBalanceSource[] = []
  const configured = options.configuredRpcUrl?.trim()
  if (configured) {
    sources.push({ name: 'configured-rpc', attempts: 2, read: wallet => rpcBalance(configured, wallet) })
  }
  if (!configured || configured.replace(/\/$/, '') !== OFFICIAL_ARC_MAINNET_RPC_URL.replace(/\/$/, '')) {
    sources.push({ name: 'official-rpc', attempts: 2, read: wallet => rpcBalance(OFFICIAL_ARC_MAINNET_RPC_URL, wallet) })
  }
  if (options.activeChainId === ARC.chainId && options.getWalletProvider) {
    sources.push({
      name: 'wallet-provider',
      read: async wallet => {
        const provider = await options.getWalletProvider?.()
        if (!provider) throw new Error('Wallet provider unavailable')
        return walletProviderBalance(provider, wallet)
      },
    })
  }
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  sources.push({ name: 'server-fallback', read: wallet => serverBalance(fetcher, wallet) })
  return sources
}

export function readArcWalletUsdc(options: ArcBalanceClientOptions): Promise<ArcBalanceSnapshot> {
  const reader = options.reader ?? arcBalanceReader
  const wallet = getAddress(options.wallet)
  const configuredRpcUrl = options.configuredRpcUrl ?? process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL
  return reader.read(wallet, arcBalanceSources({ ...options, wallet, configuredRpcUrl }), { force: options.force })
}
