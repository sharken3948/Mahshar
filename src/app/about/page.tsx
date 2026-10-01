import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicPageShell } from '@/components/PublicPageShell'
import { aboutMetadata } from '@/lib/seo/education-metadata'
import styles from '../education-pages.module.css'

export const metadata: Metadata = aboutMetadata

const howItWorks = [
  ['Discover', 'Active APIs appear in Mahshar’s public Marketplace and machine-readable agent interface.'],
  ['Inspect', 'Builders and agents can review public metadata, the request contract, and the listed USDC price.'],
  ['Pay', 'A request to a paid resource returns an x402 payment requirement that the buyer can authorize in USDC.'],
  ['Execute', 'After payment validation, Mahshar’s proxy calls the configured provider endpoint under its listing contract.'],
  ['Receive', 'The result returns through Mahshar’s purchase-scoped response and access flow.'],
] as const

const traditionalSteps = ['Find a product', 'Create an account', 'Choose a plan', 'Obtain credentials', 'Configure billing']
const agentSteps = ['Discover a service', 'Inspect terms', 'Read the price', 'Authorize payment', 'Call the interface']

export default function AboutPage() {
  return (
    <PublicPageShell>
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><strong>What is Mahshar?</strong></div>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>WHAT IS MAHSHAR?</p>
                <h1>APIs become economic building blocks for agents.</h1>
                <p className={styles.heroLead}>Mahshar is a marketplace and payment-aware access layer for APIs. Providers can offer an existing endpoint at a per-call USDC price, while builders and autonomous agents can discover it, pay for a request, and receive the result through one coherent interface.</p>
                <p className={styles.heroNote}>Mahshar connects the transaction. It does not own or replace the provider’s backend.</p>
                <div className={styles.actions}>
                  <Link href="/marketplace" className={styles.primaryButton}>Explore Marketplace <ArrowIcon /></Link>
                  <Link href="/providers" className={styles.secondaryButton}>For API Providers <ArrowIcon /></Link>
                </div>
              </div>
              <EcosystemDiagram />
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <SectionIntro eyebrow="THE MISSING LAYER" title="APIs were built for integration. Agents add a new kind of customer." copy="Conventional API sales often begin with a person evaluating a product and setting up an ongoing commercial relationship. That remains useful. An autonomous client, however, also needs a path it can understand and act on during execution." />
            <div className={styles.journeyComparison}>
              <Journey title="A familiar API journey" label="HUMAN-LED" steps={traditionalSteps} />
              <div className={styles.journeyBridge} aria-hidden="true"><span>+</span><small>another path</small></div>
              <Journey title="An agent-ready journey" label="PROGRAMMATIC" steps={agentSteps} accent />
            </div>
            <p className={styles.sectionFootnote}>Mahshar adds a discovery and pay-per-call surface alongside existing subscriptions, direct contracts, and provider-owned customer relationships.</p>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <SectionIntro eyebrow="HOW MAHSHAR WORKS" title="From discovery to a purchased result." copy="The public catalog and the paid execution path have distinct jobs. Public pages explain what is available; the Buyer application and agent interface handle actual paid use." />
            <ol className={styles.workflow}>
              {howItWorks.map(([title, copy], index) => <li key={title} className={styles.workflowCard}><span>{String(index + 1).padStart(2, '0')}</span><h3>{title}</h3><p>{copy}</p></li>)}
            </ol>
          </div>
        </section>

        <section className={styles.darkSection}>
          <div className={styles.container}>
            <div className={styles.protocolGrid}>
              <div>
                <p className={styles.eyebrowLight}>X402 WITHOUT THE JARGON</p>
                <h2>Payment becomes part of the request conversation.</h2>
                <p>The web has long reserved the status <strong>402 Payment Required</strong>. x402 is an open standard that uses that HTTP response to communicate a machine-readable payment requirement.</p>
                <p>A client requests a paid resource, learns what payment is required, authorizes it, and retries the request with that payment attached. x402 defines the negotiation; it is not a Mahshar-only protocol, and an API does not support it automatically just because it is online.</p>
              </div>
              <div className={styles.paymentSequence} aria-label="x402 request sequence">
                {['Request', '402 Payment Required', 'USDC authorization', 'Paid request', 'API response'].map((label, index) => <div key={label}><span>{index + 1}</span><strong>{label}</strong>{index < 4 && <i aria-hidden="true">↓</i>}</div>)}
              </div>
            </div>
            <p className={styles.protocolNote}>Mahshar’s current payment architecture applies this flow with USDC on Arc Mainnet.</p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.contextGrid}>
              <article className={styles.contextCard}>
                <span className={styles.contextMark}>$</span>
                <p className={styles.eyebrow}>WHY USDC?</p>
                <h2>A programmable unit for per-call prices.</h2>
                <p>USDC gives Mahshar a digital-dollar unit of account that software can work with directly. A listing can express a clear price for one call, including small pay-per-use amounts, without turning that single request into a subscription.</p>
              </article>
              <article className={styles.contextCard}>
                <span className={styles.contextMark}>A</span>
                <p className={styles.eyebrow}>WHY ARC?</p>
                <h2>The network behind Mahshar’s production payment contract.</h2>
                <p>Arc is an open Layer-1 network purpose-built for programmable money in Circle’s ecosystem. Mahshar’s implemented production x402 architecture targets Arc Mainnet; that is an implementation choice, not a claim that Mahshar operates or represents Arc.</p>
              </article>
            </div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <SectionIntro eyebrow="BUILT FOR TWO SIDES" title="One marketplace. Two different jobs to be done." copy="Providers need distribution and controlled access. Builders and agents need a service they can find, understand, and call." />
            <div className={styles.audienceGrid}>
              <article className={`${styles.audienceCard} ${styles.providerCard}`}>
                <p className={styles.cardLabel}>FOR API PROVIDERS</p>
                <h3>Extend an existing API into a pay-per-call channel.</h3>
                <ul>
                  <li>List an existing endpoint through Mahshar’s provider flow.</li>
                  <li>Set the implemented USDC price per call.</li>
                  <li>Keep configured upstream credentials on the server where applicable.</li>
                  <li>Track paid calls and earnings through the current seller interfaces.</li>
                </ul>
                <Link href="/providers" className={styles.textLink}>For API Providers <ArrowIcon /></Link>
              </article>
              <article className={`${styles.audienceCard} ${styles.agentCard}`}>
                <p className={styles.cardLabel}>FOR BUILDERS AND AGENTS</p>
                <h3>Discover a capability when the work demands it.</h3>
                <ul>
                  <li>Browse active APIs and their public metadata.</li>
                  <li>Inspect the listed method, category, and USDC price.</li>
                  <li>Pay per call through Mahshar’s implemented x402 flow.</li>
                  <li>Discover eligible active listings through agent discovery, then use Mahshar’s OpenAPI-described machine interface programmatically.</li>
                </ul>
                <div className={styles.inlineLinks}><Link href="/marketplace" className={styles.textLink}>Explore Marketplace <ArrowIcon /></Link><Link href="/agents" className={styles.textLink}>Build with Agents <ArrowIcon /></Link></div>
              </article>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <SectionIntro eyebrow="CLEAR BOUNDARIES" title="What Mahshar does — and what it does not do." copy="A useful marketplace should make its role legible. Mahshar coordinates discovery, payment-aware access, and marketplace accounting while the provider remains responsible for the upstream service." />
            <div className={styles.boundaryGrid}>
              <BoundaryPanel title="Mahshar provides" tone="positive" items={['Public discovery and API metadata', 'Provider-set pay-per-call pricing', 'An x402 payment flow in USDC', 'Payment-aware proxy execution', 'Server-side credential injection where configured', 'Purchase-scoped result access', 'Seller call and earnings interfaces']} />
              <BoundaryPanel title="Mahshar does not" tone="neutral" items={['Include stored seller credentials in public discovery or buyer-facing listing data', 'Require public visitors to connect a wallet', 'Own the provider’s upstream API', 'Silently rewrite the provider’s backend', 'Promise an upstream endpoint’s availability or quality']} />
            </div>
            <div className={styles.resourcesPanel}>
              <div><p className={styles.eyebrow}>OFFICIAL RESOURCES</p><h2>Continue with the underlying standards.</h2><p>These sources describe the broader technologies Mahshar uses. Mahshar is an independent product and is not presented as operated or endorsed by Circle.</p></div>
              <div className={styles.resourceLinks}>
                <a href="https://developers.circle.com/gateway/nanopayments/concepts/x402" target="_blank" rel="noreferrer noopener">Circle: What is x402? <ExternalIcon /></a>
                <a href="https://developers.circle.com/agent-stack" target="_blank" rel="noreferrer noopener">Circle Agent Stack <ExternalIcon /></a>
                <a href="https://docs.arc.io/arc-chain" target="_blank" rel="noreferrer noopener">Arc network overview <ExternalIcon /></a>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.finalSection}>
          <div className={styles.container}>
            <div className={styles.finalCta}>
              <p className={styles.eyebrowLight}>THE API ECONOMY IS BECOMING CALLABLE</p>
              <h2>Find the next capability—or make yours available.</h2>
              <div className={styles.actions}><Link href="/marketplace" className={styles.lightButton}>Explore APIs <ArrowIcon /></Link><Link href="/seller" className={styles.ghostButton}>List Your API <ArrowIcon /></Link></div>
            </div>
          </div>
        </section>
      </main>
    </PublicPageShell>
  )
}

function EcosystemDiagram() {
  return (
    <aside className={styles.ecosystemDiagram} aria-label="API provider to Mahshar to builders and AI agents">
      <div className={styles.diagramHeader}><span>THE MAHSHAR LAYER</span><i>Arc Mainnet</i></div>
      <div className={styles.diagramFlow}>
        <div className={styles.diagramNode}><small>SUPPLY</small><strong>API Provider</strong><span>Existing endpoint</span></div>
        <div className={styles.diagramConnector}><i /><span>List</span></div>
        <div className={styles.mahsharNode}><small>DISCOVERY + ACCESS</small><strong>Mahshar</strong><div><span>Discover</span><span>Price</span><span>Pay</span><span>Call</span></div></div>
        <div className={styles.diagramConnector}><i /><span>Receive</span></div>
        <div className={styles.diagramConsumers}><div><small>MACHINE</small><strong>AI Agent</strong></div><div><small>HUMAN</small><strong>Builder</strong></div></div>
      </div>
      <p>Public discovery stays open. Paid execution moves through the Buyer or agent request flow.</p>
    </aside>
  )
}

function Journey({ title, label, steps, accent = false }: { title: string; label: string; steps: readonly string[]; accent?: boolean }) {
  return <article className={`${styles.journeyCard} ${accent ? styles.journeyAccent : ''}`}><div><span>{label}</span><h3>{title}</h3></div><ol>{steps.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}</ol></article>
}

function SectionIntro({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <header className={styles.sectionIntro}><p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2><p>{copy}</p></header>
}

function BoundaryPanel({ title, tone, items }: { title: string; tone: 'positive' | 'neutral'; items: readonly string[] }) {
  return <article className={`${styles.boundaryPanel} ${tone === 'positive' ? styles.boundaryPositive : ''}`}><h3>{title}</h3><ul>{items.map(item => <li key={item}><CheckIcon />{item}</li>)}</ul></article>
}

function ArrowIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg> }
function ExternalIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M13 11l6-6M19 13v6H5V5h6" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> }
