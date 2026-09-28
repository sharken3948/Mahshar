import type { Address, Hex } from 'viem'

export const WALLET_SESSION_COOKIE = 'mahshar_session'
export const WALLET_SESSION_SECONDS = 8 * 60 * 60
export const LOGIN_CHALLENGE_SECONDS = 5 * 60
export const LOGIN_AUTH_DOMAIN = { name: 'Mahshar', version: '1', chainId: 5042 } as const
export const LOGIN_AUTH_TYPES = {
  MahsharLogin: [
    { name: 'wallet', type: 'address' },
    { name: 'application', type: 'string' },
    { name: 'origin', type: 'string' },
    { name: 'statement', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export interface LoginMessage {
  [key: string]: unknown
  wallet: Address
  application: 'Mahshar Marketplace'
  origin: string
  statement: 'Sign in to Mahshar'
  nonce: Hex
  issuedAt: bigint
  deadline: bigint
}

export function loginMessage(input: {
  wallet: Address
  origin: string
  nonce: Hex
  issuedAt: number
  deadline: number
}): LoginMessage {
  return {
    wallet: input.wallet,
    application: 'Mahshar Marketplace',
    origin: input.origin,
    statement: 'Sign in to Mahshar',
    nonce: input.nonce,
    issuedAt: BigInt(input.issuedAt),
    deadline: BigInt(input.deadline),
  }
}
