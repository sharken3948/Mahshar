'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { createPublicClient, fallback, formatUnits, getAddress, http } from 'viem'
import type { Blockchain } from '@circle-fin/bridge-kit'
import { discoverCircleRoutes } from '@/lib/circle-bridge'

const BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

export interface BridgeChainInfo {
  chainName: Blockchain
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

export function useBridgeBalances() {
  const { address, isConnected } = useAccount()
  const [chains, setChains] = useState<BridgeChainInfo[]>([])
  const [balances, setBalances] = useState<BridgeChainBalance[]>([])
  const inFlight = useRef<{ key: string; promise: Promise<boolean> } | null>(null)
  const currentRequestKey = `${isConnected ? address?.toLowerCase() ?? '' : ''}:${chains.map(chain => chain.chainName).join(',')}`
  const currentRequestKeyRef = useRef(currentRequestKey)
  currentRequestKeyRef.current = currentRequestKey

  useEffect(() => {
    if (!isConnected || !address) {
      setChains([])
      setBalances([])
      return
    }

    let active = true
    void discoverCircleRoutes().then(({ routes }) => {
      const chains: BridgeChainInfo[] = routes.flatMap(({ source }) => source.type === 'evm' ? [{
        chainName: source.chain, chainId: source.chainId, displayName: source.name,
        usdcAddress: getAddress(source.usdcAddress!), rpcUrl: source.rpcEndpoints[0], fallbackRpcUrls: source.rpcEndpoints.slice(1),
      }] : [])
      if (!active) return
      setChains(chains)
      setBalances(chains.map(c => ({ ...c, usdcBalance: '?', isLoading: true })))
    }).catch(() => { if (active) { setChains([]); setBalances([]) } })
    return () => { active = false }
  }, [address, isConnected])

  const refresh = useCallback(() => {
    if (!address || !isConnected) return Promise.resolve(true)
    if (!chains.length) return Promise.resolve(false)
    const requestKey = `${address.toLowerCase()}:${chains.map(chain => chain.chainName).join(',')}`
    if (inFlight.current?.key === requestKey) return inFlight.current.promise
    const request = Promise.all(chains.map(async chain => {
      const transport = chain.fallbackRpcUrls?.length
        ? fallback([http(chain.rpcUrl), ...chain.fallbackRpcUrls.map(url => http(url))])
        : http(chain.rpcUrl)
      const client = createPublicClient({ transport })
      try {
        const raw = await client.readContract({ address: chain.usdcAddress, abi: BALANCE_ABI, functionName: 'balanceOf', args: [address] })
        return { chainName: chain.chainName, balance: formatUnits(raw, 6), success: true as const }
      } catch { return { chainName: chain.chainName, success: false as const } }
    })).then(results => {
      if (currentRequestKeyRef.current !== requestKey) return false
      setBalances(previous => chains.map(chain => {
        const result = results.find(item => item.chainName === chain.chainName)
        if (result?.success) return { ...chain, usdcBalance: result.balance, isLoading: false }
        const snapshot = previous.find(item => item.chainName === chain.chainName)
        return { ...chain, usdcBalance: snapshot?.usdcBalance ?? '?', isLoading: false }
      }))
      return results.every(result => result.success)
    }).finally(() => { if (inFlight.current?.promise === request) inFlight.current = null })
    inFlight.current = { key: requestKey, promise: request }
    return request
  }, [address, chains, isConnected])

  useEffect(() => { if (chains.length) void refresh() }, [chains, refresh])
  return { balances, refresh }
}
