'use client'
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import type { ApiListing, AuthType } from '@/types'
import { NavBar } from '@/components/NavBar'
import { buildViewCodeSnippet, renderHighlightedSnippet } from '@/lib/snippets'
import { useBridgeBalances, SOURCE_CHAINS } from '@/hooks/useBridgeBalances'
import { useBridge } from '@/hooks/useBridge'

interface ApiCall {
  id: string
  api_id: string
  api_listings: { name: string; method: string | null } | null
  created_at: string
  latency_ms: number
  success: boolean
  payment_type: string
}

interface GatewayStats {
  gatewayAvailable: string
  totalCalls: number
  totalSpent: number
  purchasesByApiId: Record<string, number>
}

interface EarningsByApi {
  api_id: string
  api_name: string
  total: number
  calls: number
}

interface SellerEarnings {
  total_earnings: number
  earnings_by_api: EarningsByApi[]
}

interface SellCallEntry {
  id: string
  buyer_wallet: string
  created_at: string
  latency_ms: number
  success: boolean
}

interface SellCallGroup {
  api_id: string
  api_name: string
  count: number
  avgLatency: number
  successRate: number
  lastCalled: string
  calls: SellCallEntry[]
}

const ARC_CHAIN_ID = 5042002
const ARC_USDC = '0x3600000000000000000000000000000000000000' as const
const ARC_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const

const GATEWAY_DEPOSIT_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const

const GATEWAY_WITHDRAW_ABI = [
  { name: 'initiateWithdrawal', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const

const CATEGORIES = ['AI', 'Data', 'Finance', 'Weather', 'Geo', 'Social', 'Media', 'Utility', 'Other']

const inputCls = 'w-full rounded-lg border border-[#E2E4E9] bg-[#FAFAF8] px-3 py-2.5 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:border-[#2775CA] focus:outline-none focus:ring-1 focus:ring-[#2775CA] transition-colors'

function formatUsdc(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(4)
}

function getBalanceColor(balance: number): { bg: string; text: string; label: string } {
  if (balance >= 10) return { bg: '#F0FDF4', text: '#16A34A', label: 'Healthy' }
  if (balance >= 1) return { bg: '#FFFBEB', text: '#D97706', label: 'Low' }
  if (balance >= 0.5) return { bg: '#FEF2F2', text: '#DC2626', label: 'Critical' }
  return { bg: '#FEF2F2', text: '#DC2626', label: 'Critical' }
}

export default function DashboardPage() {
  const { address, isConnected } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })

  const [myApis, setMyApis] = useState<ApiListing[]>([])
  const [calls, setCalls] = useState<ApiCall[]>([])
  const [sellerEarnings, setSellerEarnings] = useState<SellerEarnings | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailsApi, setDetailsApi] = useState<string | null>(null)
  const [gatewayStats, setGatewayStats] = useState<GatewayStats | null>(null)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositStep, setDepositStep] = useState<'idle' | 'approving' | 'depositing'>('idle')
  const [depositError, setDepositError] = useState<string | null>(null)
  const [selectedDepositChain, setSelectedDepositChain] = useState<string>('arc')

  const bridgeBalances = useBridgeBalances()
  const { bridge: doBridge, step: bridgeStep, stepLabel: bridgeStepLabel, isLoading: bridgeLoading, error: bridgeError, reset: bridgeReset } = useBridge()
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawStep, setWithdrawStep] = useState<'idle' | 'withdrawing'>('idle')
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [sellCallGroups, setSellCallGroups] = useState<SellCallGroup[]>([])
  const [detailsSellApi, setDetailsSellApi] = useState<string | null>(null)
  const [editingApi, setEditingApi] = useState<ApiListing | null>(null)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', category: '', description: '', endpoint_url: '', auth_type: 'public' as AuthType, price_per_call: '' })
  const [deletingApiId, setDeletingApiId] = useState<string | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [apiActionError, setApiActionError] = useState<string | null>(null)
  const [viewApiModal, setViewApiModal] = useState<{ apiId: string; apiName: string; method: string } | null>(null)
  const [viewApiResponse, setViewApiResponse] = useState<unknown>(null)
  const [viewApiLoading, setViewApiLoading] = useState(false)
  const [viewApiCopied, setViewApiCopied] = useState(false)

  const { data: walletUsdcRaw, refetch: refetchUsdcBalance } = useReadContract({
    address: ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address },
  })

  const callGroups = useMemo(() => {
    const map = new Map<string, ApiCall[]>()
    for (const call of calls) {
      if (!map.has(call.api_id)) map.set(call.api_id, [])
      map.get(call.api_id)!.push(call)
    }
    const groups = Array.from(map.entries()).map(([apiId, grp]) => ({
      apiId,
      name: grp[0].api_listings?.name ?? 'Unknown',
      method: grp[0].api_listings?.method ?? 'GET',
      count: grp.length,
      spent: gatewayStats?.purchasesByApiId?.[apiId] ?? 0,
      avgLatency: Math.round(grp.reduce((s, c) => s + c.latency_ms, 0) / grp.length),
      lastCalled: grp.reduce((latest, c) => c.created_at > latest ? c.created_at : latest, grp[0].created_at),
      successRate: Math.round((grp.filter(c => c.success).length / grp.length) * 100),
      calls: [...grp].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    }))
    return groups
  }, [calls, gatewayStats])

  const fetchGatewayStats = useCallback(async () => {
    if (!address) return
    const res = await fetch(`/api/gateway/balance?wallet=${address}`)
    if (res.ok) setGatewayStats(await res.json())
  }, [address])

  const fetchSellerEarnings = useCallback(async () => {
    if (!address) return
    const res = await fetch(`/api/seller/earnings?seller_wallet=${address}`)
    if (res.ok) setSellerEarnings(await res.json() as SellerEarnings)
  }, [address])

  const fetchSellerCalls = useCallback(async () => {
    if (!address) return
    const res = await fetch(`/api/seller/calls?seller_wallet=${address}`)
    if (res.ok) setSellCallGroups((await res.json() as { groups: SellCallGroup[] }).groups)
  }, [address])

  const fetchLiveData = useCallback(async () => {
    if (!address) return
    await Promise.all([
      fetchGatewayStats(),
      fetchSellerEarnings(),
      fetchSellerCalls(),
      fetch(`/api/calls?buyer_wallet=${address.toLowerCase()}`).then(r => r.json()).then((d: { calls?: ApiCall[] }) => setCalls(d.calls ?? [])),
    ])
  }, [address, fetchGatewayStats, fetchSellerEarnings, fetchSellerCalls])

  useEffect(() => {
    if (!address) return
    setLoading(true)
    Promise.all([
      fetch(`/api/apis?seller_wallet=${address}`).then(r => r.json()),
      fetch(`/api/calls?buyer_wallet=${address.toLowerCase()}`).then(r => r.json()),
    ]).then(([apisData, callsData]) => {
      setMyApis(apisData.apis ?? [])
      setCalls(callsData.calls ?? [])
    }).finally(() => setLoading(false))
    fetchGatewayStats()
    void fetchSellerEarnings()
    void fetchSellerCalls()
  }, [address, fetchGatewayStats, fetchSellerEarnings, fetchSellerCalls])

  useEffect(() => {
    if (!address) return
    const id = setInterval(() => { void fetchLiveData() }, 30_000)
    return () => clearInterval(id)
  }, [address, fetchLiveData])

  async function handleDeposit() {
    if (!address || !depositAmount || !publicClient) return
    setDepositStep('approving')
    setDepositError(null)
    try {
      const amount = Math.round(parseFloat(depositAmount) * 1_000_000)
      if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount')
      const amountBigInt = BigInt(amount)

      const approvalHash = await writeContractAsync({
        address: ARC_USDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ARC_GATEWAY_WALLET, amountBigInt],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash: approvalHash })

      setDepositStep('depositing')
      const depositHash = await writeContractAsync({
        address: ARC_GATEWAY_WALLET,
        abi: GATEWAY_DEPOSIT_ABI,
        functionName: 'deposit',
        args: [ARC_USDC, amountBigInt],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash: depositHash })

      setDepositAmount('')
      await fetchGatewayStats()
      refetchUsdcBalance()
    } catch (err: unknown) {
      setDepositError(err instanceof Error ? err.message : String(err))
    } finally {
      setDepositStep('idle')
    }
  }

  async function handleWithdraw() {
    if (!address || !withdrawAmount || !publicClient) return
    setWithdrawStep('withdrawing')
    setWithdrawError(null)
    try {
      const amount = Math.round(parseFloat(withdrawAmount) * 1_000_000)
      if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount')
      const hash = await writeContractAsync({
        address: ARC_GATEWAY_WALLET,
        abi: GATEWAY_WITHDRAW_ABI,
        functionName: 'initiateWithdrawal',
        args: [ARC_USDC, BigInt(amount)],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      setWithdrawAmount('')
      await fetchGatewayStats()
    } catch (err: unknown) {
      setWithdrawError(err instanceof Error ? err.message : String(err))
    } finally {
      setWithdrawStep('idle')
    }
  }

  async function handleEditSave() {
    if (!editingApi || !address) return
    setApiActionError(null)
    try {
      const res = await fetch(`/api/apis/${editingApi.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seller_wallet: address,
          name: editForm.name,
          category: editForm.category,
          description: editForm.description,
          endpoint_url: editForm.endpoint_url,
          auth_type: editForm.auth_type,
          price_per_call: parseFloat(editForm.price_per_call),
        }),
      })
      if (res.ok) {
        setMyApis(prev => prev.map(a => a.id === editingApi.id ? {
          ...a,
          name: editForm.name,
          category: editForm.category,
          description: editForm.description,
          endpoint_url: editForm.endpoint_url,
          auth_type: editForm.auth_type,
          price_per_call: parseFloat(editForm.price_per_call),
        } : a))
        setShowEditModal(false)
        setEditingApi(null)
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setApiActionError(body.error ?? 'Failed to save changes')
      }
    } catch (err: unknown) {
      setApiActionError(err instanceof Error ? err.message : 'Failed to save changes')
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingApiId || deleteConfirmText !== 'DELETE' || !address) return
    setApiActionError(null)
    try {
      const res = await fetch(`/api/apis/${deletingApiId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: address }),
      })
      if (res.ok) {
        setMyApis(prev => prev.filter(a => a.id !== deletingApiId))
        setDeletingApiId(null)
        setDeleteConfirmText('')
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setApiActionError(body.error ?? 'Failed to delete API')
      }
    } catch (err: unknown) {
      setApiActionError(err instanceof Error ? err.message : 'Failed to delete API')
    }
  }

  async function toggleActive(apiId: string, currentStatus: boolean) {
    if (!address) return
    try {
      const res = await fetch(`/api/apis/${apiId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: address, is_active: !currentStatus }),
      })
      if (res.ok) {
        setMyApis(prev => prev.map(a => a.id === apiId ? { ...a, is_active: !currentStatus } : a))
      }
    } catch {
      // toggle failure is silent — the UI keeps the old state
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mahshar.xyz'
  const viewCodeSnippet = viewApiModal ? buildViewCodeSnippet(viewApiModal.apiId, appUrl, viewApiModal.method) : ''

  async function handleViewApi(apiId: string, apiName: string, method: string) {
    setViewApiModal({ apiId, apiName, method })
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
          <ConnectButton />
        </main>
      </>
    )
  }

  const depositing = depositStep !== 'idle'
  const balanceNum = parseFloat(String(gatewayStats?.gatewayAvailable ?? '0')) || 0
  const balanceColor = getBalanceColor(balanceNum)

  return (
    <>
    <NavBar />
    <main className="min-h-screen bg-[#F5F5F0] px-6 pt-40 pb-16">
      <div className="mx-auto max-w-5xl">

        {/* Header */}
        <div className="mb-10">
          <Link href="/" className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#00B050] hover:bg-[#008F42] text-white transition-colors mb-6">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </Link>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-[#0D0D0D]">Dashboard</h1>
              <p className="text-[#6B7280] text-sm mt-1">{address?.slice(0, 6)}...{address?.slice(-4)}</p>
            </div>
            <button
              onClick={() => { void fetchLiveData() }}
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[#00B050] hover:bg-[#008F42] text-white transition-colors"
              title="Refresh"
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M1 4v6h6"/>
                <path d="M23 20v-6h-6"/>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          <div className="border border-[#E2E4E9] rounded-xl p-4 relative" style={{ backgroundColor: balanceColor.bg }}>
            <div className="flex items-start justify-between mb-1">
              <div className="text-xs text-[#6B7280]">Mahshar Balance</div>
              <div className="relative group">
                <div
                  className="w-4 h-4 rounded-full border flex items-center justify-center text-[10px] font-bold cursor-default leading-none"
                  style={{ color: balanceColor.text, borderColor: balanceColor.text }}
                >i</div>
                <div className="absolute right-0 top-5 w-56 bg-[#0D0D0D] text-white text-xs rounded-lg p-3 opacity-0 group-hover:opacity-100 pointer-events-none z-10 transition-opacity">
                  <div>🟢 Healthy: $10+ USDC</div>
                  <div>🟡 Low: $1–$10 USDC</div>
                  <div>🔴 Critical: below $1 USDC</div>
                  <div className="mt-1">Deposit more to keep using paid APIs.</div>
                </div>
              </div>
            </div>
            <div className="font-bold text-sm" style={{ color: balanceColor.text }}>${gatewayStats?.gatewayAvailable ?? '—'}</div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-[#6B7280]">USDC</div>
              <div className="text-xs font-medium" style={{ color: balanceColor.text }}>{balanceColor.label}</div>
            </div>
          </div>
          <div className="bg-white border border-[#E2E4E9] rounded-xl p-4">
            <div className="text-xs text-[#6B7280] mb-1">Wallet USDC</div>
            <div className="font-bold text-[#0D0D0D] text-sm">{walletUsdcRaw != null ? formatUsdc(walletUsdcRaw) : '—'}</div>
            <div className="text-xs text-[#6B7280]">USDC</div>
          </div>
          <div className="bg-white border border-[#E2E4E9] rounded-xl p-4">
            <div className="text-xs text-[#6B7280] mb-1">Total Calls</div>
            <div className="font-bold text-[#0D0D0D] text-sm">{gatewayStats?.totalCalls ?? '—'}</div>
            <div className="text-xs text-[#6B7280]">all time</div>
          </div>
          <div className="bg-white border border-[#E2E4E9] rounded-xl p-4">
            <div className="text-xs text-[#6B7280] mb-1">Total Spent</div>
            <div className="font-bold text-[#0D0D0D] text-sm">${gatewayStats ? gatewayStats.totalSpent.toFixed(4) : '—'}</div>
            <div className="text-xs text-[#6B7280]">USDC</div>
          </div>
          <div className="bg-white border border-[#E2E4E9] rounded-xl p-4">
            <div className="text-xs text-[#6B7280] mb-1">Total Earned</div>
            <div className="font-bold text-[#00B050] text-sm">${sellerEarnings ? sellerEarnings.total_earnings.toFixed(4) : '—'}</div>
            <div className="text-xs text-[#6B7280]">USDC</div>
          </div>
        </div>

        {/* Deposit / Withdraw cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <div className="bg-white border border-[#E2E4E9] rounded-xl p-4">
            <h2 className="text-sm font-bold text-[#0D0D0D] mb-3">Add to Mahshar Balance</h2>
            <div className="mb-3">
              <select
                value={selectedDepositChain}
                onChange={e => { setSelectedDepositChain(e.target.value); bridgeReset(); setDepositError(null) }}
                disabled={depositing || bridgeLoading}
                className="w-full bg-[#FAFAF8] border border-[#E2E4E9] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] focus:outline-none focus:border-[#2775CA] disabled:opacity-50"
              >
                <option value="arc">Arc Testnet (current chain)</option>
                {bridgeBalances.map(b => (
                  <option key={b.chainName} value={b.chainName}>
                    {b.displayName} — {b.isLoading ? 'loading...' : `${b.usdcBalance} USDC`}
                  </option>
                ))}
              </select>
            </div>

            {selectedDepositChain === 'arc' ? (
              <>
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    className="w-24 bg-[#FAFAF8] border border-[#E2E4E9] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA]"
                  />
                  <span className="text-sm text-[#6B7280]">USDC</span>
                  <button
                    onClick={handleDeposit}
                    disabled={depositing || !depositAmount || !publicClient}
                    className="bg-[#2775CA] hover:bg-[#1E63B5] text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {depositStep === 'approving' ? 'Approving...' : depositStep === 'depositing' ? 'Depositing...' : 'Deposit'}
                  </button>
                </div>
                {depositError && <p className="text-xs text-[#DC2626] mt-2">{depositError}</p>}
              </>
            ) : (
              <>
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    disabled={bridgeLoading}
                    className="w-24 bg-[#FAFAF8] border border-[#E2E4E9] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA] disabled:opacity-50"
                  />
                  <span className="text-sm text-[#6B7280]">USDC</span>
                  <button
                    onClick={() => {
                      const chain = SOURCE_CHAINS.find(c => c.chainName === selectedDepositChain)
                      if (chain && address && depositAmount) {
                        void doBridge(chain.chainName, chain.chainId, depositAmount, address)
                      }
                    }}
                    disabled={bridgeLoading || !depositAmount || bridgeStep === 'complete'}
                    className={`min-w-[188px] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors whitespace-nowrap relative overflow-hidden
                      ${bridgeStep === 'complete' ? 'bg-[#16A34A]' : bridgeStep === 'error' ? 'bg-[#DC2626] hover:bg-[#B91C1C]' : 'bg-[#2775CA] hover:bg-[#1E63B5]'}
                      ${bridgeLoading ? 'animate-pulse' : ''}`}
                  >
                    {bridgeStep === 'idle'       ? 'Bridge to Arc & Deposit' :
                     bridgeStep === 'switching'  ? 'Switching network...' :
                     bridgeStep === 'approving'  ? 'Approving USDC...' :
                     bridgeStep === 'burning'    ? 'Burning USDC...' :
                     bridgeStep === 'attesting'  ? 'Waiting for attestation...' :
                     bridgeStep === 'minting'    ? 'Minting on Arc...' :
                     bridgeStep === 'waiting'    ? 'Almost there...' :
                     bridgeStep === 'depositing' ? 'Depositing to Balance...' :
                     bridgeStep === 'complete'   ? 'Complete! ✓' :
                                                   'Failed — Retry'}
                  </button>
                </div>
                {bridgeStep === 'complete' && (
                  <p className="text-xs text-[#16A34A] mt-2">USDC deposited to your Mahshar balance.</p>
                )}
                {bridgeStep === 'error' && bridgeError && (
                  <p className="text-xs text-[#DC2626] mt-2">{bridgeError}</p>
                )}
              </>
            )}
          </div>

          <div className="bg-white border border-[#E2E4E9] rounded-xl p-4">
            <h2 className="text-sm font-bold text-[#0D0D0D] mb-3">Withdraw from Mahshar Balance</h2>
            <p className="text-xs text-[#6B7280] mb-3">Move USDC from your Mahshar balance back to your wallet.</p>
            <div className="flex gap-2 items-center">
              <input
                type="number"
                value={withdrawAmount}
                onChange={e => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                className="w-24 bg-[#FAFAF8] border border-[#E2E4E9] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA]"
              />
              <span className="text-sm text-[#6B7280]">USDC</span>
              <button
                onClick={handleWithdraw}
                disabled={withdrawStep !== 'idle' || !withdrawAmount || !publicClient}
                className="bg-[#00B050] hover:bg-[#008F42] text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {withdrawStep === 'withdrawing' ? 'Withdrawing...' : 'Withdraw'}
              </button>
            </div>
            {withdrawError && <p className="text-xs text-[#DC2626] mt-2">{withdrawError}</p>}
          </div>
        </div>

        {loading && <p className="text-[#6B7280]">Loading...</p>}

        {!loading && (
          <div className="space-y-10">

            {/* My Listed APIs */}
            <div>
              <h2 className="text-lg font-bold text-[#0D0D0D] mb-4">My Listed APIs</h2>
              {myApis.length === 0 ? (
                <div className="bg-white border border-[#E2E4E9] rounded-xl p-8 text-center">
                  <p className="text-[#6B7280] text-sm">You haven&apos;t listed any APIs yet.</p>
                </div>
              ) : (
                <div className="bg-white border border-[#E2E4E9] rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="border-b border-[#E2E4E9]">
                      <tr className="text-left text-[#6B7280]">
                        <th className="px-6 py-4 font-medium">Name</th>
                        <th className="px-6 py-4 font-medium">Category</th>
                        <th className="px-6 py-4 font-medium">Price/call</th>
                        <th className="px-6 py-4 font-medium">Score</th>
                        <th className="px-6 py-4 font-medium">Earned</th>
                        <th className="px-6 py-4 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myApis.map(api => {
                        const earning = sellerEarnings?.earnings_by_api.find(e => e.api_id === api.id)
                        return (
                        <tr key={api.id} className="border-b border-[#E2E4E9] last:border-0 hover:bg-[#F5F5F0]">
                          <td className="px-6 py-4 font-medium text-[#0D0D0D]">{api.name}</td>
                          <td className="px-6 py-4 text-[#6B7280]">{api.category}</td>
                          <td className="px-6 py-4 text-[#0D0D0D]">${api.price_per_call} USDC</td>
                          <td className="px-6 py-4 text-[#2775CA]">{api.score ?? '—'}/10</td>
                          <td className="px-6 py-4 text-[#00B050] font-medium">{earning ? `$${earning.total.toFixed(4)}` : '$0.0000'}</td>
                          <td className="px-6 py-4">
                            <div className="flex gap-2">
                              <button
                                onClick={() => !api.is_active ? toggleActive(api.id, api.is_active) : undefined}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                  api.is_active
                                    ? 'bg-[#16A34A] text-white border-[#16A34A]'
                                    : 'bg-white text-[#6B7280] border-[#E2E4E9] hover:border-[#16A34A] hover:text-[#16A34A]'
                                }`}
                              >
                                Active
                              </button>
                              <button
                                onClick={() => api.is_active ? toggleActive(api.id, api.is_active) : undefined}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                  !api.is_active
                                    ? 'bg-[#DC2626] text-white border-[#DC2626]'
                                    : 'bg-white text-[#6B7280] border-[#E2E4E9] hover:border-[#DC2626] hover:text-[#DC2626]'
                                }`}
                              >
                                Inactive
                              </button>
                              <button
                                onClick={() => {
                                  setEditingApi(api)
                                  setEditForm({
                                    name: api.name,
                                    category: api.category,
                                    description: api.description,
                                    endpoint_url: api.endpoint_url,
                                    auth_type: api.auth_type,
                                    price_per_call: String(api.price_per_call),
                                  })
                                  setShowEditModal(true)
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors bg-white text-[#2775CA] border-[#E2E4E9] hover:border-[#2775CA]"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => { setDeletingApiId(api.id); setDeleteConfirmText('') }}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors bg-white text-[#DC2626] border-[#E2E4E9] hover:border-[#DC2626]"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Recent Buys */}
            <div>
              <h2 className="text-lg font-bold text-[#0D0D0D] mb-4">Recent Buys</h2>
              {callGroups.length === 0 ? (
                <div className="bg-white border border-[#E2E4E9] rounded-xl p-8 text-center">
                  <p className="text-[#6B7280] text-sm">No API calls yet.</p>
                </div>
              ) : (
                <div className="bg-[#FAFAF8] border border-[#E2E4E9] rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="border-b border-[#E2E4E9]">
                      <tr className="text-left text-[#6B7280]">
                        <th className="px-6 py-4 font-medium">API</th>
                        <th className="px-6 py-4 font-medium">Calls</th>
                        <th className="px-6 py-4 font-medium">Avg Latency</th>
                        <th className="px-6 py-4 font-medium">Success</th>
                        <th className="px-6 py-4 font-medium">Spent</th>
                        <th className="px-6 py-4 font-medium">Last Called</th>
                        <th className="px-6 py-4 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {callGroups.map(group => (
                        <tr key={group.apiId} className="border-b border-[#E2E4E9] hover:bg-[#F5F5F0]">
                          <td className="px-6 py-4 font-medium text-[#0D0D0D]">{group.name}</td>
                          <td className="px-6 py-4 text-[#0D0D0D]">{group.count}</td>
                          <td className="px-6 py-4 text-[#0D0D0D]">{group.avgLatency}ms</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${group.successRate === 100 ? 'bg-[#F0FDF4] text-[#16A34A]' : group.successRate >= 50 ? 'bg-[#FFF7ED] text-[#D97706]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>
                              {group.successRate}%
                            </span>
                          </td>
                          <td className="px-6 py-4 text-[#0D0D0D]">${group.spent.toFixed(4)}</td>
                          <td className="px-6 py-4 text-[#6B7280]">{new Date(group.lastCalled).toLocaleString()}</td>
                          <td className="px-6 py-4">
                            <div className="flex gap-2">
                              <button
                                onClick={() => setDetailsApi(group.apiId)}
                                className="bg-[#00B050] hover:bg-[#008F42] text-white px-3 py-1 rounded-lg text-xs font-medium transition-colors"
                              >
                                Details
                              </button>
                              <button
                                onClick={() => void handleViewApi(group.apiId, group.name, group.method)}
                                className="bg-[#2775CA] hover:bg-[#1E63B5] text-white px-3 py-1 rounded-lg text-xs font-medium transition-colors"
                              >
                                View API
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Recent Sells */}
            <div>
              <h2 className="text-lg font-bold text-[#0D0D0D] mb-4">Recent Sells</h2>
              {sellCallGroups.length === 0 ? (
                <div className="bg-white border border-[#E2E4E9] rounded-xl p-8 text-center">
                  <p className="text-[#6B7280] text-sm">No one has called your APIs yet.</p>
                </div>
              ) : (
                <div className="bg-[#FAFAF8] border border-[#E2E4E9] rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="border-b border-[#E2E4E9]">
                      <tr className="text-left text-[#6B7280]">
                        <th className="px-6 py-4 font-medium">API</th>
                        <th className="px-6 py-4 font-medium">Calls</th>
                        <th className="px-6 py-4 font-medium">Avg Latency</th>
                        <th className="px-6 py-4 font-medium">Success</th>
                        <th className="px-6 py-4 font-medium">Last Called</th>
                        <th className="px-6 py-4 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellCallGroups.map(group => (
                        <tr key={group.api_id} className="border-b border-[#E2E4E9] hover:bg-[#F5F5F0]">
                          <td className="px-6 py-4 font-medium text-[#0D0D0D]">{group.api_name}</td>
                          <td className="px-6 py-4 text-[#0D0D0D]">{group.count}</td>
                          <td className="px-6 py-4 text-[#0D0D0D]">{group.avgLatency}ms</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${group.successRate === 100 ? 'bg-[#F0FDF4] text-[#16A34A]' : group.successRate >= 50 ? 'bg-[#FFF7ED] text-[#D97706]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>
                              {group.successRate}%
                            </span>
                          </td>
                          <td className="px-6 py-4 text-[#6B7280]">{new Date(group.lastCalled).toLocaleString()}</td>
                          <td className="px-6 py-4">
                            <button
                              onClick={() => setDetailsSellApi(group.api_id)}
                              className="bg-[#00B050] hover:bg-[#008F42] text-white px-3 py-1 rounded-lg text-xs font-medium transition-colors"
                            >
                              Details
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}

        {showEditModal && editingApi && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50" onClick={() => { setShowEditModal(false); setEditingApi(null) }} />
            <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-[#E2E4E9] flex items-center justify-between">
                <span className="font-bold text-[#0D0D0D]">Edit API</span>
                <button onClick={() => { setShowEditModal(false); setEditingApi(null) }} className="text-[#6B7280] hover:text-[#0D0D0D] transition-colors text-xl leading-none">&times;</button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-[#0D0D0D]">Name</label>
                  <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={inputCls} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-[#0D0D0D]">Category</label>
                    <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} className={inputCls}>
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-[#0D0D0D]">Auth Type</label>
                    <select value={editForm.auth_type} onChange={e => setEditForm(f => ({ ...f, auth_type: e.target.value as AuthType }))} className={inputCls}>
                      <option value="public">Public (no auth)</option>
                      <option value="apikey">API Key (x-api-key)</option>
                      <option value="bearer">Bearer Token</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-[#0D0D0D]">Description</label>
                  <textarea rows={3} value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-[#0D0D0D]">Endpoint URL</label>
                  <input value={editForm.endpoint_url} onChange={e => setEditForm(f => ({ ...f, endpoint_url: e.target.value }))} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-[#0D0D0D]">Price per call (USDC)</label>
                  <input type="number" step="0.0001" min="0.0001" value={editForm.price_per_call} onChange={e => setEditForm(f => ({ ...f, price_per_call: e.target.value }))} className={inputCls} />
                </div>
                <p className="text-xs text-[#6B7280]">{editingApi.encrypted_key ? '🔑 Auth key is set (not shown for security)' : 'No auth key set'}</p>
              </div>
              {apiActionError && (
                <p className="px-6 pb-2 text-xs text-[#DC2626]">{apiActionError}</p>
              )}
              <div className="px-6 py-4 border-t border-[#E2E4E9] flex gap-3 justify-end">
                <button onClick={() => { setShowEditModal(false); setEditingApi(null); setApiActionError(null) }} className="px-4 py-2 rounded-lg text-sm font-medium border border-[#E2E4E9] text-[#6B7280] hover:border-[#0D0D0D] transition-colors">Cancel</button>
                <button onClick={() => { void handleEditSave() }} className="px-4 py-2 rounded-lg text-sm font-medium bg-[#2775CA] hover:bg-[#1E63B5] text-white transition-colors">Save</button>
              </div>
            </div>
          </div>
        )}

        {deletingApiId !== null && (() => {
          const api = myApis.find(a => a.id === deletingApiId)
          if (!api) return null
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => { setDeletingApiId(null); setDeleteConfirmText('') }} />
              <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
                <div className="px-6 py-4 border-b border-[#E2E4E9]">
                  <span className="font-bold text-[#0D0D0D]">Delete API</span>
                </div>
                <div className="px-6 py-5 space-y-4">
                  <p className="text-sm text-[#0D0D0D]">Are you sure you want to delete <span className="font-bold">&apos;{api.name}&apos;</span>? This action cannot be undone.</p>
                  <div className="space-y-1.5">
                    <label className="block text-sm text-[#6B7280]">Type <span className="font-mono font-bold text-[#DC2626]">DELETE</span> to confirm</label>
                    <input value={deleteConfirmText} onChange={e => setDeleteConfirmText(e.target.value)} placeholder="DELETE" className={inputCls} />
                  </div>
                </div>
                {apiActionError && (
                  <p className="px-6 pb-2 text-xs text-[#DC2626]">{apiActionError}</p>
                )}
                <div className="px-6 py-4 border-t border-[#E2E4E9] flex gap-3 justify-end">
                  <button onClick={() => { setDeletingApiId(null); setDeleteConfirmText(''); setApiActionError(null) }} className="px-4 py-2 rounded-lg text-sm font-medium border border-[#E2E4E9] text-[#6B7280] hover:border-[#0D0D0D] transition-colors">Cancel</button>
                  <button onClick={() => { void handleDeleteConfirm() }} disabled={deleteConfirmText !== 'DELETE'} className="px-4 py-2 rounded-lg text-sm font-medium bg-[#DC2626] hover:bg-[#B91C1C] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors">Delete</button>
                </div>
              </div>
            </div>
          )
        })()}

        {detailsApi !== null && (() => {
          const group = callGroups.find(g => g.apiId === detailsApi)
          if (!group) return null
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => setDetailsApi(null)} />
              <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-[#E2E4E9] flex items-center justify-between">
                  <span className="font-bold text-[#0D0D0D]">{group.name}: Call History</span>
                  <button onClick={() => setDetailsApi(null)} className="text-[#6B7280] hover:text-[#0D0D0D] transition-colors text-xl leading-none">&times;</button>
                </div>
                <div className="overflow-y-auto max-h-[60vh]">
                  <table className="w-full text-sm">
                    <thead className="border-b border-[#E2E4E9] sticky top-0 bg-white">
                      <tr className="text-left text-[#6B7280]">
                        <th className="px-6 py-3 font-medium">Time</th>
                        <th className="px-6 py-3 font-medium">Latency</th>
                        <th className="px-6 py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.calls.map(call => (
                        <tr key={call.id} className="border-b border-[#E2E4E9] last:border-0 hover:bg-[#F5F5F0]">
                          <td className="px-6 py-3 text-[#6B7280]">{new Date(call.created_at).toLocaleString()}</td>
                          <td className="px-6 py-3 text-[#0D0D0D]">{call.latency_ms}ms</td>
                          <td className="px-6 py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${call.success ? 'bg-[#F0FDF4] text-[#16A34A]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>
                              {call.success ? 'Success' : 'Failed'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        })()}

        {detailsSellApi !== null && (() => {
          const group = sellCallGroups.find(g => g.api_id === detailsSellApi)
          if (!group) return null
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => setDetailsSellApi(null)} />
              <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-[#E2E4E9] flex items-center justify-between">
                  <span className="font-bold text-[#0D0D0D]">{group.api_name}: Incoming Calls</span>
                  <button onClick={() => setDetailsSellApi(null)} className="text-[#6B7280] hover:text-[#0D0D0D] transition-colors text-xl leading-none">&times;</button>
                </div>
                <div className="overflow-y-auto max-h-[60vh]">
                  <table className="w-full text-sm">
                    <thead className="border-b border-[#E2E4E9] sticky top-0 bg-white">
                      <tr className="text-left text-[#6B7280]">
                        <th className="px-6 py-3 font-medium">Buyer</th>
                        <th className="px-6 py-3 font-medium">Time</th>
                        <th className="px-6 py-3 font-medium">Latency</th>
                        <th className="px-6 py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.calls.map(call => (
                        <tr key={call.id} className="border-b border-[#E2E4E9] last:border-0 hover:bg-[#F5F5F0]">
                          <td className="px-6 py-3 text-[#6B7280] font-mono text-xs">{call.buyer_wallet.slice(0, 6)}...{call.buyer_wallet.slice(-4)}</td>
                          <td className="px-6 py-3 text-[#6B7280]">{new Date(call.created_at).toLocaleString()}</td>
                          <td className="px-6 py-3 text-[#0D0D0D]">{call.latency_ms}ms</td>
                          <td className="px-6 py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${call.success ? 'bg-[#F0FDF4] text-[#16A34A]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>
                              {call.success ? 'Success' : 'Failed'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        })()}
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
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(viewCodeSnippet)
                  setViewApiCopied(true)
                  setTimeout(() => setViewApiCopied(false), 2000)
                }}
                className={`mt-3 w-full py-2 rounded-lg text-sm font-medium border transition-colors ${viewApiCopied ? 'bg-[#F0FDF4] border-[#86EFAC] text-[#16A34A]' : 'bg-white border-[#E2E4E9] text-[#6B7280] hover:border-[#2775CA] hover:text-[#2775CA]'}`}
              >
                {viewApiCopied ? 'Copied!' : 'Copy to clipboard'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
