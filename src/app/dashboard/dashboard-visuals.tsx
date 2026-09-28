'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MahsharFlowMotif } from '@/components/MahsharFlowMotif'
import { MahsharLogo } from '@/components/MahsharLogo'
import { NavBar } from '@/components/NavBar'
import { useDashboardWorkspace } from './dashboard-workspace'
import styles from './dashboard.module.css'

export { MahsharFlowMotif } from '@/components/MahsharFlowMotif'

type IconName = 'dashboard' | 'wallet' | 'bridge' | 'bank' | 'earnings' | 'balance' | 'solana' | 'apis' | 'settings'

export function DashboardIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    wallet: <><path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6" /><path d="M20 12h-5v5h5M17 14.5h.01" /></>,
    bridge: <><path d="M4 7h9a4 4 0 0 1 4 4v1" /><path d="m14 9 3 3-3 3" /><path d="M20 17h-9a4 4 0 0 1-4-4v-1" /><path d="m10 15-3-3 3-3" /></>,
    bank: <><path d="M2.5 9 12 4l9.5 5M3 10h18M4 20h16M6 11v8m4-8v8m4-8v8m4-8v8" /></>,
    earnings: <><path d="m4 15 6-6 4 4 6-9M15 4h5v5M4 21h16" /></>,
    balance: <><circle cx="12" cy="12" r="9" /><path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9m3-10v2m0 8v2" /></>,
    solana: <><path d="m6 5-3 3h15l3-3H6Zm-3 6 3 3h15l-3-3H3Zm3 6-3 3h15l3-3H6Z" /></>,
    apis: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="8" cy="7" r="3" fill="currentColor" /><circle cx="16" cy="17" r="3" fill="currentColor" /></>,
  }
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export function DashboardSidebar() {
  const pathname = usePathname()
  const navigation = [
    { icon: 'dashboard', label: 'Dashboard', href: '/dashboard', available: true },
    { icon: 'wallet', label: 'Wallet', href: '/dashboard/wallet', available: true },
    { icon: 'bridge', label: 'Bridge', href: '/dashboard/wallet/bridge', available: true },
    { icon: 'earnings', label: 'Earnings', href: '/dashboard/earnings', available: true },
    { icon: 'solana', label: 'Solana → Arc', href: '/dashboard/solana', available: true },
    { icon: 'apis', label: 'APIs', href: '/dashboard/apis', available: true },
    { icon: 'settings', label: 'Settings', href: '/dashboard/settings', available: true },
  ] as const

  return (
    <aside className={styles.sidebar}>
      <MahsharLogo className={styles.wordmark} />
      <p className={styles.navLabel}>YOUR WORKSPACE</p>
      <nav aria-label="Dashboard navigation" className={styles.sectionNav}>
        {navigation.map(({ icon, label, href, available }) => {
          const active = pathname === href
          if (!available) {
            return <button key={icon} type="button" disabled title={`${label} will be available in a future update`}><DashboardIcon name={icon} />{label}<span className={styles.soon}>Soon</span></button>
          }
          return <Link key={icon} href={href} aria-current={active ? 'page' : undefined}><DashboardIcon name={icon} />{label}{active && <span className={styles.activeDot} />}</Link>
        })}
      </nav>
      <div className={styles.sidebarFooter}><span className={styles.footerMark} aria-hidden="true">↗</span><p>Build.<br />Monetize.</p><span>A More Open<br />AI Economy.</span><div className={styles.footerRule} /><small>Powered by possibility.</small></div>
    </aside>
  )
}

export function DashboardNavBar() {
  const { gatewayStats, gatewayUnavailable } = useDashboardWorkspace()
  return <NavBar dashboard balanceOverride={gatewayStats?.gatewayAvailable ?? null} balanceUnavailableOverride={gatewayUnavailable} pollBalance={false} />
}

export function DashboardCardHeader({ title, subtitle, icon, tone }: { title: string; subtitle: string; icon: IconName; tone: 'blue' | 'green' | 'pink' | 'purple' }) {
  return (
    <div className={`${styles.cardHeader} ${styles[tone]}`}>
      <MahsharFlowMotif variant="card" tone={tone} className={styles.cardFlow} />
      <span className={styles.headerIcon}><DashboardIcon name={icon} /></span>
      <div className={styles.headerCopy}><h2>{title}</h2><p>{subtitle}</p></div>
    </div>
  )
}

export function UsdcUnit() {
  return <span className={styles.usdcUnit}>USDC</span>
}

export function DashboardBackgroundFlow() {
  return (
    <div className={styles.backgroundFlow} aria-hidden="true">
      <MahsharFlowMotif variant="background" tone="blue" className={styles.backgroundFlowTop} />
      <MahsharFlowMotif variant="background" tone="purple" className={styles.backgroundFlowBottom} />
    </div>
  )
}
