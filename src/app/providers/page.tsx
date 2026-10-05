import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicPageShell } from '@/components/PublicPageShell'
import { PublicTrustPanel } from '@/components/PublicTrustPanel'
import { providersMetadata } from '@/lib/seo/education-metadata'
import styles from '../education-pages.module.css'

export const metadata: Metadata = providersMetadata

const handledFeatures = [
  ['Discovery', 'A public Marketplace and machine-readable discovery for eligible active listings, plus an OpenAPI description of Mahshar’s public machine interface.'],
  ['Pricing', 'A provider-configured USDC price for each paid call.'],
  ['Payment flow', 'The implemented x402 requirement, authorization, verification, and accounting path.'],
  ['Access', 'Payment-aware proxy execution against the configured request contract.'],
  ['Credential protection', 'Stored seller credentials are omitted from public discovery and buyer-facing listing data, then injected server-side when the configured listing requires them.'],
  ['Earnings', 'Accounted paid calls feed the existing seller earnings and withdrawal interfaces.'],
] as const

const providerControls = [
  ['Your upstream API', 'The endpoint and infrastructure remain yours.'],
  ['Listing status', 'You can activate or deactivate an eligible listing; verification and marketplace health safeguards still apply.'],
  ['Price', 'You set the USDC price per call.'],
  ['Presentation', 'You manage the name, description, and category.'],
  ['Request contract', 'You configure the supported method and declared buyer inputs.'],
  ['Authentication', 'You choose the supported public, API-key, bearer, or query-credential mode.'],
] as const

const onboarding = [
  ['Connect', 'Connect the provider wallet used to own and manage the listing.'],
  ['Analyze', 'Paste the public HTTPS endpoint and run the current endpoint analysis.'],
  ['Configure', 'Review the name, category, HTTP method, authentication mode, and description.'],
  ['Describe the request', 'Confirm body behavior and any declared path or query inputs buyers may send.'],
  ['Price and preview', 'Set the USDC price per call and review the Marketplace presentation.'],
  ['Publish', 'Mahshar saves the listing, rechecks the stored endpoint contract, and activates it when the checks pass.'],
] as const

const faqs = [
  ['Do I need to rebuild my API?', 'Mahshar is designed to list an existing HTTPS API endpoint. You configure how Mahshar may call it; your direct integration and infrastructure remain separate.'],
  ['Do I need to understand x402 first?', 'No prior x402 expertise is required to begin the provider flow. The Seller interface collects the endpoint, request contract, authentication mode, public metadata, and per-call price Mahshar needs.'],
  ['Can my API use API-key or bearer authentication?', 'Yes. The current listing flow supports public access, an API key in the x-api-key header, bearer authentication, and a configured query credential.'],
  ['Who sets the API price?', 'The provider sets the listing’s positive USDC price per call and can manage it through the existing listing interfaces.'],
  ['Does Mahshar include my upstream credentials in listing data?', 'No. Stored seller credentials are not included in public discovery or buyer-facing listing data. When a configured listing requires one, Mahshar injects it server-side before calling the upstream API.'],
  ['Can AI agents discover my API?', 'Eligible active listings can appear through Mahshar’s machine-readable agent discovery. The OpenAPI document describes how clients use Mahshar’s public machine interface.'],
  ['What does the buyer pay with?', 'Mahshar’s current paid-call architecture uses USDC through its x402 flow on Arc Mainnet.'],
  ['Which network does Mahshar use?', 'Mahshar’s implemented production payment contract targets Arc Mainnet.'],
  ['Can I continue serving customers outside Mahshar?', 'Yes. Mahshar is an additional listing and access path for the configured endpoint; it does not replace your existing direct customer relationships.'],
  ['How do I get started?', 'Open the Seller application, connect the provider wallet, paste the endpoint, and follow the analysis, configuration, pricing, and publish flow.'],
] as const

export default function ProvidersPage() {
  return (
    <PublicPageShell>
      <main className={styles.page}>
        <section className={`${styles.hero} ${styles.providerHero}`}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.breadcrumb}><Link href="/">Explore</Link><span>›</span><strong>For API Providers</strong></div>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>FOR API PROVIDERS</p>
                <h1>Add an agent-ready, pay-per-call channel to your existing API.</h1>
                <p className={styles.heroLead}>Mahshar gives providers an additional way to offer an existing API for discoverable, pay-per-call USDC access. Builders and autonomous agents get a clear interface for finding and purchasing calls; you keep operating the upstream service.</p>
                <div className={styles.actions}>
                  <Link href="/seller" className={styles.primaryButton}>List Your API <ArrowIcon /></Link>
                  <Link href="/marketplace" className={styles.secondaryButton}>See the Marketplace <ArrowIcon /></Link>
                </div>
              </div>
              <ProviderDiagram />
            </div>
          </div>
        </section>

        <PublicTrustPanel />

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.splitStatement}>
              <div><p className={styles.eyebrow}>AN ADDITIONAL CHANNEL</p><h2>Your API does not need a new business model.</h2></div>
              <div><p>Mahshar can sit alongside the way you already sell and operate your service. Existing customers can continue using your domain, subscriptions, infrastructure, and direct authentication.</p><p>For a Mahshar listing, you define a supported request contract and per-call price. Mahshar adds a distinct agent and pay-per-call path through its Marketplace architecture.</p></div>
            </div>
            <div className={styles.preserveStrip} aria-label="Provider relationships that remain in place">
              {['Current customers', 'Existing subscriptions', 'Your API domain', 'Your infrastructure', 'Direct authentication'].map(item => <span key={item}><CheckIcon />{item}</span>)}
            </div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <SectionIntro eyebrow="TWO CUSTOMER JOURNEYS" title="Traditional access and agent-ready access solve different needs." copy="A human-led commercial journey can support ongoing relationships and negotiated plans. A machine-led journey needs terms it can inspect and act on inside a request flow." />
            <div className={styles.accessComparison}>
              <FlowLane label="TRADITIONAL API ACCESS" actor="Human or team" steps={['Pricing page', 'Signup', 'Billing', 'API key', 'Integration']} />
              <FlowLane label="AGENT-READY MAHSHAR ACCESS" actor="Builder or agent" steps={['Discover', 'Inspect price', 'Payment requirement', 'Pay', 'Call', 'Receive']} accent />
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.distributionGrid}>
              <div>
                <p className={styles.eyebrow}>WHY AGENTS CHANGE DISTRIBUTION</p>
                <h2>Being callable is only the beginning.</h2>
                <p>Software can choose a service while it is completing a task. For that decision to be programmatic, the service also needs to be discoverable, understandable, priced, payable, and described by a predictable request contract.</p>
                <p>Mahshar connects those requirements through its public Marketplace and agent discovery endpoint. Its OpenAPI document describes how clients use the public machine interface.</p>
                <div className={styles.inlineLinks}><Link href="/agents" className={styles.textLink}>Explore agent interfaces <ArrowIcon /></Link><Link href="/docs" className={styles.textLink}>Read documentation <ArrowIcon /></Link></div>
              </div>
              <div className={styles.requirementStack}>
                {['Discoverability', 'Machine-readable information', 'Clear per-call pricing', 'Programmable payment', 'Declared request contract'].map((item, index) => <div key={item}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item}</strong></div>)}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.darkSection}>
          <div className={styles.container}>
            <SectionIntroDark eyebrow="THE MARKETPLACE LAYER" title="What Mahshar handles." copy="The provider continues to run the upstream service. Mahshar handles the implemented marketplace path around discovery, payment-aware access, and seller accounting." />
            <div className={styles.handledGrid}>
              {handledFeatures.map(([title, copy], index) => <article key={title}><span>{String(index + 1).padStart(2, '0')}</span><h3>{title}</h3><p>{copy}</p></article>)}
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <SectionIntro eyebrow="PROVIDER CONTROL" title="You control the service and configure the listing." copy="You control the upstream API and listing configuration. Activation remains subject to Mahshar’s verification and marketplace health safeguards." />
            <div className={styles.controlGrid}>
              {providerControls.map(([title, copy]) => <article key={title}><CheckIcon /><div><h3>{title}</h3><p>{copy}</p></div></article>)}
            </div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <div className={styles.noJargonPanel}>
              <div>
                <p className={styles.eyebrow}>YOU DO NOT NEED TO UNDERSTAND X402 FIRST</p>
                <h2>You provide the API. Mahshar handles the marketplace payment layer.</h2>
                <p>Mahshar is designed to let providers list an existing API without rebuilding its own billing flow around x402. The Seller application asks for the endpoint and the listing information Mahshar actually needs, while the buyer-facing x402 exchange remains part of Mahshar’s Marketplace flow.</p>
                <p>This is not a promise of zero configuration: the request contract, authentication mode, public metadata, and price still need to be accurate.</p>
              </div>
              <div className={styles.layerStack} aria-label="Provider and Mahshar responsibilities">
                <div><small>YOU PROVIDE</small><strong>API endpoint</strong><span>Contract · availability · direct customers</span></div>
                <i aria-hidden="true">+</i>
                <div><small>MAHSHAR PROVIDES</small><strong>Marketplace path</strong><span>Discovery · x402 · USDC · access</span></div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <SectionIntro eyebrow="CURRENT PROVIDER FLOW" title="From endpoint to active listing." copy="The production Seller application uses a focused workspace rather than a generic submission form. Publication depends on the current endpoint and request-contract checks passing." />
            <ol className={styles.onboardingFlow}>
              {onboarding.map(([title, copy], index) => <li key={title}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{title}</h3><p>{copy}</p></div></li>)}
            </ol>
            <div className={styles.flowAction}><Link href="/seller" className={styles.primaryButton}>Open Seller application <ArrowIcon /></Link><span>Wallet connection is required in the Seller application.</span></div>
          </div>
        </section>

        <section className={styles.securitySection}>
          <div className={styles.container}>
            <div className={styles.securityPanel}>
              <div className={styles.securityIcon} aria-hidden="true"><LockIcon /></div>
              <div><p className={styles.eyebrow}>WHAT HAPPENS TO MY CREDENTIALS?</p><h2>Configured credentials stay out of public listing data.</h2><p>Stored seller credentials are not included in public discovery or buyer-facing listing data. When required by the configured listing, Mahshar injects the credential server-side before calling the upstream API.</p><Link href="/docs#providers" className={styles.textLink}>Read provider documentation <ArrowIcon /></Link></div>
            </div>
          </div>
        </section>

        <section className={styles.sectionTint}>
          <div className={styles.container}>
            <SectionIntro eyebrow="PROVIDER FAQ" title="The practical questions, answered plainly." copy="These answers describe Mahshar’s current production behavior. They do not promise revenue, endpoint performance, or geographic availability." />
            <div className={styles.faqList}>
              {faqs.map(([question, answer]) => <details key={question} className={styles.faqItem}><summary>{question}</summary><div><p>{answer}</p></div></details>)}
            </div>
            <div className={styles.resourcesPanel}>
              <div><p className={styles.eyebrow}>TECHNOLOGY CONTEXT</p><h2>Learn about the wider agent-payment ecosystem.</h2><p>These resources explain technologies used by Mahshar’s current marketplace payment layer.</p></div>
              <div className={styles.resourceLinks}>
                <a href="https://developers.circle.com/agent-stack/agent-marketplace" target="_blank" rel="noreferrer noopener">Circle Agent Marketplace <ExternalIcon /></a>
                <a href="https://developers.circle.com/gateway/nanopayments/concepts/x402" target="_blank" rel="noreferrer noopener">Circle: What is x402? <ExternalIcon /></a>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.finalSection}>
          <div className={styles.container}>
            <div className={styles.finalCta}>
              <p className={styles.eyebrowLight}>A NEW DISTRIBUTION SURFACE</p>
              <h2>Keep operating your API. Add a path for builders and autonomous agents.</h2>
              <div className={styles.actions}><Link href="/seller" className={styles.lightButton}>List Your API <ArrowIcon /></Link><Link href="/docs#providers" className={styles.ghostButton}>Read Provider Documentation <ArrowIcon /></Link></div>
            </div>
          </div>
        </section>
      </main>
    </PublicPageShell>
  )
}

function ProviderDiagram() {
  return (
    <aside className={styles.ecosystemDiagram} aria-label="Existing API through Mahshar to builders and AI agents">
      <div className={styles.diagramHeader}><span>AN ADDITIONAL ACCESS PATH</span><i>Pay per call</i></div>
      <div className={styles.providerFlow}>
        <div className={styles.endpointNode}><small>YOUR EXISTING API</small><strong>api.example.com</strong><span>Provider-operated endpoint</span></div>
        <div className={styles.verticalConnector} aria-hidden="true"><i /><span>Configure listing</span></div>
        <div className={styles.providerMahshar}><strong>Mahshar</strong><div><span>Discovery</span><span>x402</span><span>USDC</span><span>Access</span></div></div>
        <div className={styles.consumerRow}><div><small>BUILDER</small><strong>Application</strong></div><div><small>AGENT</small><strong>Autonomous client</strong></div></div>
      </div>
    </aside>
  )
}

function FlowLane({ label, actor, steps, accent = false }: { label: string; actor: string; steps: readonly string[]; accent?: boolean }) {
  return <article className={`${styles.flowLane} ${accent ? styles.flowLaneAccent : ''}`}><header><span>{label}</span><strong>{actor}</strong></header><ol>{steps.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}</ol></article>
}

function SectionIntro({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <header className={styles.sectionIntro}><p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2><p>{copy}</p></header>
}

function SectionIntroDark({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <header className={`${styles.sectionIntro} ${styles.sectionIntroDark}`}><p className={styles.eyebrowLight}>{eyebrow}</p><h2>{title}</h2><p>{copy}</p></header>
}

function ArrowIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg> }
function ExternalIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M13 11l6-6M19 13v6H5V5h6" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> }
function LockIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg> }
