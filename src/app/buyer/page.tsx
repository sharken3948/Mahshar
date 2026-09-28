'use client'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import { useAccount, useReadContract, useSignTypedData } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { formatUnits } from 'viem'
import { BackButton } from '@/components/BackButton'
import type { ApiListing, AuthType } from '@/types'
import { NavBar } from '@/components/NavBar'
import { buildViewCodeSnippet, renderHighlightedSnippet } from '@/lib/snippets'
import { paymentErrorMessage } from '@/lib/payments/errors'
import { readPurchasedResponse, rememberPurchaseAccess } from '@/lib/marketplace/purchase-access-client'
import { coalescedJsonGet } from '@/lib/client-read'
import { buildBuyerProxyEnvelope, exampleRequestHasForwardableBody, type BuyerProxyEnvelope } from '@/lib/marketplace/buyer-proxy-request'
import { MahsharFlowMotif } from '@/components/MahsharFlowMotif'
import { ARC } from '@/lib/arc'
import { buyerPaymentQuote, gatewayCanPay, insufficientGatewayMessage, type BuyerPaymentQuote } from '@/lib/payments/buyer-balance'
import styles from './buyer.module.css'

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

interface PaymentConfirmation {
  apiId: string
  apiName: string
  apiMethod: string
  exampleRequest: string | null
  proxyBody: BuyerProxyEnvelope
  paymentRequired: PaymentRequired
  requirements: PaymentRequirements
  quote: BuyerPaymentQuote
  wallet: string
  gatewayAvailable: string
}

type ApiCardFields = Pick<ApiListing, 'id' | 'name' | 'description' | 'category' | 'price_per_call' | 'payment_model' | 'score' | 'uptime' | 'example_request' | 'method' | 'auth_type' | 'created_at'>


const CHAIN_LABELS: Record<number, string> = {
  5042: 'Arc Mainnet',
}

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

const ERC20_BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

function generateNonce(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`
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
    <article className={styles.apiCard}>
      <div className={styles.apiPrimary}>
        <div className={styles.apiTop}>
          <span className={styles.apiGlyph} aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></svg></span>
          <div className="min-w-0"><h3 className={styles.apiName}>{api.name}</h3><div className={styles.apiSubline}><span className={styles.categoryBadge}>{api.category}</span><span>{api.auth_type === 'public' ? 'Public access' : api.auth_type}</span></div></div>
        </div>
        <p className={styles.apiDescription} title={api.description}>{api.description}</p>
        <div className={styles.apiMetrics}>
          <span className={styles.methodBadge}>{api.method ?? 'GET'}</span><span className={styles.contextBadge}>x402</span><span className={styles.contextBadge}>USDC</span><span className={styles.contextBadge}>Arc</span>
          <span className={styles.metric}><span className={styles.metricLabel}>Latency</span><span className={`${styles.metricValue} ${avgLatency == null ? styles.metricUnknown : ''}`}>{avgLatency != null ? `${avgLatency}ms` : 'Unknown'}</span></span>
          <span className={styles.metric}><span className={styles.metricLabel}>AI Score</span><span className={`${styles.metricValue} ${api.score == null ? styles.metricUnknown : ''}`}>{api.score != null ? `${api.score}/10` : '—'}</span></span>
        </div>
      </div>
      <div className={styles.apiSide}><p className={styles.price}>${api.price_per_call}<small>USDC / call</small></p>{purchased ? (
        <button onClick={() => onView(api.id, api.name, api.method ?? 'GET', api.example_request ?? null)} className={styles.apiAction}>View API</button>
      ) : (
        <button onClick={() => onUse(api.id)} disabled={calling === api.id} className={`${styles.apiAction} ${styles.apiActionUse}`}>
          {calling === api.id
            ? paymentStep === 'signing' ? 'Confirm in wallet...'
            : paymentStep === 'submitting' ? 'Submitting...'
            : 'Getting price...'
            : 'Use API'}
        </button>
      )}
      </div>
    </article>
  )
}

export default function BuyerPage() {
  const { address, isConnected, chainId } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  const { request: protectedFetch } = useMarketplaceSession()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ApiCardFields[]>([])
  const [searching, setSearching] = useState(false)
  const [searchHasRun, setSearchHasRun] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [listingsLoading, setListingsLoading] = useState(true)
  const [listingsError, setListingsError] = useState<string | null>(null)
  const [calling, setCalling] = useState<string | null>(null)
  const [paymentStep, setPaymentStep] = useState<'probing' | 'signing' | 'submitting'>('probing')
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [gatewayFundingNeeded, setGatewayFundingNeeded] = useState(false)
  const [gatewayAvailable, setGatewayAvailable] = useState<string | null>(null)
  const [gatewayBalanceUnavailable, setGatewayBalanceUnavailable] = useState(false)
  const [paymentConfirmation, setPaymentConfirmation] = useState<PaymentConfirmation | null>(null)
  const [allApis, setAllApis] = useState<ApiCardFields[]>([])
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [latencyMap, setLatencyMap] = useState<Record<string, number>>({})
  const [requestModal, setRequestModal] = useState<{ apiId: string; method: string } | null>(null)
  const [requestBodyText, setRequestBodyText] = useState('')
  const [requestBodyError, setRequestBodyError] = useState<string | null>(null)
  const [purchasedApiIds, setPurchasedApiIds] = useState<Set<string>>(new Set())
  const [viewApiModal, setViewApiModal] = useState<{ apiId: string; apiName: string; method: string; exampleRequest: string | null } | null>(null)
  const [viewApiResponse, setViewApiResponse] = useState<unknown>(null)
  const [viewApiLoading, setViewApiLoading] = useState(false)
  const [viewApiCopied, setViewApiCopied] = useState(false)
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')
  const [latencyFilter, setLatencyFilter] = useState('all')
  const [scoreFilter, setScoreFilter] = useState('all')
  const [authFilters, setAuthFilters] = useState<Set<AuthType>>(new Set())
  const [sortBy, setSortBy] = useState<'newest' | 'price-low' | 'price-high' | 'score' | 'latency'>('newest')

  const { data: walletUsdcRaw } = useReadContract({
    address: ARC.usdcAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: ARC.chainId,
    query: { enabled: !!address, staleTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false },
  })

  const refreshGatewayBalance = useCallback(async (wallet: string) => {
    try {
      const response = await protectedFetch(`/api/gateway/balance?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => null) as { gatewayAvailable?: unknown } | null
      if (!response.ok || typeof data?.gatewayAvailable !== 'string') throw new Error('Mahshar Balance unavailable')
      if (address?.toLowerCase() === wallet) {
        setGatewayAvailable(data.gatewayAvailable)
        setGatewayBalanceUnavailable(false)
      }
      return data.gatewayAvailable
    } catch {
      if (address?.toLowerCase() === wallet) setGatewayBalanceUnavailable(true)
      return null
    }
  }, [address, protectedFetch])

  useEffect(() => {
    setListingsLoading(true)
    setListingsError(null)
    coalescedJsonGet<{ apis?: ApiCardFields[]; error?: string }>('/api/apis')
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error ?? 'Unable to load marketplace listings')
        setAllApis(data.apis ?? [])
      })
      .catch((err: unknown) => {
        setAllApis([])
        setListingsError(err instanceof Error ? err.message : 'Unable to load marketplace listings')
      })
      .finally(() => setListingsLoading(false))
    coalescedJsonGet<{ latencies?: Record<string, number> }>('/api/apis/latency')
      .then(({ data }) => setLatencyMap(data.latencies ?? {}))
      .catch(() => setLatencyMap({}))
  }, [])

  useEffect(() => {
    setPurchasedApiIds(new Set())
    setViewApiResponse(null)
    setViewApiModal(null)
    if (!address) return
    let cancelled = false
    protectedFetch(`/api/calls?buyer_wallet=${address.toLowerCase()}`)
      .then(async response => {
        const data = await response.json() as { calls?: Array<{ api_id: string }> }
        if (!response.ok) throw new Error('Purchase history unavailable')
        if (!cancelled) setPurchasedApiIds(new Set(data.calls?.map(call => call.api_id) ?? []))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address, protectedFetch])

  useEffect(() => {
    setGatewayAvailable(null)
    setGatewayBalanceUnavailable(false)
    setPaymentConfirmation(null)
    if (!address) return
    void refreshGatewayBalance(address.toLowerCase())
  }, [address, refreshGatewayBalance])

  const topCategories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of allApis) {
      if (!a.category) continue
      counts.set(a.category, (counts.get(a.category) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 9)
      .map(([name]) => name)
  }, [allApis])

  const categoryTabs = useMemo(() => {
    const tabs = ['All', ...topCategories]
    const distinct = new Set(allApis.map(a => a.category).filter(Boolean))
    if (distinct.size > topCategories.length) tabs.push('Other')
    return tabs
  }, [topCategories, allApis])

  const topSet = useMemo(() => new Set(topCategories), [topCategories])

  useEffect(() => {
    if (!categoryTabs.includes(selectedCategory)) setSelectedCategory('All')
  }, [categoryTabs, selectedCategory])

  const sourceApis = searchHasRun
    ? results.map(result => allApis.find(api => api.id === result.id) ?? result)
    : allApis
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const api of allApis) counts.set(api.category, (counts.get(api.category) ?? 0) + 1)
    return counts
  }, [allApis])

  const filteredApis = useMemo(() => {
    const min = priceMin ? Number(priceMin) : null
    const max = priceMax ? Number(priceMax) : null
    const filtered = sourceApis.filter(api => {
      const categoryMatches = selectedCategory === 'All'
        || (selectedCategory === 'Other' ? Boolean(api.category && !topSet.has(api.category)) : api.category === selectedCategory)
      if (!categoryMatches) return false
      if (min != null && Number.isFinite(min) && api.price_per_call < min) return false
      if (max != null && Number.isFinite(max) && api.price_per_call > max) return false
      const latency = latencyMap[api.id]
      if (latencyFilter === 'under-100' && !(latency != null && latency < 100)) return false
      if (latencyFilter === '100-500' && !(latency != null && latency >= 100 && latency <= 500)) return false
      if (latencyFilter === 'over-500' && !(latency != null && latency > 500)) return false
      if (scoreFilter === '8-plus' && !(api.score != null && api.score >= 8)) return false
      if (scoreFilter === '5-to-7' && !(api.score != null && api.score >= 5 && api.score < 8)) return false
      if (scoreFilter === 'under-5' && !(api.score != null && api.score < 5)) return false
      return authFilters.size === 0 || authFilters.has(api.auth_type)
    })
    const unknownLast = (a: number | null | undefined, b: number | null | undefined, direction: 1 | -1) => {
      if (a == null) return b == null ? 0 : 1
      if (b == null) return -1
      return (a - b) * direction
    }
    return [...filtered].sort((a, b) => {
      if (sortBy === 'price-low') return a.price_per_call - b.price_per_call
      if (sortBy === 'price-high') return b.price_per_call - a.price_per_call
      if (sortBy === 'score') return unknownLast(a.score, b.score, -1)
      if (sortBy === 'latency') return unknownLast(latencyMap[a.id], latencyMap[b.id], 1)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [authFilters, latencyFilter, latencyMap, priceMax, priceMin, scoreFilter, selectedCategory, sortBy, sourceApis, topSet])

  const filtersActive = selectedCategory !== 'All' || Boolean(priceMin || priceMax) || latencyFilter !== 'all' || scoreFilter !== 'all' || authFilters.size > 0

  function toggleAuthFilter(authType: AuthType) {
    setAuthFilters(previous => {
      const next = new Set(previous)
      if (next.has(authType)) next.delete(authType)
      else next.add(authType)
      return next
    })
  }

  function clearFilters() {
    setSelectedCategory('All')
    setPriceMin('')
    setPriceMax('')
    setLatencyFilter('all')
    setScoreFilter('all')
    setAuthFilters(new Set())
  }

  async function handleSearch() {
    if (!query.trim()) return
    setSearching(true)
    setSearchHasRun(true)
    setSearchError(null)
    try {
      const res = await fetch('/api/ai/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await res.json() as { apis?: ApiCardFields[]; error?: string }
      if (!res.ok) {
        setResults([])
        setSearchError(data.error ?? 'AI search is temporarily unavailable. Try again.')
        return
      }
      setResults(data.apis ?? [])
    } catch {
      setResults([])
      setSearchError('AI search is temporarily unavailable. Try again.')
    } finally {
      setSearching(false)
    }
  }

  async function preparePaymentFlow(
    apiId: string,
    proxyBody: BuyerProxyEnvelope,
  ) {
    setCalling(apiId)
    setPaymentError(null)
    setGatewayFundingNeeded(false)

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
        const data = await probeRes.json() as { response?: Record<string, unknown>; latency_ms?: number; error?: string; message?: string; attemptId?: string }
        if (!probeRes.ok) {
          setPaymentError(paymentErrorMessage(data.error, data.message, data.attemptId))
          return
        }
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
        r => parseInt(r.network.split(':')[1], 10) === chainId
      )

      if (!requirements) {
        const supported = (paymentRequired.accepts ?? [])
          .map(r => parseInt(r.network.split(':')[1], 10))
          .map(id => CHAIN_LABELS[id] ? `${CHAIN_LABELS[id]} (${id})` : String(id))
          .join(', ')
        setPaymentError(
          `Your wallet is on chain ${chainId ?? 'unknown'}, but this API accepts: ${supported}. Switch your wallet's network to continue.`
        )
        return
      }

      if (!address || !api) throw new Error('Connect your wallet and reload the listing before paying')
      const currentGatewayAvailable = await refreshGatewayBalance(address.toLowerCase())
      if (currentGatewayAvailable === null) {
        setPaymentError('Mahshar Balance could not be checked. No payment was signed; try again when the balance is available.')
        return
      }
      const quote = buyerPaymentQuote(api.price_per_call, requirements.amount)
      if (!gatewayCanPay(currentGatewayAvailable, requirements.amount)) {
        setGatewayFundingNeeded(true)
        setPaymentError(insufficientGatewayMessage(requirements.amount))
        return
      }
      setPaymentConfirmation({ apiId, apiName, apiMethod, exampleRequest: api.example_request ?? null,
        proxyBody, paymentRequired, requirements, quote, wallet: address.toLowerCase(),
        gatewayAvailable: currentGatewayAvailable })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setPaymentError(message)
    } finally {
      setCalling(null)
    }
  }

  async function submitConfirmedPayment() {
    const confirmation = paymentConfirmation
    if (!confirmation || !address) return
    setPaymentConfirmation(null)
    setCalling(confirmation.apiId)
    setPaymentError(null)
    setGatewayFundingNeeded(false)
    const { apiId, apiName, apiMethod, exampleRequest, proxyBody, paymentRequired, requirements, wallet } = confirmation
    try {
      if (address.toLowerCase() !== wallet) throw new Error('Wallet changed. Review the payment again.')
      const selectedChainId = parseInt(requirements.network.split(':')[1], 10)
      setPaymentStep('signing')
      const now = Math.floor(Date.now() / 1000)
      const nonce = generateNonce()

      const signature = await signTypedDataAsync({
        domain: {
          name: 'GatewayWalletBatched',
          version: '1',
          chainId: selectedChainId,
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

      const paidData = await paidRes.json() as { response?: Record<string, unknown>; latency_ms?: number; error?: string; message?: string; attemptId?: string; purchase_access_token?: string }

      if (address) rememberPurchaseAccess(address, apiId, paidData.purchase_access_token)

      if (!paidRes.ok) {
        if (paidData.error === 'verification_failed') {
          const currentGatewayAvailable = await refreshGatewayBalance(wallet)
          if (currentGatewayAvailable !== null && !gatewayCanPay(currentGatewayAvailable, requirements.amount)) {
            setGatewayFundingNeeded(true)
            setPaymentError(insufficientGatewayMessage(requirements.amount))
            return
          }
        }
        setPaymentError(paymentErrorMessage(paidData.error, paidData.message ?? `Request failed: ${paidRes.status}`, paidData.attemptId))
        return
      }

      setPurchasedApiIds(prev => new Set([...prev, apiId]))
      setViewApiModal({ apiId, apiName, method: apiMethod, exampleRequest })
      setViewApiResponse(paidData.response ?? (paidData as Record<string, unknown>))
      setViewApiLoading(false)
      void refreshGatewayBalance(wallet)
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
    const method = api?.method ?? 'GET'

    if (api && exampleRequestHasForwardableBody(method, api.example_request)) {
      try {
        const formatted = JSON.stringify(JSON.parse(api.example_request!), null, 2)
        setRequestBodyText(formatted)
      } catch {
        setRequestBodyText(api.example_request ?? '')
      }
      setRequestBodyError(null)
      setRequestModal({ apiId, method })
      return
    }

    void preparePaymentFlow(apiId, buildBuyerProxyEnvelope(apiId, address, method))
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
    const { apiId, method } = requestModal
    setRequestModal(null)
    await preparePaymentFlow(apiId, buildBuyerProxyEnvelope(apiId, address, method, parsed))
  }

  function handleNewQuery() {
    if (!viewApiModal || !address) return
    const { apiId, method, exampleRequest } = viewApiModal
    setViewApiModal(null)
    if (exampleRequestHasForwardableBody(method, exampleRequest)) {
      try {
        setRequestBodyText(JSON.stringify(JSON.parse(exampleRequest!), null, 2))
      } catch {
        setRequestBodyText(exampleRequest ?? '')
      }
      setRequestBodyError(null)
      setRequestModal({ apiId, method })
    } else {
      void preparePaymentFlow(apiId, buildBuyerProxyEnvelope(apiId, address, method))
    }
  }

  async function handleViewApi(apiId: string, apiName: string, method: string, exampleRequest: string | null) {
    setViewApiModal({ apiId, apiName, method, exampleRequest })
    setViewApiResponse(null)
    setViewApiLoading(true)
    try {
      if (!address) return
      const result = await readPurchasedResponse({ wallet: address, apiId, authorize: protectedFetch })
      if (result.ok) setViewApiResponse(result.data.response_body)
    } finally {
      setViewApiLoading(false)
    }
  }

  if (!isConnected) {
    return (
      <>
        <NavBar />
        <main className={styles.connectMain}>
          <MahsharFlowMotif variant="background" tone="purple" className={styles.connectBackgroundFlow} />
          <section className={styles.connectCard}>
            <MahsharFlowMotif variant="card" tone="blue" className={styles.connectCardFlow} />
            <span className={styles.walletChip} aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6" /><path d="M20 12h-5v5h5M17 14.5h.01" /></svg></span>
            <h1>Connect Your Wallet</h1><p>Connect your wallet to discover and use paid APIs on Mahshar.</p><div className={styles.connectCta}><ConnectButton /></div><span className={styles.connectHelper}>Pay securely with USDC via x402.</span>
          </section>
        </main>
      </>
    )
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mahshar.xyz'
  const viewCodeSnippet = viewApiModal ? buildViewCodeSnippet(viewApiModal.apiId, appUrl, viewApiModal.method) : ''
  const walletUsdcDisplay = walletUsdcRaw === undefined ? '—' : formatUnits(walletUsdcRaw, 6)

  return (
    <>
    <NavBar />
    <main className={styles.page}><div className={styles.main}>
      <MahsharFlowMotif variant="background" tone="blue" className={styles.backgroundFlow} />
      <header className={styles.hero}>
        <BackButton href="/" label="Back to Mahshar" />
        <p className={styles.eyebrow}>MARKETPLACE</p><h1>Find an API</h1><p>Power your agents and applications with real-world data, tools, and services.</p>
        <div className={styles.searchSurface}><div className={styles.searchRow}><svg className={styles.searchIcon} width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" d="m21 21-4.5-4.5m2-5.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg><input type="text" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Describe what you need, e.g. wallet risk scoring, weather data..." className={styles.searchInput} /><button onClick={handleSearch} disabled={searching} className={styles.searchButton}>{searching ? 'Searching...' : 'Search'}</button></div></div>
        {searching && <p className={styles.searchFeedback}>Matching your request against active marketplace APIs…</p>}
        {searchError && <p className={`${styles.searchFeedback} ${styles.searchError}`}>{searchError}</p>}
        <div className={styles.categoryBar}>{categoryTabs.map(cat => <button key={cat} onClick={() => setSelectedCategory(cat)} className={`${styles.categoryPill} ${selectedCategory === cat ? styles.categoryPillActive : ''}`}>{cat}</button>)}</div>
      </header>

      <section className={styles.paymentBalances} aria-label="Purchase balances">
        <div><span>Arc Wallet USDC</span><strong>{walletUsdcDisplay} USDC</strong><small>Available in your connected wallet</small></div>
        <div><span>Mahshar Balance</span><strong>{gatewayAvailable ?? '—'} USDC</strong><small>{gatewayBalanceUnavailable ? 'Balance unavailable' : 'Used for paid API calls'}</small></div>
        <p>Mahshar x402 purchases use your Circle Gateway balance, not wallet USDC. <Link href="/dashboard/wallet#deposit">Fund Mahshar Balance</Link></p>
      </section>

      <div className={styles.workspace}><section className={styles.resultsColumn}><div className={styles.resultsHeader}><div><h2>{searchHasRun ? 'AI search results' : 'Marketplace APIs'}</h2><p>{filteredApis.length} {filteredApis.length === 1 ? 'API found' : 'APIs found'}{searchHasRun ? ' for your search' : ''}</p></div><select value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)} className={styles.sortSelect} aria-label="Sort marketplace results"><option value="newest">Newest</option><option value="price-low">Price: Low to High</option><option value="price-high">Price: High to Low</option><option value="score">AI Score</option><option value="latency">Latency</option></select></div>
        {paymentError && <div className={`${styles.emptyState} ${styles.errorState}`}><h3>Request needs attention</h3><p>{paymentError}</p>{gatewayFundingNeeded && <Link className={styles.fundingLink} href="/dashboard/wallet#deposit">Fund Mahshar Balance</Link>}</div>}
        {listingsLoading ? <div className={styles.loadingState}><div className={styles.skeleton} /><div className={styles.skeleton} /><div className={styles.skeleton} /></div> : listingsError ? <div className={`${styles.emptyState} ${styles.errorState}`}><h3>Marketplace unavailable</h3><p>{listingsError}</p></div> : searchHasRun && !searching && !searchError && results.length === 0 ? <div className={styles.emptyState}><h3>No AI matches found</h3><p>Try describing the capability, data source, or task in a different way.</p></div> : filteredApis.length === 0 ? <div className={styles.emptyState}><h3>No APIs match these filters</h3><p>Clear a filter or choose another category to see active marketplace listings.</p></div> : <div className={styles.resultsList}>{filteredApis.map(api => <ApiRow key={api.id} api={api} avgLatency={latencyMap[api.id] ?? null} calling={calling} paymentStep={paymentStep} onUse={handleUseApi} purchased={purchasedApiIds.has(api.id)} onView={handleViewApi} />)}</div>}
      </section>
      <aside className={styles.filterRail}><header className={styles.filterHeader}><h2>Filters</h2>{filtersActive && <button onClick={clearFilters} className={styles.clearButton}>Clear all</button>}</header><div className={styles.filterBody}>
        <div className={styles.filterGroup}><h3>Category</h3><div className={styles.filterOptions}>{categoryTabs.map(category => <button key={category} onClick={() => setSelectedCategory(category)} className={`${styles.filterOption} ${selectedCategory === category ? styles.filterOptionActive : ''}`}><span>{category}</span><span className={styles.filterCount}>{category === 'All' ? allApis.length : category === 'Other' ? allApis.filter(api => api.category && !topSet.has(api.category)).length : categoryCounts.get(category) ?? 0}</span></button>)}</div></div>
        <div className={styles.filterGroup}><h3>Price range · USDC</h3><div className={styles.rangeFields}><input type="number" min="0" step="0.0001" value={priceMin} onChange={event => setPriceMin(event.target.value)} placeholder="Min" className={styles.rangeInput} /><input type="number" min="0" step="0.0001" value={priceMax} onChange={event => setPriceMax(event.target.value)} placeholder="Max" className={styles.rangeInput} /></div></div>
        <div className={styles.filterGroup}><h3>Average latency</h3><select value={latencyFilter} onChange={event => setLatencyFilter(event.target.value)} className={styles.filterSelect}><option value="all">Any latency</option><option value="under-100">Under 100ms</option><option value="100-500">100–500ms</option><option value="over-500">Over 500ms</option></select></div>
        <div className={styles.filterGroup}><h3>AI score</h3><select value={scoreFilter} onChange={event => setScoreFilter(event.target.value)} className={styles.filterSelect}><option value="all">Any score</option><option value="8-plus">8 and above</option><option value="5-to-7">5 to 7</option><option value="under-5">Under 5</option></select></div>
        <div className={styles.filterGroup}><h3>Auth type</h3><div className={styles.filterOptions}>{(['public', 'apikey', 'bearer', 'queryparam'] as AuthType[]).filter(type => allApis.some(api => api.auth_type === type)).map(type => <label key={type} className={styles.checkboxOption}><input type="checkbox" checked={authFilters.has(type)} onChange={() => toggleAuthFilter(type)} />{type === 'public' ? 'Public' : type}</label>)}</div></div>
      </div></aside></div>

        {/* Request body modal */}
        {requestModal && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalBackdrop} onClick={() => setRequestModal(null)} />
            <div className={styles.modal}>
              <div className={styles.modalHeader}>
                <div><span className={styles.modalTitle}>Request Body</span><span className={styles.methodBadge}>{requestModal.method}</span></div>
                <button onClick={() => setRequestModal(null)} className={styles.modalClose}>&times;</button>
              </div>
              <div className={styles.modalBody}>
                <p className={styles.modalLead}>Edit the JSON body that will be forwarded to this API. The template below is pre-filled from the listing&apos;s example request.</p>
                <textarea
                  value={requestBodyText}
                  onChange={e => { setRequestBodyText(e.target.value); setRequestBodyError(null) }}
                  rows={10}
                  maxLength={10000}
                  className={styles.codeArea}
                  spellCheck={false}
                />
                <div className={styles.modalMeta}>
                  <div>
                    {requestBodyError && (
                      <p className={styles.modalError}>{requestBodyError}</p>
                    )}
                  </div>
                  <span className={requestBodyText.length >= 10000 ? styles.modalError : undefined}>
                    {requestBodyText.length.toLocaleString()}/10,000 characters
                  </span>
                </div>
                <button
                  onClick={() => void handleModalSubmit()}
                  className={styles.modalSubmit}
                >
                  Send Request
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </main>

    {paymentConfirmation && (
      <div className={styles.modalOverlay}>
        <div className={styles.modalBackdrop} onClick={() => setPaymentConfirmation(null)} />
        <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="payment-confirmation-title">
          <div className={styles.modalHeader}>
            <span id="payment-confirmation-title" className={styles.modalTitle}>Confirm {paymentConfirmation.apiName} payment</span>
            <button onClick={() => setPaymentConfirmation(null)} className={styles.modalClose} aria-label="Close payment confirmation">&times;</button>
          </div>
          <div className={styles.modalBody}>
            <p className={styles.modalLead}>Review the complete charge before your wallet signs the x402 authorization.</p>
            <dl className={styles.paymentBreakdown}>
              <div><dt>Listed API price</dt><dd>{paymentConfirmation.quote.listed} USDC</dd></div>
              <div><dt>Buyer platform fee</dt><dd>{paymentConfirmation.quote.fee} USDC</dd></div>
              <div className={styles.paymentTotal}><dt>Total payment</dt><dd>{paymentConfirmation.quote.total} USDC</dd></div>
              <div><dt>Paid from</dt><dd>Mahshar Balance</dd></div>
              <div><dt>Available</dt><dd>{paymentConfirmation.gatewayAvailable} USDC</dd></div>
            </dl>
            <p className={styles.modalLead}>Wallet USDC is not charged directly. This signature authorizes the exact total above from Circle Gateway.</p>
            <button onClick={() => void submitConfirmedPayment()} className={styles.modalSubmit}>Confirm {paymentConfirmation.quote.total} USDC and sign</button>
          </div>
        </div>
      </div>
    )}

    {/* View API modal */}
    {viewApiModal && (
      <div className={styles.modalOverlay}>
        <div className={styles.modalBackdrop} onClick={() => setViewApiModal(null)} />
        <div className={styles.modal}>
          <div className={styles.modalHeader}>
            <span className={styles.modalTitle}>{viewApiModal.apiName}</span>
            <button onClick={() => setViewApiModal(null)} className={styles.modalClose}>&times;</button>
          </div>
          <div className={styles.modalBody}>
            <div className={styles.responseSection}>
              <h3>Last Response</h3>
              {viewApiLoading ? (
                <p className={styles.modalLead}>Loading...</p>
              ) : viewApiResponse !== null ? (
                <pre className={styles.responseCode}>
                  {JSON.stringify(viewApiResponse, null, 2)}
                </pre>
              ) : (
                <p className={styles.modalLead}>No response data available yet.</p>
              )}
            </div>
            <div className={styles.responseSection}>
              <h3>Integration Code</h3>
              <pre className={styles.snippetCode}>
                {renderHighlightedSnippet(viewCodeSnippet)}
              </pre>
              <div className={styles.modalActions}>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(viewCodeSnippet)
                    setViewApiCopied(true)
                    setTimeout(() => setViewApiCopied(false), 2000)
                  }}
                  className={`${styles.modalAction} ${viewApiCopied ? styles.modalActionCopied : ''}`}
                >
                  {viewApiCopied ? 'Copied!' : 'Copy to clipboard'}
                </button>
                <button
                  onClick={handleNewQuery}
                  className={styles.modalAction}
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
