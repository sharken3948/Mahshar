'use client'
import Link from 'next/link'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useEffect, useState } from 'react'

export function NavBar() {
  const { address, isConnected } = useAccount()
  const [balance, setBalance] = useState<string | null>(null)

  useEffect(() => {
    if (!address) { setBalance(null); return }

    const fetchBalance = () =>
      fetch(`/api/gateway/balance?wallet=${address}`)
        .then(r => r.ok ? r.json() : null)
        .then((data: { gatewayAvailable?: string } | null) => {
          setBalance(data?.gatewayAvailable ?? null)
        })
        .catch(() => {})

    fetchBalance()
    const id = setInterval(fetchBalance, 30_000)
    return () => clearInterval(id)
  }, [address])

  return (
    <nav className="fixed top-0 z-50 w-full border-b border-[#F5F5F0] bg-[#F5F5F0]">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link href="/"><img src="/logo.png" alt="mahshar" className="h-28 w-auto" /></Link>
        <div className="flex items-center gap-3">
          {isConnected && (
            <span className="flex items-center gap-1.5 bg-white border border-[#2775CA] rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap">
              <span className="text-[#6B7280]">Mahshar Balance:</span>
              <span className="text-[#2775CA] font-bold text-sm">${balance ?? '—'} USDC</span>
              <span className="text-[#6B7280] font-normal text-xs">(Testnet)</span>
            </span>
          )}
          {isConnected && (
            <Link
              href="/dashboard"
              className="bg-[#00B050] hover:bg-[#008F42] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Dashboard
            </Link>
          )}
          <ConnectButton showBalance={false} />
        </div>
      </div>
    </nav>
  )
}
