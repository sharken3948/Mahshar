import Image from 'next/image'
import Link from 'next/link'
import type { Metadata } from 'next'
import { NavBar } from '@/components/NavBar'
import { PublicSiteFooter } from '@/components/PublicSiteFooter'
import { HOME_DESCRIPTION, HOME_TITLE, homepageStructuredData } from '@/lib/seo/brand'
import styles from './landing.module.css'

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    url: '/',
    images: [{ url: '/logo.png', width: 1024, height: 559, alt: 'Mahshar' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: ['/logo.png'],
  },
}

const workflow = [
  { number: '01', title: 'Discover', copy: 'Find the API your agent or application needs.', icon: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.6 15.6 4.4 4.4" /></> },
  { number: '02', title: 'Pay', copy: 'Pay for access with USDC when you need it.', icon: <><path d="M5 8h14M5 16h14" /><path d="m8 5-3 3 3 3m8 2 3 3-3 3" /></> },
  { number: '03', title: 'Receive', copy: 'Call the API and receive the response directly.', icon: <path d="m5 12 4 4L19 6" /> },
]

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(homepageStructuredData).replace(/</g, '\\u003c') }}
      />
      <NavBar landing />

      <section className={styles.hero}>
        <div className={styles.heroHalo} aria-hidden="true" />
        <div className={styles.heroRings} aria-hidden="true" />
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>MAHSHAR API MARKETPLACE</p>
            <h1 className={styles.heroTitle}>
              <span>The API</span>
              <span>economy,</span>
              <span className={styles.heroAccent}>powered by</span>
              <span className={styles.heroAccent}>USDC.</span>
            </h1>
            <p className={styles.heroDescription}>Mahshar gives AI agents and builders a direct way to discover, sell, and pay for API access with USDC.</p>
            <div className={styles.heroActions}>
              <Link href="/seller" className={`${styles.heroButton} ${styles.sellerButton}`}>List Your API <ArrowIcon /></Link>
              <Link href="/buyer" className={`${styles.heroButton} ${styles.marketButton}`}>Buy in Marketplace <ArrowIcon /></Link>
            </div>
            <div className={styles.trustRow} aria-label="Mahshar platform highlights">
              <TrustItem icon={<ShieldIcon />} label="USDC Payments" />
              <TrustItem icon={<BoltIcon />} label="Built for AI Agents" />
              <TrustItem icon={<GlobeIcon />} label="On Arc Mainnet" />
            </div>
          </div>
          <EcosystemCard />
        </div>
      </section>

      <section className={styles.stepsSection}>
        <div className={styles.stepsInner}>
          <div className={styles.stepsHeading}>
            <div><p className={styles.eyebrow}>HOW IT WORKS</p><h2>Three simple steps.</h2></div>
            <Link href="/about" className={styles.learnLink}>About Mahshar <ArrowIcon /></Link>
          </div>
          <div className={styles.stepsGrid}>
            {workflow.map((step) => (
              <article key={step.number} className={styles.stepCard}>
                <div className={styles.stepTopline}>
                  <span className={styles.stepIcon}><svg viewBox="0 0 24 24" aria-hidden="true">{step.icon}</svg></span>
                  <span className={styles.stepNumber}>{step.number}</span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <PublicSiteFooter />
    </main>
  )
}

function EcosystemCard() {
  return (
    <aside className={styles.ecosystemCard} aria-label="Mahshar ecosystem">
      <div className={styles.ecosystemHeader}>
        <div><h2>From agents to real-world tools.</h2><p>APIs. Payments. Possibilities.</p></div>
        <span>SIMPLE · OPEN · GLOBAL</span>
      </div>
      <div className={styles.ecosystemMap}>
        <svg className={styles.connections} viewBox="0 0 660 266" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="connection-blue" x1="0" x2="1"><stop stopColor="#88d8ff" stopOpacity=".14" /><stop offset=".48" stopColor="#2fbbff" stopOpacity=".82" /><stop offset="1" stopColor="#88d8ff" stopOpacity=".14" /></linearGradient>
            <filter id="connection-glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="8" /></filter>
          </defs>
          <path className={styles.connectionGlow} d="M205 59 C262 59 256 114 330 132 C404 114 398 59 455 59" />
          <path className={styles.connectionGlow} d="M205 207 C262 207 256 151 330 132 C404 151 398 207 455 207" />
          <path d="M205 59 C262 59 256 114 330 132 C404 114 398 59 455 59" />
          <path d="M205 207 C262 207 256 151 330 132 C404 151 398 207 455 207" />
        </svg>
        <EcosystemItem title="AI Agents" copy={<>Find the tools<br />you need</>} icon={<AgentIcon />} />
        <EcosystemItem title="USDC Payments" copy={<>Fast, secure<br />and global</>} icon={<WalletIcon />} />
        <EcosystemItem title="API Providers" copy={<>Monetize<br />your capabilities</>} icon={<CodeIcon />} />
        <EcosystemItem title={<>A Growing<br />Ecosystem</>} copy={<>More builders<br />More possibilities</>} icon={<GrowthIcon />} />
        <div className={styles.centralHub}>
          <div className={styles.hubGlow} aria-hidden="true" />
          <div className={styles.hubCore}><Image src="/mahshar-icon.png" alt="" width={512} height={512} priority /></div>
          <div className={styles.hubBase} aria-hidden="true"><span /></div>
        </div>
      </div>
      <div className={styles.ecosystemFooter}>
        <EcosystemWaves />
        <p>APIs power ideas.<br />USDC powers progress.</p>
      </div>
    </aside>
  )
}

function EcosystemItem({ title, copy, icon }: { title: React.ReactNode; copy: React.ReactNode; icon: React.ReactNode }) {
  return <div className={styles.ecosystemItem}><span className={styles.ecosystemIcon}>{icon}</span><div><h3>{title}</h3><p>{copy}</p></div></div>
}

function TrustItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <span className={styles.trustItem}>{icon}{label}</span>
}

function ArrowIcon() { return <svg className={styles.arrowIcon} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg> }
function ShieldIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg> }
function BoltIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" /></svg> }
function GlobeIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.3 2.5 3.5 5.5 3.5 9S14.3 18.5 12 21c-2.3-2.5-3.5-5.5-3.5-9S9.7 5.5 12 3Z" /></svg> }
function AgentIcon() { return <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="5" y="8" width="18" height="14" rx="4" /><path d="M14 3v5M9 14h.01M19 14h.01M10 18h8M2 13h3M23 13h3" /></svg> }
function WalletIcon() { return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 7.5h18a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2v-12Z" /><path d="M4 8V6a2 2 0 0 1 2-2h15v3.5M18 13h7v5h-7a2.5 2.5 0 0 1 0-5Z" /></svg> }
function CodeIcon() { return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="m10 7-7 7 7 7M18 7l7 7-7 7M16 4l-4 20" /></svg> }
function GrowthIcon() { return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 23h4v-8H4v8Zm8 0h4V9h-4v14Zm8 0h4V4h-4v19Z" /></svg> }

function EcosystemWaves() {
  return <svg className={styles.ecosystemWaves} viewBox="0 0 660 74" preserveAspectRatio="none" aria-hidden="true"><path d="M0 38 C74 8 119 68 196 39 S315 11 382 39 511 69 660 24" /><path d="M0 23 C92 62 128 9 214 32 S348 67 430 35 552 13 660 47" /><path d="M0 55 C78 27 124 62 204 48 S338 20 420 49 563 68 660 35" /></svg>
}
