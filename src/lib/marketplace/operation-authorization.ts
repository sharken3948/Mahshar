import { keccak256, toHex, type Address, type Hex } from 'viem'
import { isValidWalletAddress } from '@/lib/wallet-validation'

export const OPERATION_AUTH_HEADER = 'x-mahshar-authorization'
export const OPERATION_AUTH_SECONDS = 300
export const OPERATION_AUTH_DOMAIN = { name: 'Mahshar', version: '1', chainId: 5042 } as const
export const OPERATION_AUTH_TYPES = {
  MahsharAuthorization: [
    { name: 'wallet', type: 'address' }, { name: 'application', type: 'string' },
    { name: 'operation', type: 'string' }, { name: 'resource', type: 'string' },
    { name: 'payloadHash', type: 'bytes32' }, { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' }, { name: 'deadline', type: 'uint64' },
  ],
} as const

export class MarketplaceError extends Error {
  constructor(message: string, readonly status = 401) { super(message) }
}
export interface OperationAuthorizationProof { wallet: Address; nonce: Hex; issuedAt: number; deadline: number; signature: Hex }
export interface OperationAuthorizationMessage {
  [key: string]: unknown
  wallet: Address; application: 'mahshar.xyz'; operation: string; resource: string; payloadHash: Hex
  nonce: Hex; issuedAt: bigint; deadline: bigint
}
export function normalizedWallet(value: unknown): Address {
  if (typeof value !== 'string' || !isValidWalletAddress(value) || /^0x0{40}$/i.test(value)) throw new MarketplaceError('Invalid wallet', 400)
  return value.toLowerCase() as Address
}
export function assertWalletClaim(claim: unknown, principal: string) {
  if (claim !== undefined && claim !== null && (typeof claim !== 'string' || claim.toLowerCase() !== principal)) {
    throw new MarketplaceError('Wallet does not match the operation signer', 403)
  }
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonicalize(item)]))
  return value
}
export function hashAuthorizationPayload(payload: unknown): Hex {
  return keccak256(toHex(JSON.stringify(canonicalize(payload))))
}
export function operationFor(method: string, pathname: string) { return `${method.toUpperCase()} ${pathname}` }
export function queryPayload(url: URL) {
  return { query: [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)) }
}
export function requestPayload(url: URL, method: string, bodyText?: string | null): unknown {
  if (['GET', 'HEAD'].includes(method.toUpperCase())) return queryPayload(url)
  if (!bodyText) return {}
  try { return JSON.parse(bodyText) as unknown } catch { return bodyText }
}
export function authorizationMessage(input: { wallet: Address; method: string; url: URL; payload: unknown; nonce: Hex; issuedAt: number; deadline: number }): OperationAuthorizationMessage {
  return { wallet: input.wallet, application: 'mahshar.xyz', operation: operationFor(input.method, input.url.pathname),
    resource: input.url.pathname, payloadHash: hashAuthorizationPayload(input.payload), nonce: input.nonce,
    issuedAt: BigInt(input.issuedAt), deadline: BigInt(input.deadline) }
}
export function encodeAuthorizationProof(proof: OperationAuthorizationProof) { return encodeURIComponent(JSON.stringify(proof)) }
export function decodeAuthorizationProof(value: string | null): OperationAuthorizationProof {
  let proof: unknown
  try { proof = JSON.parse(decodeURIComponent(value ?? '')) } catch { throw new MarketplaceError('Operation authorization required') }
  if (!proof || typeof proof !== 'object') throw new MarketplaceError('Operation authorization required')
  const candidate = proof as Record<string, unknown>
  const wallet = normalizedWallet(candidate.wallet)
  if (typeof candidate.nonce !== 'string' || !/^0x[\da-f]{64}$/i.test(candidate.nonce)
    || typeof candidate.signature !== 'string' || !/^0x(?:[\da-f]{2}){64,8192}$/i.test(candidate.signature)
    || !Number.isSafeInteger(candidate.issuedAt) || !Number.isSafeInteger(candidate.deadline)) throw new MarketplaceError('Invalid operation authorization')
  return { wallet, nonce: candidate.nonce as Hex, signature: candidate.signature as Hex,
    issuedAt: candidate.issuedAt as number, deadline: candidate.deadline as number }
}
