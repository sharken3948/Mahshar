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
            <BackButton href="/" label="Back to Mahshar" />
            <h1>List Your API</h1>
            <p>Turn an existing API endpoint into a paid service for agents and applications.</p>
            <span className={styles.connection}>Connected {address?.slice(0, 6)}...{address?.slice(-4)}</span>
          </header>
          <OnboardingForm sellerWallet={address ?? ''} />
          <Link href="/dashboard/apis" className={styles.footerLink}>View your listed APIs →</Link>
        </div>
      </main>
    </>
  )
}
