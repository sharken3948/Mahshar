import { createHash } from 'node:crypto'
import type { OnrampSessionRequest } from '@circle-fin/onramp-kit/server'
import { MarketplaceError, normalizedWallet } from './marketplace/operation-authorization'

export const ONRAMP_DESTINATION_CHAIN = 'Arc' as const
export const ONRAMP_ASSET_SELECTION = Object.freeze({
  pairs: [Object.freeze({ token: 'USDC', chain: 'arc' })],
})

export function onrampSessionRequest(body: unknown, authenticatedWallet: string): OnrampSessionRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MarketplaceError('Invalid Onramp request', 400)
  }
  const candidate = body as Record<string, unknown>
  if (Object.keys(candidate).length !== 1 || !Object.hasOwn(candidate, 'destinationAddress')) {
    throw new MarketplaceError('Invalid Onramp request', 400)
  }
  const principal = normalizedWallet(authenticatedWallet)
  const destinationAddress = normalizedWallet(candidate.destinationAddress)
  if (destinationAddress !== principal) {
    throw new MarketplaceError('Wallet does not match the authenticated wallet', 403)
  }
  return {
    appUserId: createHash('sha256').update(`mahshar-onramp:${principal}`).digest('hex'),
    destinationAddress,
    destinationChain: ONRAMP_DESTINATION_CHAIN,
    assets: ONRAMP_ASSET_SELECTION,
  }
}
