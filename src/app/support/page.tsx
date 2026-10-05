import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicIcon } from '@/components/PublicIcon'
import { PublicPageShell } from '@/components/PublicPageShell'
import styles from '../public-pages.module.css'

export const metadata: Metadata = {
  title: 'Support | Mahshar',
  description: 'Documentation and direct email support for Mahshar API providers, marketplace users, builders, and autonomous agents.',
  alternates: { canonical: '/support' },
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    title: 'Support | Mahshar',
    description: 'Documentation and direct email support for Mahshar API providers, marketplace users, builders, and autonomous agents.',
    url: '/support',
  },
  twitter: {
    card: 'summary',
    title: 'Support | Mahshar',
    description: 'Documentation and direct email support for Mahshar API providers, marketplace users, builders, and autonomous agents.',
  },
}

const topics = [
  { icon: 'book' as const, title: 'Getting started', copy: 'Choose a buyer, provider, or agent path.', href: '/docs#getting-started' },
  { icon: 'wallet' as const, title: 'Wallet and payments', copy: 'Review Arc funding, x402, and Mahshar Balance.', href: '/docs#payments' },
  { icon: 'provider' as const, title: 'Listing APIs', copy: 'Open the provider documentation and listing flow.', href: '/docs#providers' },
  { icon: 'agent' as const, title: 'Using agents', copy: 'Read the public machine-interface workflow.', href: '/agents' },
  { icon: 'recovery' as const, title: 'Recovery behavior', copy: 'Understand delivery states and exact replay rules.', href: '/docs#recovery' },
  { icon: 'bridge' as const, title: 'Bridge and deposit', copy: 'Keep the Arc receipt and optional deposit steps distinct.', href: '/docs#wallet-funding' },
]

export default function SupportPage() {
  return (
    <PublicPageShell>
      <main>
        <section className={`${styles.hero} ${styles.supportHero}`}>
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><strong>Support</strong></div>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>SELF-SERVICE HELP</p>
                <h1>Help for Mahshar’s<span>implemented product flows.</span></h1>
                <p className={styles.lead}>Find the relevant documentation for marketplace access, API listings, agents, Arc Mainnet payments, bridges, and Mahshar Balance.</p>
                <div className={styles.actions}><a href="mailto:support@mahshar.xyz" className={styles.primaryButton}>Email support <PublicIcon name="arrow" /></a><Link href="/docs" className={styles.secondaryButton}>Browse documentation</Link></div>
              </div>
              <div className={styles.heroVisual} aria-hidden="true"><div className={styles.supportBadge}><PublicIcon name="help" /></div></div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>POPULAR TOPICS</p><h2>Start with the product area you are using</h2><p>Each topic links to an implemented page or a documented behavior.</p></div></div>
            <div className={`${styles.topicGrid} ${styles.topicGridThree}`}>{topics.map(topic => <Link key={topic.title} href={topic.href} className={styles.topicCard}><span className={styles.iconBox}><PublicIcon name={topic.icon} /></span><h3>{topic.title}</h3><p>{topic.copy}</p></Link>)}</div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>FREQUENTLY ASKED QUESTIONS</p><h2>Answers based on the current implementation</h2></div></div>
            <div className={styles.faqList}>
              <details className={styles.faqItem}><summary>How do I get started?</summary><div className={styles.faqAnswer}><p>Use <Link href="/buyer">Marketplace</Link> to buy API access, <Link href="/seller">List Your API</Link> to onboard an endpoint, or <Link href="/agents">Agents</Link> for the machine-readable integration path. The buyer and provider pages request an EVM wallet connection before their main workflows.</p></div></details>
              <details className={styles.faqItem}><summary>How does a Marketplace API payment work?</summary><div className={styles.faqAnswer}><p>The buyer sends the intended proxy request without a payment signature, reads the x402 v2 requirement from the 402 response, signs the offered Arc Mainnet authorization with the connected EVM wallet, and retries the same request with <code className={styles.inlineCode}>Payment-Signature</code>.</p></div></details>
              <details className={styles.faqItem}><summary>How do I list an API?</summary><div className={styles.faqAnswer}><p>Connect an EVM wallet on <Link href="/seller">List Your API</Link>, enter the listing and endpoint configuration, submit it through the existing review flow, set the price, and activate the listing when the flow allows it.</p></div></details>
              <details className={styles.faqItem}><summary>Which wallet performs a Mahshar Balance deposit?</summary><div className={styles.faqAnswer}><p>The deposit uses the connected EVM wallet on Arc Mainnet. The Wallet page switches that EVM provider to Arc when required and deposits Arc wallet USDC through the existing Unified Balance flow.</p></div></details>
              <details className={styles.faqItem}><summary>What happens after a Solana-to-Arc bridge?</summary><div className={styles.faqAnswer}><p>The bridge delivers USDC to the connected EVM wallet on Arc Mainnet. The Solana wallet is the bridge source only. A Mahshar Balance deposit is optional and remains a separate EVM-wallet transaction after the bridge succeeds.</p></div></details>
              <details className={styles.faqItem}><summary>What should I do when a bridge needs recovery?</summary><div className={styles.faqAnswer}><p>Review the saved transfer and its transaction links. If Circle marks the saved result resumable, use the existing resume action. Mahshar does not automatically begin a new burn when the prior transfer may already have moved funds.</p></div></details>
              <details className={styles.faqItem}><summary>When can a paid API request be retried?</summary><div className={styles.faqAnswer}><p>Replay the exact payment proof and request only when the response marks the delivery retryable. A final or unknown delivery state must not be treated as permission to create a new authorization. The reconciliation route only finalizes accounting; it does not settle or execute again.</p></div></details>
              <details className={styles.faqItem}><summary>Where are agent discovery and the OpenAPI specification?</summary><div className={styles.faqAnswer}><p>The machine-readable catalog is at <Link href="/api/agent/discover">/api/agent/discover</Link>. Its public OpenAPI 3.1 document is at <Link href="/api/openapi">/api/openapi</Link>.</p></div></details>
              <details className={styles.faqItem}><summary>How do I contact Mahshar support?</summary><div className={styles.faqAnswer}><p>Email <a href="mailto:support@mahshar.xyz">support@mahshar.xyz</a>.</p></div></details>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.contactGrid}>
              <article className={styles.contactCard}><div className={styles.contactMeta}><span className={styles.iconBox}><PublicIcon name="mail" /></span><div><h2>Provider or product question?</h2><p>Email the single public support address for listing, marketplace, documentation, or product-flow questions.</p></div></div><a href="mailto:support@mahshar.xyz" className={styles.primaryButton}>support@mahshar.xyz <PublicIcon name="arrow" /></a></article>
              <article className={styles.contactCard}><div className={styles.contactMeta}><span className={styles.iconBox}><PublicIcon name="docs" /></span><div><h2>Prefer self-service?</h2><p>The documentation index links the current buyer, provider, agent, payment, recovery, bridge, and Wallet surfaces.</p></div></div><Link href="/docs" className={styles.secondaryButton}>Open documentation</Link></article>
            </div>
          </div>
        </section>
      </main>
    </PublicPageShell>
  )
}
