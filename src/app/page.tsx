'use client'
import Link from 'next/link'
import { NavBar } from '@/components/NavBar'

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#F5F5F0]">

      <NavBar />

      {/* Hero */}
      <section className="flex flex-col items-center justify-center text-center px-6 pt-36 pb-6">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-5xl font-extrabold text-[#0D0D0D] tracking-tight max-w-2xl leading-tight mx-auto">
            The API economy,<br />powered by USDC.
          </h1>
          <p className="mt-4 text-lg text-[#6B7280] max-w-lg mx-auto">
            Buy and sell API access with instant USDC micropayments. AI-matched, zero integration, no subscriptions.
          </p>
        </div>
      </section>

      {/* Two CTA cards */}
      <section className="mx-auto max-w-3xl px-6 pb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="bg-white border border-[#E2E4E9] rounded-2xl p-6 flex flex-col items-center text-center hover:border-[#00B050]/40 hover:shadow-md transition-all">
            <div className="w-14 h-14 rounded-full bg-[#F0FDF4] flex items-center justify-center mb-3">
              <svg width="26" height="26" fill="none" stroke="#00B050" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-[#0D0D0D] mb-3">List Your API</h2>
            <p className="text-[#6B7280] text-sm mb-4 leading-relaxed">Connect your wallet and fill a 5-minute form. Start earning USDC instantly. Your endpoint is never exposed.</p>
            <Link href="/seller" className="w-full block text-center bg-[#00B050] hover:bg-[#008F42] text-white py-3 rounded-xl font-semibold text-base transition-colors">
              SELL
            </Link>
          </div>

          <div className="bg-white border border-[#E2E4E9] rounded-2xl p-6 flex flex-col items-center text-center hover:border-[#2775CA]/40 hover:shadow-md transition-all">
            <div className="w-14 h-14 rounded-full bg-[#EBF3FC] flex items-center justify-center mb-3">
              <svg width="26" height="26" fill="none" stroke="#2775CA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-[#0D0D0D] mb-3">Buy in Marketplace</h2>
            <p className="text-[#6B7280] text-sm mb-4 leading-relaxed">Browse all listed APIs or let AI find the right one for you. Pay per call in USDC, no subscriptions, no API keys.</p>
            <Link href="/buyer" className="w-full block text-center bg-[#2775CA] hover:bg-[#1E63B5] text-white py-3 rounded-xl font-semibold text-base transition-colors">
              BUY
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-[#E2E4E9] py-10 px-6 bg-white">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-2xl font-bold text-[#0D0D0D] mb-6">How it works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-10">
            <div className="flex flex-col items-center gap-3">
              <span className="text-3xl font-black text-[#2775CA]/30">01</span>
              <h3 className="font-bold text-[#0D0D0D]">Search</h3>
              <p className="text-[#6B7280] text-sm">Describe your need. AI matches you with the best available API instantly.</p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <span className="text-3xl font-black text-[#2775CA]/30">02</span>
              <h3 className="font-bold text-[#0D0D0D]">Pay</h3>
              <p className="text-[#6B7280] text-sm">Send a USDC micropayment via x402 or use prepaid credits. No setup required.</p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <span className="text-3xl font-black text-[#2775CA]/30">03</span>
              <h3 className="font-bold text-[#0D0D0D]">Receive</h3>
              <p className="text-[#6B7280] text-sm">Our proxy forwards your request and returns the response. Seller key never exposed.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#E2E4E9] py-3 px-6 text-center text-sm text-[#6B7280] bg-[#F5F5F0]">
        © {new Date().getFullYear()} Mahshar. The API economy, powered by USDC.
      </footer>

      <footer className="border-t border-[#E2E4E9] py-3 text-center">
        <p className="text-xs text-[#6B7280]">
          For AI Agents: <a href="/api/agent/discover" className="text-[#2775CA] hover:underline">/api/agent/discover</a>
        </p>
      </footer>

    </main>
  )
}
