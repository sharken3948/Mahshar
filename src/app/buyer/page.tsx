'use client'
import { useAccount, useSignTypedData } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { ApiListing } from '@/types'
import { NavBar } from '@/components/NavBar'
import { buildViewCodeSnippet, renderHighlightedSnippet } from '@/lib/snippets'

interface PaymentRequirements {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: {
    name: string
    version: string
    verifyingContract: string
  }
}

interface PaymentRequired {
  x402Version: number
  resource: { url: string; description: string; mimeType: string }
  accepts: PaymentRequirements[]
}

type ApiCardFields = Pick<ApiListing, 'id' | 'name' | 'description' | 'category' | 'price_per_call' | 'payment_model' | 'score' | 'uptime' | 'example_request' | 'method'>


const ARC_CHAIN_ID = 5042002

const CATEGORIES = ['All', 'AI', 'Data', 'Finance', 'Weather', 'Geo', 'Social', 'Media', 'Utility', 'Other']

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

function generateNonce(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`
}

function needsRequestBody(exampleRequest: string | null | undefined): boolean {
  if (!exampleRequest) return false
  try {
    const parsed = JSON.parse(exampleRequest)
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0
  } catch {
    return false
  }
}

function ApiRow({ api, avgLatency, calling, paymentStep, onUse, purchased, onView }: {
  api: ApiCardFields
  avgLatency: number | null
  calling: string | null
  paymentStep: 'probing' | 'signing' | 'submitting'
  onUse: (id: string) => void
  purchased: boolean
  onView: (id: string, name: string, method: string, exampleRequest: string | null) => void
}) {
  return (
    <div className="bg-white border border-[#E2E4E9] rounded-xl px-4 py-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-bold text-[#0D0D0D] text-sm">{api.name}</span>
          <span className="text-xs bg-[#EBF3FC] text-[#2775CA] border border-[#BFDBFE] px-2 py-0.5 rounded-full">{api.category}</span>
        </div>
        <p className="text-sm text-[#6B7280] line-clamp-3" title={api.description}>{api.description}</p>
      </div>
      <div className="hidden sm:flex items-center gap-6 flex-shrink-0">
        <div className="text-center">
          <div className="text-xs text-[#6B7280] mb-0.5">Price</div>
          <div className="text-sm font-bold text-[#0D0D0D]">${api.price_per_call}</div>
          <div className="text-xs text-[#6B7280]">USDC/call</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-[#6B7280] mb-0.5">Avg Latency</div>
          <div className="text-sm font-bold text-[#0D0D0D]">{avgLatency != null ? `${avgLatency}ms` : '—'}</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-[#6B7280] mb-0.5">Score</div>
          <div className="text-sm font-bold text-[#2775CA]">{api.score != null ? `${api.score}/10` : '—'}</div>
        </div>
      </div>
      {purchased ? (
        <button
          onClick={() => onView(api.id, api.name, api.method ?? 'GET', api.example_request ?? null)}
          className="flex-shrink-0 bg-[#2775CA] hover:bg-[#1E63B5] text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          View API
        </button>
      ) : (
        <button
          onClick={() => onUse(api.id)}
          disabled={calling === api.id}
          className="flex-shrink-0 bg-[#00B050] hover:bg-[#008F42] text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {calling === api.id
            ? paymentStep === 'signing' ? 'Sign in wallet...'
            : paymentStep === 'submitting' ? 'Submitting...'
            : 'Getting price...'
            : 'Use API'}
        </button>
      )}
    </div>
  )
}

export default function BuyerPage() {
  const { address, isConnected } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ApiCardFields[]>([])
  const [searching, setSearching] = useState(false)
  const [calling, setCalling] = useState<string | null>(null)
  const [paymentStep, setPaymentStep] = useState<'probing' | 'signing' | 'submitting'>('probing')
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [allApis, setAllApis] = useState<ApiCardFields[]>([])
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [latencyMap, setLatencyMap] = useState<Record<string, number>>({})
  const [requestModal, setRequestModal] = useState<{ apiId: string } | null>(null)
  const [requestBodyText, setRequestBodyText] = useState('')
  const [requestBodyError, setRequestBodyError] = useState<string | null>(null)
  const [purchasedApiIds, setPurchasedApiIds] = useState<Set<string>>(new Set())
  const [viewApiModal, setViewApiModal] = useState<{ apiId: string; apiName: string; method: string; exampleRequest: string | null } | null>(null)
  const [viewApiResponse, setViewApiResponse] = useState<unknown>(null)
  const [viewApiLoading, setViewApiLoading] = useState(false)
  const [viewApiCopied, setViewApiCopied] = useState(false)

  useEffect(() => {
    fetch('/api/apis')
      .then(r => r.json())
      .then((data: { apis?: ApiCardFields[] }) => setAllApis(data.apis ?? []))
    fetch('/api/apis/latency')
      .then(r => r.json())
      .then((data: { latencies?: Record<string, number> }) => setLatencyMap(data.latencies ?? {}))
  }, [])

  useEffect(() => {
    if (!address) return
    fetch(`/api/calls?buyer_wallet=${address.toLowerCase()}`)
      .then(r => r.json())
      .then((data: { calls?: Array<{ api_id: string }> }) => {
        setPurchasedApiIds(new Set(data.calls?.map(c => c.api_id) ?? []))
      })
      .catch(() => {})
  }, [address])

  const filteredApis = selectedCategory === 'All'
    ? allApis
    : allApis.filter(a => a.category === selectedCategory)

  async function handleSearch() {
    if (!query.trim()) return
    setSearching(true)
    try {
      const res = await fetch('/api/ai/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      setResults(data.apis ?? [])
    } finally {
      setSearching(false)
    }
  }

  async function executePaymentFlow(
    apiId: string,
    proxyBody: { api_id: string; buyer_wallet: string; method?: string; body?: unknown },
  ) {
    setCalling(apiId)
    setPaymentError(null)

    const api = [...allApis, ...results].find(a => a.id === apiId)
    const apiName = api?.name ?? apiId
    const apiMethod = api?.method ?? 'GET'

    try {
      setPaymentStep('probing')
      const probeRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proxyBody),
      })

      if (probeRes.status !== 402) {
        const data = await probeRes.json() as { response?: Record<string, unknown>; latency_ms?: number }
        setViewApiModal({ apiId, apiName, method: apiMethod, exampleRequest: api?.example_request ?? null })
        setViewApiResponse(data.response ?? (data as Record<string, unknown>))
        setViewApiLoading(false)
        return
      }

      const paymentRequiredHeader = probeRes.headers.get('PAYMENT-REQUIRED')
      if (!paymentRequiredHeader) {
        setPaymentError('Missing PAYMENT-REQUIRED header in 402 response')
        return
      }

      let paymentRequired: PaymentRequired
      try {
        paymentRequired = JSON.parse(atob(paymentRequiredHeader)) as PaymentRequired
      } catch {
        setPaymentError('Invalid payment response from server')
        return
      }

      const requirements = paymentRequired.accepts?.find(
        r => r.extra?.name === 'GatewayWalletBatched' && r.extra?.version === '1'
      )

      if (!requirements) {
        setPaymentError('No supported payment method in 402 response')
        return
      }

      setPaymentStep('signing')
      const now = Math.floor(Date.now() / 1000)
      const nonce = generateNonce()

      const signature = await signTypedDataAsync({
        domain: {
          name: 'GatewayWalletBatched',
          version: '1',
          chainId: ARC_CHAIN_ID,
          verifyingContract: requirements.extra.verifyingContract as `0x${string}`,
        },
        types: TRANSFER_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: address as `0x${string}`,
          to: requirements.payTo as `0x${string}`,
          value: BigInt(requirements.amount),
          validAfter: BigInt(now - 600),
          validBefore: BigInt(now + 604900),
          nonce,
        },
      })

      const paymentPayload = {
        x402Version: paymentRequired.x402Version ?? 2,
        payload: {
          authorization: {
            from: address,
            to: requirements.payTo,
            value: requirements.amount,
            validAfter: String(now - 600),
            validBefore: String(now + 604900),
            nonce,
          },
          signature,
        },
        resource: paymentRequired.resource,
        accepted: requirements,
      }

      setPaymentStep('submitting')
      const paidRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Payment-Signature': btoa(JSON.stringify(paymentPayload)),
        },
        body: JSON.stringify(proxyBody),
      })

      const paidData = await paidRes.json() as { response?: Record<string, unknown>; latency_ms?: number; error?: string }

      if (!paidRes.ok) {
        setPaymentError(paidData.error ?? `Request failed: ${paidRes.status}`)
        return
      }

      setPurchasedApiIds(prev => new Set([...prev, apiId]))
      setViewApiModal({ apiId, apiName, method: apiMethod, exampleRequest: api?.example_request ?? null })
      setViewApiResponse(paidData.response ?? (paidData as Record<string, unknown>))
      setViewApiLoading(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setPaymentError(message)
    } finally {
      setCalling(null)
    }
  }

  function handleUseApi(apiId: string) {
    if (!address) return
    const api = [...allApis, ...results].find(a => a.id === apiId)

    if (api && needsRequestBody(api.example_request)) {
      try {
        const formatted = JSON.stringify(JSON.parse(api.example_request!), null, 2)
        setRequestBodyText(formatted)
      } catch {
        setRequestBodyText(api.example_request ?? '')
      }
      setRequestBodyError(null)
      setRequestModal({ apiId })
      return
    }

    void executePaymentFlow(apiId, { api_id: apiId, buyer_wallet: address })
  }

  async function handleModalSubmit() {
    if (!requestModal || !address) return
    let parsed: unknown
    try {
      parsed = JSON.parse(requestBodyText)
    } catch {
      setRequestBodyError('Invalid JSON, fix before submitting')
      return
    }
    const { apiId } = requestModal
    setRequestModal(null)
    await executePaymentFlow(apiId, {
      api_id: apiId,
      buyer_wallet: address,
      method: 'POST',
      body: parsed,
    })
  }

  function handleNewQuery() {
    if (!viewApiModal || !address) return
    const { apiId, exampleRequest } = viewApiModal
    setViewApiModal(null)
    if (needsRequestBody(exampleRequest)) {
      try {
        setRequestBodyText(JSON.stringify(JSON.parse(exampleRequest!), null, 2))
      } catch {
        setRequestBodyText(exampleRequest ?? '')
      }
      setRequestBodyError(null)
      setRequestModal({ apiId })
    } else {
      void executePaymentFlow(apiId, { api_id: apiId, buyer_wallet: address })
    }
  }

  async function handleViewApi(apiId: string, apiName: string, method: string, exampleRequest: string | null) {
    setViewApiModal({ apiId, apiName, method, exampleRequest })
    setViewApiResponse(null)
    setViewApiLoading(true)
    try {
      const res = await fetch(`/api/calls/last-response?api_id=${apiId}&buyer_wallet=${address ?? ''}`)
      if (res.ok) {
        const data = await res.json() as { response_body: unknown }
        setViewApiResponse(data.response_body)
      }
    } finally {
      setViewApiLoading(false)
    }
  }

  if (!isConnected) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center gap-6 px-6 pt-36">
          <h1 className="text-2xl font-bold text-[#0D0D0D]">Connect Your Wallet</h1>
          <p className="text-[#6B7280] text-center max-w-sm">Connect your wallet to find and use APIs on Mahshar.</p>
          <ConnectButton />
        </main>
      </>
    )
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mahshar.xyz'
  const viewCodeSnippet = viewApiModal ? buildViewCodeSnippet(viewApiModal.apiId, appUrl, viewApiModal.method) : ''

  return (
    <>
    <NavBar />
    <main className="min-h-screen bg-[#F5F5F0] px-6 pt-40 pb-16">
      <div className="mx-auto max-w-4xl">

        {/* Page header */}
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#00B050] hover:bg-[#008F42] text-white transition-colors">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </Link>
        </div>
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[#0D0D0D]">Find an API</h1>
        </div>

        {/* AI Search section */}
        <section className="mb-8">
          <h2 className="font-bold text-xl text-[#0D0D0D] mb-4">AI Search</h2>
          <div className="flex gap-3 mb-4">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Describe what you need, e.g. wallet risk scoring, weather data..."
              className="flex-1 bg-[#FAFAF8] border border-[#E2E4E9] rounded-xl px-4 py-3 text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA] text-sm"
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="bg-[#2775CA] hover:bg-[#1E63B5] text-white px-6 py-3 rounded-xl text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>
          {results.length > 0 && (
            <div className="flex flex-col gap-2">
              {results.map(api => (
                <ApiRow key={api.id} api={api} avgLatency={latencyMap[api.id] ?? null} calling={calling} paymentStep={paymentStep} onUse={handleUseApi} purchased={purchasedApiIds.has(api.id)} onView={handleViewApi} />
              ))}
            </div>
          )}
        </section>

        <div className="border-t border-[#E2E4E9] my-8" />

        {/* Marketplace Manual Search section */}
        <section className="mb-8">
          <h2 className="font-bold text-xl text-[#0D0D0D] mb-4">Marketplace Manual Search</h2>
          <div className="flex flex-wrap gap-2 mb-4">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={selectedCategory === cat
                  ? 'bg-[#2775CA] text-white rounded-lg px-3 py-1.5 text-sm font-medium transition-colors'
                  : 'bg-white border border-[#E2E4E9] text-[#6B7280] rounded-lg px-3 py-1.5 text-sm font-medium hover:border-[#2775CA] transition-colors'}
              >
                {cat}
              </button>
            ))}
          </div>
          {filteredApis.length === 0 ? (
            <p className="text-sm text-[#6B7280]">No APIs found.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredApis.map(api => (
                <ApiRow key={api.id} api={api} avgLatency={latencyMap[api.id] ?? null} calling={calling} paymentStep={paymentStep} onUse={handleUseApi} purchased={purchasedApiIds.has(api.id)} onView={handleViewApi} />
              ))}
            </div>
          )}
        </section>

        {paymentError && (
          <div className="mb-6 bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-6 py-4 text-sm text-[#DC2626]">
            {paymentError}
          </div>
        )}

        {/* Request body modal */}
        {requestModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50" onClick={() => setRequestModal(null)} />
            <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-[#E2E4E9] flex items-center justify-between">
                <div>
                  <span className="font-bold text-[#0D0D0D]">Request Body</span>
                  <span className="ml-3 text-xs bg-[#EBF3FC] text-[#2775CA] border border-[#BFDBFE] px-2 py-0.5 rounded-full font-mono">POST</span>
                </div>
                <button onClick={() => setRequestModal(null)} className="text-[#6B7280] hover:text-[#0D0D0D] transition-colors text-xl leading-none">&times;</button>
              </div>
              <div className="p-6">
                <p className="text-sm text-[#6B7280] mb-3">Edit the JSON body that will be forwarded to this API. The template below is pre-filled from the listing&apos;s example request.</p>
                <textarea
                  value={requestBodyText}
                  onChange={e => { setRequestBodyText(e.target.value); setRequestBodyError(null) }}
                  rows={10}
                  maxLength={10000}
                  className="w-full font-mono text-xs bg-[#0D0D0D] text-[#E2E4E9] rounded-xl p-4 focus:outline-none resize-none"
                  spellCheck={false}
                />
                <div className="mt-1 flex items-center justify-between">
                  <div>
                    {requestBodyError && (
                      <p className="text-xs text-[#DC2626]">{requestBodyError}</p>
                    )}
                  </div>
                  <span className={`text-xs ${requestBodyText.length >= 10000 ? 'text-[#DC2626]' : 'text-[#6B7280]'}`}>
                    {requestBodyText.length.toLocaleString()}/10,000 characters
                  </span>
                </div>
                <button
                  onClick={() => void handleModalSubmit()}
                  className="mt-4 w-full bg-[#00B050] hover:bg-[#008F42] text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
                >
                  Send Request
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </main>

    {/* View API modal */}
    {viewApiModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50" onClick={() => setViewApiModal(null)} />
        <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-[#E2E4E9] flex items-center justify-between">
            <span className="font-bold text-[#0D0D0D]">{viewApiModal.apiName}</span>
            <button onClick={() => setViewApiModal(null)} className="text-[#6B7280] hover:text-[#0D0D0D] transition-colors text-xl leading-none">&times;</button>
          </div>
          <div className="p-6 space-y-5">
            <div>
              <h3 className="text-sm font-medium text-[#0D0D0D] mb-2">Last Response</h3>
              {viewApiLoading ? (
                <p className="text-sm text-[#6B7280]">Loading...</p>
              ) : viewApiResponse !== null ? (
                <pre className="bg-[#F5F5F0] rounded-lg p-4 text-sm text-[#0D0D0D] overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {JSON.stringify(viewApiResponse, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-[#6B7280]">No response data available yet.</p>
              )}
            </div>
            <div>
              <h3 className="text-sm font-medium text-[#0D0D0D] mb-2">Integration Code</h3>
              <pre className="bg-[#0D0D0D] text-[#E2E4E9] text-xs rounded-xl p-4 overflow-x-auto whitespace-pre leading-relaxed">
                {renderHighlightedSnippet(viewCodeSnippet)}
              </pre>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(viewCodeSnippet)
                    setViewApiCopied(true)
                    setTimeout(() => setViewApiCopied(false), 2000)
                  }}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${viewApiCopied ? 'bg-[#F0FDF4] border-[#86EFAC] text-[#16A34A]' : 'bg-white border-[#E2E4E9] text-[#6B7280] hover:border-[#2775CA] hover:text-[#2775CA]'}`}
                >
                  {viewApiCopied ? 'Copied!' : 'Copy to clipboard'}
                </button>
                <button
                  onClick={handleNewQuery}
                  className="flex-1 py-2 rounded-lg text-sm font-medium border border-[#E2E4E9] text-[#6B7280] hover:border-[#0D0D0D] hover:text-[#0D0D0D] transition-colors"
                >
                  New Query
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
