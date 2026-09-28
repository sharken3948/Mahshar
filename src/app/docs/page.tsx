import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicIcon } from '@/components/PublicIcon'
import { PublicPageShell } from '@/components/PublicPageShell'
import styles from '../public-pages.module.css'

export const metadata: Metadata = {
  title: 'Documentation | Mahshar',
  description: 'A human-readable index for Mahshar’s current marketplace, agent, payment, access, and wallet flows.',
}

const topics = [
  { icon: 'book' as const, title: 'Getting started', copy: 'Choose the implemented buyer, provider, or agent path.', href: '#getting-started' },
  { icon: 'agent' as const, title: 'Agent integration', copy: 'Discovery, proxy styles, payment, and delivery states.', href: '#agent-integration' },
  { icon: 'provider' as const, title: 'API providers', copy: 'List an endpoint and complete the existing review flow.', href: '#providers' },
  { icon: 'payment' as const, title: 'Payments and x402', copy: 'Read the Arc Mainnet x402 v2 request sequence.', href: '#payments' },
  { icon: 'auth' as const, title: 'Endpoint authentication', copy: 'See how configured seller auth is applied by the proxy.', href: '#authentication' },
  { icon: 'recovery' as const, title: 'Access and recovery', copy: 'Purchase capabilities, delivery states, and reconciliation.', href: '#recovery' },
  { icon: 'bridge' as const, title: 'Wallet funding', copy: 'Bridge to an Arc wallet, then deposit explicitly if needed.', href: '#wallet-funding' },
  { icon: 'api' as const, title: 'OpenAPI YAML', copy: 'Open the implemented public OpenAPI 3.1 document.', href: '/api/openapi' },
]

export default function DocsPage() {
  return (
    <PublicPageShell>
      <main>
        <section className={styles.hero}>
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><strong>Docs</strong></div>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>MAHSHAR DOCUMENTATION</p>
                <h1>Documentation for the<span>interfaces that exist today.</span></h1>
                <p className={styles.lead}>Start with the marketplace, provider onboarding, agent discovery, Arc Mainnet x402 contract, purchase access, or Wallet funding flow.</p>
                <div className={styles.actions}>
                  <Link href="#getting-started" className={styles.primaryButton}>Choose a path <PublicIcon name="arrow" /></Link>
                  <Link href="/api/openapi" className={styles.secondaryButton}>OpenAPI YAML</Link>
                </div>
              </div>
              <div className={styles.heroVisual} aria-hidden="true">
                <span className={styles.orbit} /><span className={styles.orbit} />
                <span className={styles.visualTag}><strong>OpenAPI 3.1</strong>public contract</span>
                <div className={styles.agentCore}><PublicIcon name="docs" /></div>
                <span className={styles.visualTag}><strong>Guides</strong>grounded in code</span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>BROWSE BY TOPIC</p><h2>Find the relevant product path</h2><p>Every destination below is an implemented route or a section on this page.</p></div></div>
            <div className={styles.topicGrid}>{topics.map(topic => <Link key={topic.title} href={topic.href} className={styles.topicCard}><span className={styles.iconBox}><PublicIcon name={topic.icon} /></span><h3>{topic.title}</h3><p>{topic.copy}</p></Link>)}</div>
          </div>
        </section>

        <section className={styles.sectionTint} id="getting-started">
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>GETTING STARTED</p><h2>Three implemented entry points</h2><p>Mahshar provides separate interfaces for people buying API calls, providers listing endpoints, and autonomous clients.</p></div></div>
            <div className={styles.contentGrid}>
              <article className={styles.contentCard}><h3>Buy API access</h3><p>The Marketplace lists active APIs after an EVM wallet is connected. Buyers can browse, search, inspect prices, and call a listing.</p><div className={styles.actions}><Link href="/buyer" className={styles.secondaryButton}>Open Marketplace</Link></div></article>
              <article className={styles.contentCard} id="providers"><h3>List an API</h3><p>The provider flow collects endpoint, method, auth, price, and example data, then uses the existing review and activation path.</p><div className={styles.actions}><Link href="/seller" className={styles.secondaryButton}>List Your API</Link></div></article>
              <article className={styles.contentCard}><h3>Integrate an agent</h3><p>The agent path starts with the public discovery endpoint, which links the OpenAPI contract and describes each active listing.</p><div className={styles.actions}><Link href="/agents" className={styles.secondaryButton}>Open Agents</Link></div></article>
            </div>
          </div>
        </section>

        <section className={styles.section} id="agent-integration">
          <div className={styles.container}>
            <div className={styles.contractPanel}>
              <div><p className={styles.eyebrow}>AGENT INTEGRATION</p><h2>Discover first, then follow the selected listing.</h2><p>The discovery response includes the listing method, proxy URL and style, request metadata, optional schemas and examples, auth type, listed price, payment contract, and response wrapper. Seller upstream URLs and credentials are not part of that public contract.</p><div className={styles.actions}><Link href="/api/agent/discover" className={styles.primaryButton}>Open discovery <PublicIcon name="arrow" /></Link><Link href="/agents" className={styles.secondaryButton}>Agent overview</Link></div></div>
              <div className={styles.codePanel}><code>{`GET /api/agent/discover\n  → active listings\n  → proxy_url + proxy_style\n  → request + response metadata\n  → Arc Mainnet payment contract\n  → OpenAPI URL\n\nGET /api/openapi\n  → application/yaml`}</code></div>
            </div>
          </div>
        </section>

        <section className={styles.sectionTint} id="payments">
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>PAYMENT, AUTH &amp; ACCESS</p><h2>The current request contract</h2><p>These behaviors are declared in the proxy routes, agent discovery response, OpenAPI document, and purchase-access implementation.</p></div></div>
            <div className={styles.contentGrid}>
              <article className={styles.contentCard}><h3>x402 v2 payment</h3><ul><li>Probe the intended request without <code>Payment-Signature</code>.</li><li>Read the base64 <code>PAYMENT-REQUIRED</code> header from the 402 response.</li><li>Validate and sign the offered Arc Mainnet requirement, then retry the identical request.</li></ul></article>
              <article className={styles.contentCard} id="authentication"><h3>Seller endpoint authentication</h3><ul><li>Listings can declare public, API-key, bearer, or query-parameter authentication.</li><li>Configured seller auth is injected by Mahshar when the proxy calls the upstream endpoint.</li><li>Buyer-supplied headers are not forwarded upstream.</li></ul></article>
              <article className={styles.contentCard} id="recovery"><h3>Purchase access and recovery</h3><ul><li>Paid results include a purchase-access capability for response retrieval.</li><li>Only a response marked retryable permits an exact proof and request replay.</li><li>Accounting reconciliation never resettles payment or re-executes the upstream request.</li></ul></article>
            </div>
          </div>
        </section>

        <section className={styles.section} id="wallet-funding">
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>WALLET FUNDING</p><h2>Bridge receipt and Mahshar Balance are separate steps</h2><p>The dashboard exposes both operations without combining their transaction paths.</p></div></div>
            <div className={`${styles.topicGrid} ${styles.topicGridThree}`}>
              <Link href="/dashboard/wallet/bridge" className={styles.topicCard}><span className={styles.iconBox}><PublicIcon name="bridge" /></span><h3>Bridge to Arc</h3><p>The Bridge page discovers official Circle routes for supported Mainnet source wallets and targets the connected EVM wallet on Arc Mainnet.</p></Link>
              <Link href="/dashboard/solana" className={styles.topicCard}><span className={styles.iconBox}><PublicIcon name="wallet" /></span><h3>Solana to Arc</h3><p>The Solana to Arc page moves supported SPL USDC from the connected Solana source wallet to the connected EVM wallet on Arc Mainnet.</p></Link>
              <Link href="/dashboard/wallet#deposit" className={styles.topicCard}><span className={styles.iconBox}><PublicIcon name="balance" /></span><h3>Deposit to Mahshar Balance</h3><p>The Wallet deposit is a separate, explicit action from USDC already held by the connected EVM wallet on Arc Mainnet.</p></Link>
            </div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}><div className={styles.ctaBand}><div className={styles.ctaContent}><div><h2>Need help with a product flow?</h2><p>Use the self-service support topics or contact the verified Mahshar support address.</p></div><Link href="/support" className={styles.secondaryButton}>Go to Support <PublicIcon name="arrow" /></Link></div></div></div>
        </section>
      </main>
    </PublicPageShell>
  )
}
