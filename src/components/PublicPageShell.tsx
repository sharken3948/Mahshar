import { PublicOnlyNav } from './PublicOnlyNav'
import { PublicSiteFooter } from './PublicSiteFooter'
import styles from './public-page-shell.module.css'

export function PublicPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <PublicOnlyNav />
      {children}
      <PublicSiteFooter />
    </div>
  )
}
