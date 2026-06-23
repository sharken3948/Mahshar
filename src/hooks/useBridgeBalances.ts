'use client'
import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { createPublicClient, http } from 'viem'
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
}

export interface BridgeChainBalance extends BridgeChainInfo {
  usdcBalance: string
  isLoading: boolean
}

export const SOURCE_CHAINS: BridgeChainInfo[] = [
  { chainName: BridgeChain.Avalanche_Fuji,      chainId: 43113,    displayName: 'Avalanche Fuji',    usdcAddress: '0x5425890298aed601595a70AB815c96711a31Bc65', rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc' },
  { chainName: BridgeChain.Base_Sepolia,         chainId: 84532,    displayName: 'Base Sepolia',       usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', rpcUrl: 'https://sepolia.base.org' },
  { chainName: BridgeChain.Ethereum_Sepolia,     chainId: 11155111, displayName: 'Ethereum Sepolia',   usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' },
  { chainName: BridgeChain.Arbitrum_Sepolia,     chainId: 421614,   displayName: 'Arbitrum Sepolia',   usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc' },
  { chainName: BridgeChain.Optimism_Sepolia,     chainId: 11155420, displayName: 'Optimism Sepolia',   usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', rpcUrl: 'https://sepolia.optimism.io' },
  { chainName: BridgeChain.Polygon_Amoy_Testnet, chainId: 80002,    displayName: 'Polygon Amoy',       usdcAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', rpcUrl: 'https://rpc-amoy.polygon.technology' },
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
        const client = createPublicClient({ transport: http(chain.rpcUrl) })
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
