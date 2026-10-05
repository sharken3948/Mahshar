import Link from 'next/link'
import styles from './public-trust-panel.module.css'

const GITHUB_URL = 'https://github.com/sharken3948/Mahshar'
const ARC_EXPLORER = 'https://explorer.arc.io'
const PLATFORM_WALLET = '0x052650D1764406d702252B20B2294346A594A1ef'
const VERIFIED_TRANSACTION = '0xa3efb83ad9ac4f2164d36b2579104cb7fb19c986cd623206b27387330e33fa33'

export function PublicTrustPanel() {
  return (
    <section className={styles.section} aria-labelledby="public-trust-heading">
      <div className={styles.inner}>
        <div className={styles.intro}>
          <p>PUBLIC REFERENCES</p>
          <h2 id="public-trust-heading">Public product references, in one place.</h2>
          <span>Find Mahshar’s network, source, documentation, and support.</span>
        </div>
        <div className={styles.signals}>
          <div className={styles.signal}>
            <small>PRODUCTION NETWORK</small>
            <strong>Arc Mainnet</strong>
            <span>Chain ID 5042</span>
          </div>
          <div className={styles.signal}>
            <small>OPEN IMPLEMENTATION</small>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" aria-label="Open Mahshar’s public GitHub repository in a new tab">Public GitHub <ExternalIcon /></a>
            <span>Source and project documentation</span>
          </div>
          <div className={styles.signal}>
            <small>PUBLIC ARC VERIFICATION</small>
            <a href={`${ARC_EXPLORER}/tx/${VERIFIED_TRANSACTION}`} target="_blank" rel="noreferrer noopener" aria-label="View Mahshar’s public Arc Mainnet transaction in Arc Explorer in a new tab">View transaction <ExternalIcon /></a>
            <span><a className={styles.inlineLink} href={`${ARC_EXPLORER}/address/${PLATFORM_WALLET}`} target="_blank" rel="noreferrer noopener" title={PLATFORM_WALLET} aria-label={`View Mahshar’s public Arc Mainnet platform wallet ${PLATFORM_WALLET} in Arc Explorer in a new tab`}>0x0526…A1ef</a> · Platform wallet · Arc Explorer</span>
          </div>
          <div className={styles.signal}>
            <small>DOCUMENTATION &amp; SUPPORT</small>
            <Link href="/docs">Read the docs <ArrowIcon /></Link>
            <span><a className={styles.inlineLink} href="mailto:support@mahshar.xyz">support@mahshar.xyz</a></span>
          </div>
        </div>
        <p className={styles.disclaimer}>Mahshar uses Circle technologies and operates on Arc Mainnet. It is not operated by, endorsed by, or part of Circle.</p>
      </div>
    </section>
  )
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
}

function ExternalIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M13 11l6-6M19 13v6H5V5h6" /></svg>
}
