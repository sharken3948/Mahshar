import type { Metadata } from 'next'
import { DashboardBackgroundFlow, DashboardNavBar, DashboardSidebar } from './dashboard-visuals'
import { DashboardWorkspaceProvider } from './dashboard-workspace'
import styles from './dashboard.module.css'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardWorkspaceProvider>
      <div className={styles.shell}>
        <DashboardSidebar />
        <div className={styles.topbar}><DashboardNavBar /></div>
        <main className={styles.main}>
          <DashboardBackgroundFlow />
          {children}
        </main>
      </div>
    </DashboardWorkspaceProvider>
  )
}
