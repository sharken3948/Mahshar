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
      </nav>
    </footer>
  )
}
