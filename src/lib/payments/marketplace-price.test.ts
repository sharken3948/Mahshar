import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUYER_PLATFORM_FEE_RATE,
  SELLER_PLATFORM_FEE_RATE,
  USDC_ATOMIC_SCALE,
  formatAtomicUsdc,
  marketplacePriceAmounts,
} from './marketplace-price'

test('shared marketplace amounts preserve the production payment rounding formulas', () => {
  for (const listed of [0.000001, 0.000002, 0.000003, 0.001, 0.1, 1, 12.345678, 9090.90909]) {
    const quote = marketplacePriceAmounts(listed)
    assert.equal(quote.buyerAtomic,
      Math.round(listed * (1 + BUYER_PLATFORM_FEE_RATE) * USDC_ATOMIC_SCALE))
    assert.equal(quote.sellerAtomic,
      Math.round(listed * (1 - SELLER_PLATFORM_FEE_RATE) * USDC_ATOMIC_SCALE))
    assert.equal(quote.platformAtomic, quote.buyerAtomic - quote.sellerAtomic)
  }
})

test('one USDC listed price produces the exact public provider example', () => {
  const quote = marketplacePriceAmounts(1)
  assert.deepEqual(quote, {
    listedAtomic: 1_000_000,
    buyerAtomic: 1_100_000,
    sellerAtomic: 900_000,
    platformAtomic: 200_000,
  })
  assert.equal(formatAtomicUsdc(quote.listedAtomic), '1.00')
  assert.equal(formatAtomicUsdc(quote.buyerAtomic), '1.10')
  assert.equal(formatAtomicUsdc(quote.sellerAtomic), '0.90')
  assert.equal(formatAtomicUsdc(marketplacePriceAmounts(0.000001).sellerAtomic), '0.000001')
})
