'use client'
import { useMemo } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { SOLANA_RPC_URL } from '@/hooks/useSolanaBridgeBalance'
import '@solana/wallet-adapter-react-ui/styles.css'

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], [])

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
