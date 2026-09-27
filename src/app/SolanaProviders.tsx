'use client'
import { useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { SOLANA_RPC_URL } from '@/hooks/useSolanaBridgeBalance'
import { shouldAutoConnectSolanaWallet } from '@/lib/solana-wallet-routing'
import '@solana/wallet-adapter-react-ui/styles.css'

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], [])
  const pathname = usePathname()
  const autoConnect = shouldAutoConnectSolanaWallet(pathname)

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
