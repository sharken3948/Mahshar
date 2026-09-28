'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import type { EIP1193Provider } from 'viem'
import { arcBalanceReader, type ArcBalanceSnapshot } from '@/lib/arc-balance-read'
import { readArcWalletUsdc } from '@/lib/arc-balance-client'
import { bindArcBalanceBrowserRecovery, bindArcBalanceProviderRecovery, type ArcBalanceEventProvider } from '@/lib/arc-balance-recovery'

const BACKGROUND_RETRY_MS = [3_000, 9_000] as const

const EMPTY: ArcBalanceSnapshot = {
  wallet: '0x0000000000000000000000000000000000000000',
  value: undefined,
  status: 'unknown',
}

export function useArcWalletUsdcBalance() {
  const { address, chainId, connector, isConnected } = useAccount()
  const [snapshot, setSnapshot] = useState<ArcBalanceSnapshot>(EMPTY)
  const [isLoading, setIsLoading] = useState(!!address && isConnected)
  const currentWallet = useRef(address?.toLowerCase())
  currentWallet.current = address?.toLowerCase()

  const getWalletProvider = useCallback(async () => {
    if (!connector) return undefined
    return await connector.getProvider() as EIP1193Provider | undefined
  }, [connector])

  const refresh = useCallback(async (force = false) => {
    if (!address || !isConnected) return EMPTY
    const wallet = address.toLowerCase()
    setIsLoading(true)
    try {
      const result = await readArcWalletUsdc({ wallet: address, activeChainId: chainId, getWalletProvider, force })
      if (currentWallet.current === wallet) setSnapshot(result)
      return result
    } finally {
      if (currentWallet.current === wallet) setIsLoading(false)
    }
  }, [address, chainId, getWalletProvider, isConnected])

  useEffect(() => {
    if (!address || !isConnected) {
      setSnapshot(EMPTY)
      setIsLoading(false)
      return
    }
    const wallet = address
    arcBalanceReader.invalidate(wallet)
    setSnapshot(arcBalanceReader.snapshot(wallet))
    const unsubscribe = arcBalanceReader.subscribe(wallet, setSnapshot)
    let retry: ReturnType<typeof setTimeout> | undefined
    const attempt = async (retryIndex: number) => {
      const result = await refresh(true)
      if (result.status !== 'fresh' && retryIndex < BACKGROUND_RETRY_MS.length && currentWallet.current === wallet.toLowerCase()) {
        retry = setTimeout(() => { void attempt(retryIndex + 1) }, BACKGROUND_RETRY_MS[retryIndex])
      }
    }
    void attempt(0)
    return () => { unsubscribe(); if (retry) clearTimeout(retry) }
  }, [address, chainId, isConnected, refresh])

  useEffect(() => {
    if (!address || !isConnected || typeof window === 'undefined' || typeof document === 'undefined') return
    const recover = () => { arcBalanceReader.invalidate(address); void refresh(true) }
    return bindArcBalanceBrowserRecovery(recover, window, document)
  }, [address, isConnected, refresh])

  useEffect(() => {
    if (!address || !connector || !isConnected) return
    let removeProviderListeners: (() => void) | undefined
    let disposed = false
    const recover = () => { arcBalanceReader.invalidate(address); void refresh(true) }
    void connector.getProvider().then(value => {
      if (disposed || !value) return
      removeProviderListeners = bindArcBalanceProviderRecovery(value as ArcBalanceEventProvider, recover)
    }).catch(() => undefined)
    return () => {
      disposed = true
      removeProviderListeners?.()
    }
  }, [address, connector, isConnected, refresh])

  const matchesWallet = !!address && snapshot.wallet.toLowerCase() === address.toLowerCase()
  return {
    walletUsdcRaw: matchesWallet ? snapshot.value : undefined,
    status: matchesWallet ? snapshot.status : 'unknown' as const,
    source: matchesWallet ? snapshot.source : undefined,
    updatedAt: matchesWallet ? snapshot.updatedAt : undefined,
    isLoading: isLoading || (!!address && isConnected && !matchesWallet),
    refresh,
  }
}
