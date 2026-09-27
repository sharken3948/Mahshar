import Link from 'next/link'
import styles from './mahshar-logo.module.css'

export function MahsharLogo({ className = '', variant = 'default' }: { className?: string; variant?: 'default' | 'landing' }) {
  return (
    <Link href="/" className={`${styles.link} ${variant === 'landing' ? styles.landing : ''} ${className}`.trim()} aria-label="Mahshar home">
      <img src="/logo.png" alt="Mahshar" width="1024" height="559" className={styles.image} />
    </Link>
  )
}
