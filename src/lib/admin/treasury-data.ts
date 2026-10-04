import 'server-only'

import { formatUnits, type Address } from 'viem'
import { readServerArcWalletUsdc } from '@/lib/arc-balance-server'
import type { ArcBalanceSnapshot } from '@/lib/arc-balance-read'
import { ARC_MAINNET_CHAIN_ID } from '@/lib/arc-network'
import { arcMainnet } from '@/lib/chains'
import { verifyPlatformWalletConfiguration, type VerifiedPlatformWalletConfiguration } from '@/lib/platform-wallet-config'
import { withOperationsTtl } from './operations-cache'
import type { TreasuryBalanceDto } from './operations-types'

export const TREASURY_BALANCE_TTL_MS = 60_000

export type TreasuryBalanceDependencies = {
  platformAddress?: string
  platformPrivateKey?: string
  readBalance?: (wallet: Address) => Promise<ArcBalanceSnapshot>
  now?: () => number
}

function verifiedConfiguration(dependencies: TreasuryBalanceDependencies): VerifiedPlatformWalletConfiguration {
  return verifyPlatformWalletConfiguration({
    address: dependencies.platformAddress,
    privateKey: dependencies.platformPrivateKey,
  })
}

/**
 * Reads the configured platform wallet's Arc USDC token balance. This is an
 * onchain wallet observation, not the recorded platform-fee accounting total.
 */
export async function readPlatformTreasuryBalance(
  dependencies: TreasuryBalanceDependencies = {},
): Promise<TreasuryBalanceDto> {
  const wallet = verifiedConfiguration(dependencies).address
  const readBalance = dependencies.readBalance ?? readServerArcWalletUsdc
  const snapshot = await readBalance(wallet)
  if (snapshot.value === undefined || snapshot.status === 'unknown') {
    throw new Error('Platform treasury balance is unavailable')
  }

  const observedAt = Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt as number : (dependencies.now ?? Date.now)()
  return {
    wallet,
    balance_usdc: formatUnits(snapshot.value, 6),
    status: snapshot.status,
    chain_id: ARC_MAINNET_CHAIN_ID,
    explorer_url: `${arcMainnet.blockExplorers.default.url}/address/${encodeURIComponent(wallet)}`,
    as_of: new Date(observedAt).toISOString(),
  }
}

export function getPlatformTreasuryBalance(
  dependencies: TreasuryBalanceDependencies = {},
): Promise<TreasuryBalanceDto> {
  const configuration = verifiedConfiguration(dependencies)
  const cacheKey = `platform-treasury-balance-v1:${configuration.address.toLowerCase()}`
  return withOperationsTtl(cacheKey, TREASURY_BALANCE_TTL_MS, () => readPlatformTreasuryBalance({
    ...dependencies,
    platformAddress: configuration.address,
    platformPrivateKey: configuration.privateKey,
  }))
}
