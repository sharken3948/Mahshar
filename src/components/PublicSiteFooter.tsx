import Link from 'next/link'
import styles from './public-site-footer.module.css'

export function PublicSiteFooter() {
  return (
    <footer className={styles.footer}>
      <p>© {new Date().getFullYear()} Mahshar. The API economy, powered by USDC.</p>
      <nav aria-label="Footer navigation">
        <Link href="/marketplace">Marketplace</Link>
        <Link href="/providers">For API Providers</Link>
        <Link href="/agents">Agents</Link>
        <Link href="/docs">Docs</Link>
        <Link href="/about">About</Link>
        <Link href="/support">Support</Link>
        <a href="https://github.com/sharken3948/Mahshar" target="_blank" rel="noreferrer noopener" aria-label="Open Mahshar’s public GitHub repository in a new tab">GitHub</a>
        <a href="https://explorer.arc.io/tx/0xa3efb83ad9ac4f2164d36b2579104cb7fb19c986cd623206b27387330e33fa33" target="_blank" rel="noreferrer noopener" aria-label="View Mahshar’s public Arc Mainnet verification transaction in Arc Explorer in a new tab">Arc verification</a>
      </nav>
    </footer>
  )
}
