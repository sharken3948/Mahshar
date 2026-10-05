import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicPageShell } from '@/components/PublicPageShell'
import { getPublicSeoListings } from '@/lib/seo/public-catalog'
import { apiListingPath } from '@/lib/seo/listing'
import styles from './marketplace.module.css'

export const metadata: Metadata = {
  title: 'API Marketplace | Mahshar',
  description: 'Discover APIs for AI agents and applications, with pay-per-call USDC payments via x402 on Arc Mainnet.',
  alternates: { canonical: '/marketplace' },
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    title: 'API Marketplace | Mahshar',
    description: 'Discover APIs for AI agents and applications, with pay-per-call USDC payments via x402 on Arc Mainnet.',
    url: '/marketplace',
  },
  twitter: {
    card: 'summary',
    title: 'API Marketplace | Mahshar',
    description: 'Discover APIs for AI agents and applications, with pay-per-call USDC payments via x402 on Arc Mainnet.',
  },
}

export default async function MarketplacePage() {
  const listings = await getPublicSeoListings()

  return (
    <PublicPageShell>
      <main>
        <section className={styles.hero}>
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><strong>Marketplace</strong></div>
            <p className={styles.eyebrow}>PUBLIC API CATALOG</p>
            <h1>APIs for AI agents,<span>paid per call with USDC.</span></h1>
            <p className={styles.lead}>Discover active APIs on Mahshar’s public marketplace. Listings use x402 pay-per-call payments on Arc Mainnet, while execution remains in the existing buyer application.</p>
            <div className={styles.heroLinks}>
              <Link href="/buyer" className={styles.primaryButton}>Use an API</Link>
              <Link href="/agents" className={styles.secondaryButton}>Build for AI agents</Link>
              <Link href="/docs" className={styles.textLink}>Read documentation</Link>
            </div>
          </div>
        </section>

        <section className={styles.catalog} aria-labelledby="active-apis-heading">
          <div className={styles.container}>
            <div className={styles.sectionHeading}>
              <div><p className={styles.eyebrow}>ACTIVE LISTINGS</p><h2 id="active-apis-heading">Browse the public catalog</h2></div>
              <p>{listings.length ? `${listings.length} active ${listings.length === 1 ? 'API' : 'APIs'}` : 'Catalog currently unavailable'}</p>
            </div>
            {listings.length > 0 ? (
              <div className={styles.cardGrid}>
                {listings.map(listing => (
                  <article className={styles.card} key={listing.id}>
                    <div className={styles.cardMeta}>
                      <span className={styles.method}>{listing.method}</span>
                      <span>{listing.category}</span>
                      {listing.verified && <span className={styles.verified}>Endpoint checked</span>}
                    </div>
                    <h2><Link href={apiListingPath(listing)}>{listing.name}</Link></h2>
                    <p className={styles.description}>{listing.description}</p>
                    <div className={styles.cardFooter}>
                      <div><strong>{formatUsdc(listing.pricePerCall)} USDC</strong><span>per call · x402 on Arc</span></div>
                      <Link href={apiListingPath(listing)} className={styles.detailsLink}>View API <span aria-hidden="true">→</span></Link>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>
                <h2>No public API pages are available right now.</h2>
                <p>The core Mahshar application remains available. You can try the existing buyer flow or return later.</p>
                <Link href="/buyer" className={styles.secondaryButton}>Open buyer application</Link>
              </div>
            )}
          </div>
        </section>
      </main>
    </PublicPageShell>
  )
}

function formatUsdc(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
}
