'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { OperationsIssuesDto } from '@/lib/admin/operations-types'
import styles from './operations.module.css'

type IconName = 'overview' | 'listings' | 'payments' | 'purchases' | 'earnings' | 'infrastructure' | 'health' | 'issues' | 'logs' | 'analytics'

const navigation: Array<{ label: string; icon: IconName; href?: string }> = [
  { label: 'Overview', icon: 'overview', href: '/admin/operations' },
  { label: 'APIs & Listings', icon: 'listings', href: '/admin/operations/listings' },
  { label: 'Payments', icon: 'payments', href: '/admin/operations/payments' },
  { label: 'Purchases', icon: 'purchases', href: '/admin/operations/purchases' },
  { label: 'Earnings', icon: 'earnings' },
  { label: 'Infrastructure', icon: 'infrastructure', href: '/admin/operations/infrastructure' },
  { label: 'System Health', icon: 'health', href: '/admin/operations/system-health' },
  { label: 'Recent Issues', icon: 'issues', href: '/admin/operations/issues' },
  { label: 'Logs & Events', icon: 'logs' },
  { label: 'Analytics', icon: 'analytics' },
]

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    listings: <><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></>,
    payments: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/></>,
    purchases: <><path d="M6 7h15l-2 8H8L6 3H3"/><circle cx="9" cy="19" r="1"/><circle cx="18" cy="19" r="1"/></>,
    earnings: <><circle cx="12" cy="12" r="9"/><path d="M15 8.5c-.7-.6-1.7-1-3-1-1.7 0-3 .9-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.5-.4-3.2-1.2M12 5v14"/></>,
    infrastructure: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/></>,
    health: <><path d="M3 12h4l2-5 4 10 2-5h6"/></>,
    issues: <><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 16h.01"/></>,
    logs: <><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/></>,
    analytics: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

export function OperationsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const request = useAdminRequest()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [reviewCount, setReviewCount] = useState<number | null>(null)
  const [issueCountTruncated, setIssueCountTruncated] = useState(false)
  const [issueCountIncomplete, setIssueCountIncomplete] = useState(false)
  const lastIssueRead = useRef(0)

  const loadIssueCount = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    lastIssueRead.current = Date.now()
    try {
      const response = await request('/api/admin/operations/issues?limit=1', { cache: 'no-store' })
      if (!response.ok) throw new Error('issue count unavailable')
      const value = await response.json() as OperationsIssuesDto
      setReviewCount(value.counts.needs_attention_entities); setIssueCountTruncated(value.truncated); setIssueCountIncomplete(!value.complete)
    } catch { setReviewCount(null); setIssueCountTruncated(false); setIssueCountIncomplete(false) }
  }, [request])

  useEffect(() => { setDrawerOpen(false) }, [pathname])
  useEffect(() => {
    if (!drawerOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [drawerOpen])
  useEffect(() => {
    void loadIssueCount()
    const refresh = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastIssueRead.current >= 60_000) void loadIssueCount()
    }
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [loadIssueCount])

  return (
    <div className={`${styles.shell} ${collapsed ? styles.shellCollapsed : ''}`}>
      <button className={styles.mobileMenu} type="button" onClick={() => setDrawerOpen(true)} aria-label="Open operations navigation" aria-expanded={drawerOpen}>
        <span/><span/><span/>
      </button>
      {drawerOpen && <button className={styles.scrim} type="button" onClick={() => setDrawerOpen(false)} aria-label="Close operations navigation"/>}
      <aside className={`${styles.sidebar} ${drawerOpen ? styles.sidebarOpen : ''}`} aria-label="Operations navigation">
        <div className={styles.identity}>
          <div className={styles.mark} aria-hidden="true">M</div>
          <div className={styles.identityText}><strong>Mahshar</strong><span>Admin / Operations</span></div>
          <button type="button" className={styles.collapseButton} onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>
          </button>
          <button type="button" className={styles.drawerClose} onClick={() => setDrawerOpen(false)} aria-label="Close operations navigation">×</button>
        </div>
        <nav className={styles.navigation}>
          <p className={styles.navLabel}>Workspace</p>
          {navigation.map(item => {
            const active = item.href === '/admin/operations' ? pathname === item.href : item.href && pathname.startsWith(item.href)
            return item.href ? (
              <Link key={item.label} href={item.href} className={`${styles.navItem} ${item.icon === 'issues' ? styles.navItemWithCount : ''} ${active ? styles.navActive : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? item.label : undefined}>
                <NavIcon name={item.icon}/><span>{item.label}</span>{item.icon === 'issues' && <small className={reviewCount && reviewCount > 0 ? styles.issueCount : styles.issueCountQuiet} title={issueCountIncomplete ? 'Known review entities; one or more issue sources are unavailable' : undefined}>{reviewCount === null ? '—' : `${reviewCount}${issueCountTruncated || issueCountIncomplete ? '+' : ''} Need review`}</small>}
              </Link>
            ) : (
              <div key={item.label} className={`${styles.navItem} ${styles.navFuture}`} aria-disabled="true" title={collapsed ? `${item.label} — future phase` : undefined}>
                <NavIcon name={item.icon}/><span>{item.label}</span><small>Future</small>
              </div>
            )
          })}
        </nav>
        <div className={styles.sidebarFooter}>
          <span className={styles.readOnlyDot}/><div><strong>Read-only</strong><small>No control-plane actions</small></div>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div><span className={styles.environmentDot}/><strong>Arc Mainnet</strong><span className={styles.topbarDivider}/><span>Operations visibility</span></div>
          <div className={styles.topbarReadOnly}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Read-only</div>
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  )
}
