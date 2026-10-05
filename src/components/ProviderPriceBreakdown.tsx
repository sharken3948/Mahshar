import { formatAtomicUsdc, marketplacePriceAmounts } from '@/lib/payments/marketplace-price'
import styles from './onboarding-form.module.css'

export function ProviderPriceBreakdown({ listedPrice }: { listedPrice: string }) {
  const price = Number(listedPrice)
  if (!Number.isFinite(price) || price <= 0) return null
  const amounts = marketplacePriceAmounts(price)
  if (![amounts.listedAtomic, amounts.buyerAtomic, amounts.sellerAtomic].every(Number.isSafeInteger)) return null

  return (
    <div className={styles.priceBreakdown} aria-label="Provider price breakdown">
      <div><span>Listed price</span><strong>{formatAtomicUsdc(amounts.listedAtomic)} USDC</strong></div>
      <div><span>Estimated buyer total</span><strong>{formatAtomicUsdc(amounts.buyerAtomic)} USDC</strong></div>
      <div><span>Seller share</span><strong>{formatAtomicUsdc(amounts.sellerAtomic)} USDC</strong></div>
      <p>Seller share is before the estimated Arc gas deducted from a later withdrawal.</p>
    </div>
  )
}
