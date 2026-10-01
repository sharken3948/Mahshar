import { cache } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, permanentRedirect } from 'next/navigation'
import { PublicPageShell } from '@/components/PublicPageShell'
import { getPublicSeoListing } from '@/lib/seo/public-catalog'
import {
  apiListingPath,
  listingMetadataDescription,
  listingRouteDecision,
  type PublicSeoListing,
} from '@/lib/seo/listing'
import styles from '../../../marketplace/marketplace.module.css'
import detailStyles from './api-detail.module.css'

type ApiPageProps = { params: Promise<{ id: string; slug: string }> }
const listingById = cache(getPublicSeoListing)

export async function generateMetadata({ params }: ApiPageProps): Promise<Metadata> {
  const { id } = await params
  const listing = await listingById(id)
  if (!listing) return { title: 'API not found | Mahshar', robots: { index: false, follow: false } }

  const title = `${listing.name} API — Pay per Call with USDC | Mahshar`
  const description = listingMetadataDescription(listing)
  const canonical = apiListingPath(listing)
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: 'website', title, description, url: canonical, siteName: 'Mahshar' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function ApiDetailPage({ params }: ApiPageProps) {
  const { id, slug } = await params
  const listing = await listingById(id)
  if (!listing) notFound()
  const decision = listingRouteDecision(listing, slug)
  if (decision.kind === 'redirect') permanentRedirect(decision.location)

  return (
    <PublicPageShell>
      <main>
        <section className={`${styles.hero} ${detailStyles.hero}`}>
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><Link href="/marketplace">Marketplace</Link><span>›</span><strong>{listing.name}</strong></div>
            <div className={detailStyles.badges}>
              <span className={styles.method}>{listing.method}</span><span>{listing.category}</span>{listing.verified && <span className={styles.verified}>Verified</span>}
            </div>
            <h1>{listing.name}</h1>
            <p className={styles.lead}>{listing.description}</p>
            <div className={styles.heroLinks}>
              <Link href="/buyer" className={styles.primaryButton}>Open buyer application</Link>
              <Link href="/marketplace" className={styles.secondaryButton}>Back to Marketplace</Link>
              <Link href="/agents" className={styles.textLink}>Agent integration</Link>
            </div>
          </div>
        </section>

        <section className={detailStyles.content}>
          <div className={`${styles.container} ${detailStyles.layout}`}>
            <div className={detailStyles.mainColumn}>
              <section className={detailStyles.panel} aria-labelledby="overview-heading">
                <p className={styles.eyebrow}>OVERVIEW</p>
                <h2 id="overview-heading">Public API details</h2>
                <dl className={detailStyles.factGrid}>
                  <Fact label="HTTP method" value={listing.method} />
                  <Fact label="Category" value={listing.category} />
                  <Fact label="Payment model" value="x402 pay per call" />
                  <Fact label="Network" value="Arc Mainnet" />
                  <Fact label="Authentication" value={authenticationLabel(listing.authType)} />
                  <Fact label="Verification" value={listing.verified ? 'Verified listing' : 'Not currently marked verified'} />
                  {listing.score !== null && <Fact label="AI score" value={formatNumber(listing.score)} />}
                </dl>
              </section>

            </div>

            <aside className={detailStyles.purchaseCard} aria-label="API price and usage">
              <p>LISTED PRICE</p>
              <strong>{formatUsdc(listing.pricePerCall)} <span>USDC</span></strong>
              <small>per API call</small>
              <ul>
                <li>x402 payment model</li>
                <li>Arc Mainnet</li>
                <li>{listing.method} request</li>
              </ul>
              <Link href="/buyer" className={styles.primaryButton}>Open buyer application</Link>
              <Link href="/docs#payments" className={detailStyles.helpLink}>How payments work</Link>
            </aside>
          </div>
        </section>
      </main>
    </PublicPageShell>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function authenticationLabel(value: PublicSeoListing['authType']) {
  if (value === 'public') return 'Public upstream access'
  if (value === 'apikey') return 'API key managed by Mahshar'
  if (value === 'bearer') return 'Bearer credential managed by Mahshar'
  return 'Query credential managed by Mahshar'
}

function formatUsdc(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}
