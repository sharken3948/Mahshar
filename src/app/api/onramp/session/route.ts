import { NextRequest, NextResponse } from 'next/server'
import { MarketplaceError } from '@/lib/marketplace/operation-authorization'
import { withWalletSession } from '@/lib/marketplace/server'
import { createMahsharOnrampSession } from '@/lib/onramp-server'

export const runtime = 'nodejs'

export const POST = withWalletSession(async (request: NextRequest, wallet: string) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new MarketplaceError('Invalid Onramp request', 400)
  }
  const session = await createMahsharOnrampSession(body, wallet)
  return NextResponse.json(session)
})
