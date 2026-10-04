import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicIcon } from '@/components/PublicIcon'
import { PublicPageShell } from '@/components/PublicPageShell'
import styles from '../public-pages.module.css'

export const metadata: Metadata = {
  title: 'AI Agents | Mahshar',
  description: 'Use Mahshar’s public discovery, OpenAPI, proxy, and x402 contracts from an autonomous client.',
  alternates: { canonical: '/agents' },
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    title: 'AI Agents | Mahshar',
    description: 'Use Mahshar’s public discovery, OpenAPI, proxy, and x402 contracts from an autonomous client.',
    url: '/agents',
  },
  twitter: {
    card: 'summary',
    title: 'AI Agents | Mahshar',
    description: 'Use Mahshar’s public discovery, OpenAPI, proxy, and x402 contracts from an autonomous client.',
  },
}

const features = [
  { icon: 'discover' as const, title: 'Machine-readable discovery', copy: 'The discovery endpoint returns active listings with methods, proxy URLs, request metadata, prices, and response contracts.' },
  { icon: 'api' as const, title: 'Two proxy styles', copy: 'Listings declare either a direct path route for matching GET or POST calls, or the envelope route for GET, POST, PUT, and DELETE.' },
  { icon: 'payment' as const, title: 'Arc Mainnet x402', copy: 'Paid calls use x402 v2 payment requirements for Arc Mainnet and settle against the payment terms returned by the 402 challenge.' },
  { icon: 'auth' as const, title: 'Purchase access', copy: 'Paid responses include a purchase capability that can retrieve only the private response for that exact purchase.' },
]

const resources = [
  { icon: 'api' as const, title: 'Public API marketplace', copy: 'Browse crawlable pages for active APIs before using the machine contract to execute a call.', href: '/marketplace', label: 'Browse APIs' },
  { icon: 'discover' as const, title: 'Raw machine discovery', copy: 'View the public JSON catalog consumed by agents. This is machine data, not a product page.', href: '/api/agent/discover', label: 'View raw discovery JSON' },
  { icon: 'docs' as const, title: 'OpenAPI 3.1 specification', copy: 'Inspect the public discovery, execution, access, and recovery contract.', href: '/api/openapi', label: 'Open OpenAPI specification' },
  { icon: 'book' as const, title: 'Integration guide', copy: 'Follow the documented discovery, payment, delivery-state, and recovery sequence.', href: '/docs#agent-integration', label: 'Read guide' },
  { icon: 'code' as const, title: 'Client example', copy: 'The repository client covers discovery, probes, signing, execution, retrieval, and replay checks.', path: 'scripts/mahshar-agent-client.mts' },
  { icon: 'terminal' as const, title: 'E2E harness', copy: 'The repository harness has a dry run that fetches discovery and OpenAPI without signing or sending a payment.', path: 'scripts/mahshar-agent-e2e.mts' },
]

export default function AgentsPage() {
  return (
    <PublicPageShell>
      <main>
        <section className={styles.hero}>
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><strong>Agents</strong></div>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>PUBLIC MACHINE INTERFACE</p>
                <h1>Agent-ready API access,<span>defined by a public contract.</span></h1>
                <p className={styles.lead}>Mahshar exposes active API listings, request contracts, payment requirements, and proxy execution details through its discovery endpoint and OpenAPI document.</p>
                <div className={styles.actions}>
                  <Link href="/api/agent/discover" className={styles.primaryButton}>View raw discovery JSON <PublicIcon name="arrow" /></Link>
                  <Link href="/docs#agent-integration" className={styles.secondaryButton}>Read integration guide</Link>
                </div>
              </div>
              <div className={styles.heroVisual} aria-hidden="true">
                <span className={styles.orbit} /><span className={styles.orbit} />
                <span className={styles.visualTag}><strong>Discover</strong>active listings</span>
                <div className={styles.agentCore}><PublicIcon name="agent" /></div>
                <span className={styles.visualTag}><strong>Execute</strong>through the proxy</span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>PUBLIC CONTRACT</p><h2>What the current agent interface exposes</h2><p>Each capability below is present in the discovery route, OpenAPI contract, proxy implementation, or purchase-access flow.</p></div></div>
            <div className={styles.featureGrid}>{features.map(item => <article key={item.title} className={styles.featureCard}><span className={styles.iconBox}><PublicIcon name={item.icon} /></span><h3>{item.title}</h3><p>{item.copy}</p></article>)}</div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>REQUEST FLOW</p><h2>How an agent calls a listed API</h2><p>The public contract describes the full sequence from catalog selection through paid execution.</p></div></div>
            <div className={styles.workflow}>
              <article className={styles.workflowCard}><h3>Discover</h3><p>Fetch active listings from <code className={styles.inlineCode}>/api/agent/discover</code> and follow its pagination contract.</p></article>
              <article className={styles.workflowCard}><h3>Inspect</h3><p>Use the listing method, proxy style, request metadata, schemas when present, and advertised price.</p></article>
              <article className={styles.workflowCard}><h3>Authorize payment</h3><p>Probe without a payment signature, validate the returned Arc Mainnet x402 v2 requirement, then sign its authorization.</p></article>
              <article className={styles.workflowCard}><h3>Execute and retain access</h3><p>Replay the identical request with the payment signature and persist the returned purchase-access capability.</p></article>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>DEVELOPER RESOURCES</p><h2>Use the existing contracts and examples</h2><p>These destinations are implemented routes or files in the Mahshar repository.</p></div></div>
            <div className={styles.resourceGrid}>{resources.map(item => item.href ? <Link key={item.title} href={item.href} className={styles.resourceCard}><span className={styles.iconBox}><PublicIcon name={item.icon} /></span><h3>{item.title}</h3><p>{item.copy}</p><span className={styles.smallLink}>{item.label} <PublicIcon name="arrow" /></span></Link> : <article key={item.title} className={styles.resourceCard}><span className={styles.iconBox}><PublicIcon name={item.icon} /></span><h3>{item.title}</h3><p>{item.copy}</p><code className={styles.resourcePath}>{item.path}</code></article>)}</div>
          </div>
        </section>

        <section className={styles.sectionTint} id="recovery">
          <div className={styles.container}>
            <div className={styles.contractPanel}>
              <div><p className={styles.eyebrow}>DELIVERY &amp; RECOVERY</p><h2>Retry behavior is declared, not guessed.</h2><p>A paid response reports its delivery state and retryability. The integration guide permits replay of the exact proof and request only when the response marks it retryable. The reconciliation route finalizes durable accounting only; it does not settle again or execute the upstream API.</p></div>
              <div className={styles.codePanel}><code>{`discovery  GET  /api/agent/discover\nspec       GET  /api/openapi\npath       GET|POST /api/proxy/{api_id}\nenvelope   POST /api/proxy\nretrieve   GET  /api/calls/last-response\nreconcile  POST /api/payments/reconcile`}</code></div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}><div className={styles.ctaBand}><div className={styles.ctaContent}><div><h2>Continue with the human-readable documentation.</h2><p>Review the public contract, payment sequence, access model, and recovery rules in one place.</p></div><Link href="/docs" className={styles.secondaryButton}>Open documentation <PublicIcon name="arrow" /></Link></div></div></div>
        </section>
      </main>
    </PublicPageShell>
  )
}
