import 'server-only'
import type { NextRequest } from 'next/server'
import { MarketplaceError, normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { marketplaceErrors, requireOperationAuthorization } from '@/lib/marketplace/server'

/** Server-only configuration. No default members and no client-supplied roles. */
export function configuredAdminWallets(): Set<string> {
  const value = process.env.ADMIN_WALLETS
  if (!value?.trim()) throw new MarketplaceError('Admin authorization unavailable', 503)
  try {
    const entries = value.split(',').map(wallet => normalizedWallet(wallet.trim()))
    return new Set(entries)
  } catch {
    throw new MarketplaceError('Admin authorization unavailable', 503)
  }
}

export async function requireAdmin(request: NextRequest) {
  const wallet = await requireOperationAuthorization(request)
  if (!configuredAdminWallets().has(wallet)) throw new MarketplaceError('Admin access denied', 403)
  return { wallet, role: 'admin' as const }
}

export function withAdmin<A extends unknown[]>(handler: (request: NextRequest, principal: Awaited<ReturnType<typeof requireAdmin>>, ...args: A) => Promise<Response>) {
  return marketplaceErrors(async (request: NextRequest, ...args: A) => {
    const principal = await requireAdmin(request)
    const response = await handler(request, principal, ...args)
    response.headers.set('Cache-Control', 'no-store')
    return response
  })
}
