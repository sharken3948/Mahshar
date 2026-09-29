'use client'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { OnboardingForm } from '@/components/OnboardingForm'
import Link from 'next/link'
import { BackButton } from '@/components/BackButton'
import { NavBar } from '@/components/NavBar'
import { MahsharFlowMotif } from '@/components/MahsharFlowMotif'
import styles from './seller.module.css'

export default function SellerPage() {
  const { address, isConnected } = useAccount()

  if (!isConnected) {
    return (
      <>
        <NavBar />
        <main className={styles.connectMain}>
          <div className={styles.connectCard}>
            <h1>Connect Your Wallet</h1>
            <p>You need to connect your wallet to list an API on Mahshar.</p>
            <ConnectButton />
          </div>
        </main>
      </>
    )
  }

  return (
    <>
      <NavBar />
      <main className={styles.page}>
        <div className={styles.main}>
          <MahsharFlowMotif variant="background" tone="purple" className={styles.backgroundFlow} />
          <header className={styles.pageHeader}>
            <div className={styles.headerMeta}>
              <BackButton href="/" label="Back to Mahshar" />
              <span className={styles.connection}>Connected {address?.slice(0, 6)}...{address?.slice(-4)}</span>
            </div>
            <h1>List your API</h1>
            <p>Paste your endpoint. Mahshar will help with the rest.</p>
          </header>
          <OnboardingForm sellerWallet={address ?? ''} />
          <Link href="/dashboard/apis" className={styles.footerLink}>View your listed APIs →</Link>
        </div>
      </main>
    </>
  )
}
