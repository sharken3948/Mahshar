import Link from 'next/link'
import styles from './back-button.module.css'

export function BackButton({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <Link href={href} aria-label={label} className={[styles.backButton, className].filter(Boolean).join(' ')}>
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
      {label}
    </Link>
  )
}
