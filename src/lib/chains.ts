import { defineChain } from 'viem'
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_NAME } from './arc-network'

export const arcMainnet = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: ARC_MAINNET_NAME,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io/'] },
  },
})
