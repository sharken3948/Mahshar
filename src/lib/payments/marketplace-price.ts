export const USDC_ATOMIC_SCALE = 1_000_000
export const BUYER_PLATFORM_FEE_RATE = 0.10
export const SELLER_PLATFORM_FEE_RATE = 0.10

/**
 * The authoritative six-decimal marketplace amounts used by payment
 * requirements and seller accounting. Buyer and seller amounts are rounded
 * independently, matching the production x402 path.
 */
export function marketplacePriceAmounts(listedPriceUsdc: number) {
  const buyerAtomic = Math.round(listedPriceUsdc * (1 + BUYER_PLATFORM_FEE_RATE) * USDC_ATOMIC_SCALE)
  const sellerAtomic = Math.round(listedPriceUsdc * (1 - SELLER_PLATFORM_FEE_RATE) * USDC_ATOMIC_SCALE)
  return {
    listedAtomic: Math.round(listedPriceUsdc * USDC_ATOMIC_SCALE),
    buyerAtomic,
    sellerAtomic,
    platformAtomic: buyerAtomic - sellerAtomic,
  }
}

export function formatAtomicUsdc(atomic: number) {
  if (!Number.isSafeInteger(atomic) || atomic < 0) throw new Error('Invalid atomic USDC amount')
  const fixed = (atomic / USDC_ATOMIC_SCALE).toFixed(6)
  const [whole, fraction] = fixed.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return `${whole}.${trimmed.padEnd(2, '0')}`
}
