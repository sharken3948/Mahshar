'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { Solana } from '@circle-fin/bridge-kit'
import { formatUnits } from 'viem'

export const SOLANA_USDC_MINT = Solana.usdcAddress
export const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || (process.env.NEXT_PUBLIC_HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com')

export interface SolanaBridgeBalance {
  displayName: 'Solana'
  chainName: 'Solana'
  usdcMint: string
  rpcUrl: string
  usdcBalance: string
  isLoading: boolean
  error: string | null
}

const IDLE: SolanaBridgeBalance = {
  displayName: 'Solana',
  chainName: 'Solana',
  usdcMint: SOLANA_USDC_MINT,
  rpcUrl: SOLANA_RPC_URL,
  usdcBalance: '0.00',
  isLoading: false,
  error: null,
}

export function useSolanaBridgeBalance(pubkey: string | null) {
  const [state, setState] = useState<SolanaBridgeBalance>(IDLE)
  const inFlight = useRef<{ pubkey: string; promise: Promise<boolean> } | null>(null)
  const loadedPubkey = useRef<string | null>(null)
  const currentPubkey = useRef(pubkey)
  currentPubkey.current = pubkey

  const refresh = useCallback(() => {
    if (!pubkey) {
      loadedPubkey.current = null
      setState(IDLE)
      return Promise.resolve(true)
    }
    if (inFlight.current?.pubkey === pubkey) return inFlight.current.promise
    const hasSnapshot = loadedPubkey.current === pubkey
    if (!hasSnapshot) setState({ ...IDLE, isLoading: true })
    const request = (async () => {
      try {
        const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
        const owner = new PublicKey(pubkey)
        const mint = new PublicKey(SOLANA_USDC_MINT)
        const result = await connection.getParsedTokenAccountsByOwner(owner, { mint })

        let raw = BigInt(0)
        for (const { account } of result.value) {
          const parsed = (account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed
          const amount = parsed?.info?.tokenAmount?.amount
          if (typeof amount === 'string') raw += BigInt(amount)
        }

        if (currentPubkey.current !== pubkey) return false
        loadedPubkey.current = pubkey
        setState({ ...IDLE, usdcBalance: formatUnits(raw, 6), isLoading: false })
        return true
      } catch (err) {
        if (currentPubkey.current !== pubkey) return false
        const error = err instanceof Error ? err.message : String(err)
        setState(current => hasSnapshot ? { ...current, isLoading: false, error } : { ...IDLE, usdcBalance: '?', isLoading: false, error })
        return false
      }
    })().finally(() => { if (inFlight.current?.promise === request) inFlight.current = null })
    inFlight.current = { pubkey, promise: request }
    return request
  }, [pubkey])

  useEffect(() => { void refresh() }, [refresh])
  return { ...state, refresh }
}
