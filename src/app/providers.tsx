'use client'

import { RainbowKitProvider, getDefaultConfig } from '@rainbow-me/rainbowkit'
import { WagmiProvider, type State } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProductPreferencesProvider } from '@/components/ProductPreferencesProvider'
import { MarketplaceSessionProvider } from '@/components/MarketplaceSessionProvider'
import { arcMainnet } from '@/lib/chains'
import { defineChain } from 'viem'
import { MAINNET_CHAINS } from '@/lib/circle-bridge'
import '@rainbow-me/rainbowkit/styles.css'

export const wagmiConfig = getDefaultConfig({
  appName: 'Mahshar',
  appDescription: 'The API economy, powered by USDC.',
  appUrl: 'https://mahshar.xyz',
  projectId: 'd5009c319fc8c117172e2e5babb5bfb3',
  chains: [arcMainnet, ...MAINNET_CHAINS.filter(chain => chain.type === 'evm' && chain.chainId !== arcMainnet.id).map(chain => {
    if (chain.type !== 'evm') throw new Error('EVM chain required')
    return defineChain({ id: chain.chainId, name: chain.name, nativeCurrency: chain.nativeCurrency,
      rpcUrls: { default: { http: [...chain.rpcEndpoints] } },
      blockExplorers: { default: { name: chain.name, url: new URL(chain.explorerUrl).origin } },
    })
  })],
  ssr: true,
})

const queryClient = new QueryClient()

export function Providers({ children, initialState }: { children: React.ReactNode; initialState?: State }) {
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider locale="en-US" showRecentTransactions={false}>
          <MarketplaceSessionProvider>
            <ProductPreferencesProvider>{children}</ProductPreferencesProvider>
          </MarketplaceSessionProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
