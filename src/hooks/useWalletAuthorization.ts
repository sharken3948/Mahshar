'use client'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'

/** @deprecated Prefer useMarketplaceSession. Kept for local component compatibility. */
export function useWalletAuthorization() {
  return useMarketplaceSession()
}
