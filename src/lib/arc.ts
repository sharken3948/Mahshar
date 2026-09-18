export const ARC_TESTNET = {
  chainId: 5042002,
  usdcAddress: '0x3600000000000000000000000000000000000000',
  gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  gatewayApi: 'https://gateway-api-testnet.circle.com/v1',
  gatewayDomain: 26,
} as const

export const ARC_MAINNET = {
  chainId: 5042,
  usdcAddress: '0x3600000000000000000000000000000000000000',
  gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  gatewayApi: 'https://gateway-api.circle.com/v1',
  gatewayDomain: 26,
} as const

const SHOW_TESTNET = process.env.NEXT_PUBLIC_SHOW_TESTNET === 'true'
export const ARC = SHOW_TESTNET ? ARC_TESTNET : ARC_MAINNET
