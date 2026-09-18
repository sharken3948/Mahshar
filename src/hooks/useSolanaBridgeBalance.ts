'use client'
import { useEffect, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const SOLANA_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`

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

export function useSolanaBridgeBalance(pubkey: string | null): SolanaBridgeBalance {
  const [state, setState] = useState<SolanaBridgeBalance>(IDLE)

  useEffect(() => {
    if (!pubkey) {
      setState(IDLE)
      return
    }

    let cancelled = false
    setState({ ...IDLE, isLoading: true })

    ;(async () => {
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

        if (!cancelled) {
          setState({ ...IDLE, usdcBalance: (Number(raw) / 1_000_000).toFixed(2), isLoading: false })
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            ...IDLE,
            usdcBalance: '?',
            isLoading: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })()

    return () => { cancelled = true }
  }, [pubkey])

  return state
}
