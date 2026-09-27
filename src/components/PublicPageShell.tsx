import { NavBar } from './NavBar'
import { PublicSiteFooter } from './PublicSiteFooter'
import styles from './public-page-shell.module.css'

export function PublicPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <NavBar landing />
      {children}
      <PublicSiteFooter />
    </div>
  )
}
