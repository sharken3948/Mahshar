'use client'

import { RainbowKitProvider, getDefaultConfig } from '@rainbow-me/rainbowkit'
import { WagmiProvider, type State } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { arcTestnet } from '@/lib/chains'
import { avalancheFuji, baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, polygonAmoy } from 'viem/chains'
import '@rainbow-me/rainbowkit/styles.css'

export const wagmiConfig = getDefaultConfig({
  appName: 'Mahshar',
  appDescription: 'The API economy, powered by USDC.',
  appUrl: 'https://mahshar.xyz',
  projectId: 'd5009c319fc8c117172e2e5babb5bfb3',
  chains: [arcTestnet, avalancheFuji, baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, polygonAmoy],
  ssr: true,
})

const queryClient = new QueryClient()

export function Providers({ children, initialState }: { children: React.ReactNode; initialState?: State }) {
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider showRecentTransactions={false}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
