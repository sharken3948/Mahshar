import Link from 'next/link'
import { MahsharLogo } from './MahsharLogo'
import styles from './public-only-nav.module.css'

const publicLinks = [
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/about', label: 'What is Mahshar?' },
  { href: '/providers', label: 'For API Providers' },
  { href: '/agents', label: 'For AI Agents' },
  { href: '/docs', label: 'Documentation' },
  { href: '/support', label: 'Support' },
] as const

export function PublicOnlyNav() {
  return (
    <header className={styles.header}>
      <nav className={styles.inner} aria-label="Public navigation">
        <MahsharLogo variant="landing" />
        <div className={styles.desktopLinks}>
          {publicLinks.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          <Link href="/buyer" className={styles.buyerLink}>Open buyer application</Link>
        </div>
        <details className={styles.mobileMenu}>
          <summary aria-label="Open public navigation"><span /><span /><span /></summary>
          <div className={styles.mobileLinks}>
            {publicLinks.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
            <Link href="/buyer" className={styles.buyerLink}>Open buyer application</Link>
          </div>
        </details>
      </nav>
    </header>
  )
}
