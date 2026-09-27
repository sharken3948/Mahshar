import { defineChain } from 'viem'

export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc Mainnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io/'] },
  },
})
