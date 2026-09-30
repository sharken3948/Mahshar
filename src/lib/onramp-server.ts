import 'server-only'
import { createOnrampServerKit, type MintedOnrampSession } from '@circle-fin/onramp-kit/server'
import { MarketplaceError } from './marketplace/operation-authorization'
import { onrampSessionRequest } from './onramp-policy'

const ONRAMP_REQUEST_TIMEOUT_MS = 10_000

type SessionMinter = (request: ReturnType<typeof onrampSessionRequest>) => Promise<MintedOnrampSession>

export async function createMahsharOnrampSession(
  body: unknown,
  authenticatedWallet: string,
  mintOverride?: SessionMinter,
) {
  const request = onrampSessionRequest(body, authenticatedWallet)
  const apiKey = process.env.CIRCLE_ONRAMP_API_KEY?.trim()
  if (!apiKey && !mintOverride) throw new MarketplaceError('Onramp is not configured', 503)

  try {
    const mint = mintOverride ?? createOnrampServerKit({
      apiKey: apiKey!,
      requestTimeoutMs: ONRAMP_REQUEST_TIMEOUT_MS,
    }).createSession
    return await mint(request)
  } catch (error) {
    if (error instanceof MarketplaceError) throw error
    throw new MarketplaceError('Onramp is temporarily unavailable', 503)
  }
}
