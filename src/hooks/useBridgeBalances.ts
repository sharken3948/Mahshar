'use client'
import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { createPublicClient, fallback, getAddress, http } from 'viem'
import { BridgeChain } from '@circle-fin/bridge-kit'

const BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

export interface BridgeChainInfo {
  chainName: BridgeChain
  chainId: number
  displayName: string
  usdcAddress: `0x${string}`
  rpcUrl: string
  fallbackRpcUrls?: string[]
}

export interface BridgeChainBalance extends BridgeChainInfo {
  usdcBalance: string
  isLoading: boolean
}

export const SOURCE_CHAINS: BridgeChainInfo[] = [
  { chainName: BridgeChain.Ethereum,    chainId: 1,     displayName: 'Ethereum',    usdcAddress: getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), rpcUrl: 'https://ethereum-rpc.publicnode.com' },
  { chainName: BridgeChain.Base,        chainId: 8453,  displayName: 'Base',        usdcAddress: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), rpcUrl: 'https://mainnet.base.org', fallbackRpcUrls: ['https://base.publicnode.com'] },
  { chainName: BridgeChain.Arbitrum,    chainId: 42161, displayName: 'Arbitrum',    usdcAddress: getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'), rpcUrl: 'https://arb1.arbitrum.io/rpc' },
  { chainName: BridgeChain.Optimism,    chainId: 10,    displayName: 'Optimism',    usdcAddress: getAddress('0x0b2c639c533813f4aa9d7837caf62653d097ff85'), rpcUrl: 'https://mainnet.optimism.io' },
  { chainName: BridgeChain.Polygon,     chainId: 137,   displayName: 'Polygon',     usdcAddress: getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'), rpcUrl: 'https://polygon.publicnode.com', fallbackRpcUrls: ['https://polygon.drpc.org'] },
  { chainName: BridgeChain.Avalanche,   chainId: 43114, displayName: 'Avalanche',   usdcAddress: getAddress('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'), rpcUrl: 'https://api.avax.network/ext/bc/C/rpc' },
  { chainName: BridgeChain.Linea,       chainId: 59144, displayName: 'Linea',       usdcAddress: getAddress('0x176211869ca2b568f2a7d4ee941e073a821ee1ff'), rpcUrl: 'https://rpc.linea.build' },
  { chainName: BridgeChain.Unichain,    chainId: 130,   displayName: 'Unichain',    usdcAddress: getAddress('0x078D782b760474a361dDA0AF3839290b0EF57AD6'), rpcUrl: 'https://mainnet.unichain.org' },
  { chainName: BridgeChain.World_Chain, chainId: 480,   displayName: 'World Chain', usdcAddress: getAddress('0x79A02482A880bCE3F13e09Da970dC34db4CD24d1'), rpcUrl: 'https://worldchain-mainnet.g.alchemy.com/public' },
  { chainName: BridgeChain.Sonic,       chainId: 146,   displayName: 'Sonic',       usdcAddress: getAddress('0x29219dd400f2Bf60E5a23d13Be72B486D4038894'), rpcUrl: 'https://rpc.soniclabs.com' },
  { chainName: BridgeChain.HyperEVM,    chainId: 999,   displayName: 'HyperEVM',    usdcAddress: getAddress('0xb88339CB7199b77E23DB6E890353E22632Ba630f'), rpcUrl: 'https://rpc.hyperliquid.xyz/evm' },
  { chainName: BridgeChain.Sei,         chainId: 1329,  displayName: 'Sei',         usdcAddress: getAddress('0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392'), rpcUrl: 'https://evm-rpc.sei-apis.com' },
  { chainName: BridgeChain.Ink,         chainId: 57073, displayName: 'Ink',         usdcAddress: getAddress('0x2D270e6886d130D724215A266106e6832161EAEd'), rpcUrl: 'https://rpc-gel.inkonchain.com', fallbackRpcUrls: ['https://rpc-qnd.inkonchain.com'] },
  { chainName: BridgeChain.Monad,       chainId: 143,   displayName: 'Monad',       usdcAddress: getAddress('0x754704Bc059F8C67012fEd69BC8A327a5aafb603'), rpcUrl: 'https://rpc.monad.xyz' },
]

const ZERO_BALANCES: BridgeChainBalance[] = SOURCE_CHAINS.map(c => ({ ...c, usdcBalance: '0.00', isLoading: false }))

export function useBridgeBalances(): BridgeChainBalance[] {
  const { address, isConnected } = useAccount()
  const [balances, setBalances] = useState<BridgeChainBalance[]>(ZERO_BALANCES)

  useEffect(() => {
    if (!isConnected || !address) {
      setBalances(ZERO_BALANCES)
      return
    }

    setBalances(SOURCE_CHAINS.map(c => ({ ...c, usdcBalance: '0.00', isLoading: true })))

    Promise.all(
      SOURCE_CHAINS.map(async chain => {
        const transport = chain.fallbackRpcUrls?.length
          ? fallback([http(chain.rpcUrl), ...chain.fallbackRpcUrls.map(u => http(u))])
          : http(chain.rpcUrl)
        const client = createPublicClient({ transport })
        try {
          const raw = await client.readContract({
            address: chain.usdcAddress,
            abi: BALANCE_ABI,
            functionName: 'balanceOf',
            args: [address],
          })
          return { chainName: chain.chainName, balance: (Number(raw) / 1_000_000).toFixed(2) }
        } catch {
          return { chainName: chain.chainName, balance: '?' }
        }
      })
    ).then(results => {
      setBalances(prev => prev.map(b => {
        const r = results.find(x => x.chainName === b.chainName)
        return r ? { ...b, usdcBalance: r.balance, isLoading: false } : { ...b, isLoading: false }
      }))
    })
  }, [address, isConnected])

  return balances
}
