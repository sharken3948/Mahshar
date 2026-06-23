'use client'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { OnboardingForm } from '@/components/OnboardingForm'
import Link from 'next/link'
import { NavBar } from '@/components/NavBar'

export default function SellerPage() {
  const { address, isConnected } = useAccount()

  if (!isConnected) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center gap-6 px-6 pt-36">
          <h1 className="text-2xl font-bold text-[#0D0D0D]">Connect Your Wallet</h1>
          <p className="text-[#6B7280] text-center max-w-sm">You need to connect your wallet to list an API on Mahshar.</p>
          <ConnectButton />
        </main>
      </>
    )
  }

  return (
    <>
    <NavBar />
    <main className="min-h-screen bg-[#F5F5F0] px-6 pt-40 pb-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#00B050] hover:bg-[#008F42] text-white transition-colors">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </Link>
        </div>
        <h1 className="text-3xl font-bold text-[#0D0D0D] mb-1">List Your API</h1>
        <p className="text-[#6B7280] text-sm mb-6">
          Connected: {address?.slice(0, 6)}...{address?.slice(-4)}
        </p>
        <OnboardingForm sellerWallet={address ?? ''} />
        <div className="mt-6 text-center">
          <Link href="/dashboard" className="text-[#2775CA] text-sm hover:underline">
            View your listed APIs →
          </Link>
        </div>
      </div>
    </main>
    </>
  )
}
