export const ARC_MAINNET = {
  chainId: 5042,
  usdcAddress: '0x3600000000000000000000000000000000000000',
  gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  gatewayMinter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
  gatewayApi: 'https://gateway-api.circle.com/v1',
  gatewayDomain: 26,
} as const

export const ARC = ARC_MAINNET
export const ARC_GATEWAY_MINTER = ARC.gatewayMinter

export const GATEWAY_MINTER_ABI = [
  {
    name: 'gatewayMint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'attestation', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const
