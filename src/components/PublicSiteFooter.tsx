import Link from 'next/link'
import styles from './public-site-footer.module.css'

export function PublicSiteFooter() {
  return (
    <footer className={styles.footer}>
      <p>© {new Date().getFullYear()} Mahshar. The API economy, powered by USDC.</p>
      <nav aria-label="Footer navigation">
        <Link href="/marketplace">Marketplace</Link>
        <Link href="/agents">For AI Agents</Link>
        <Link href="/docs">Documentation</Link>
        <Link href="/support">Support</Link>
      </nav>
    </footer>
  )
}
