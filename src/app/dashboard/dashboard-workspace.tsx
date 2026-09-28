'use client'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import { useAccount, useReadContract, useWriteContract, usePublicClient, useBlockNumber, useSwitchChain, useSignMessage } from 'wagmi'
import { buildConfirmMessage, buildWithdrawMessage } from '@/lib/withdraw-auth-message'
import { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { parseUnits, type EIP1193Provider } from 'viem'
import { usdcAmount } from '@/lib/circle-bridge'
import { AppKit, UnifiedBalanceChain } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { ApiListing, AuthType } from '@/types'
import type { DeclaredParameter } from '@/lib/marketplace/proxy-target'
import { useBridgeBalances } from '@/hooks/useBridgeBalances'
import { useBridge } from '@/hooks/useBridge'
import { ARC, ARC_MAINNET } from '@/lib/arc'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useSolanaBridgeBalance } from '@/hooks/useSolanaBridgeBalance'
import { sendLocalNotification, useProductPreferences } from '@/components/ProductPreferencesProvider'
import { useVisibilityRefresh } from '@/hooks/useVisibilityRefresh'
import { readPurchasedResponse } from '@/lib/marketplace/purchase-access-client'
import { createTargetedWalletRefreshScheduler, type WalletRefreshAction, type WalletRefreshResource } from '@/lib/wallet-refresh'


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
  totalCalls?: number
  totalSpent?: number
  purchasesByApiId?: Record<string, number>
}

interface EarningsByApi {
  api_id: string
  api_name: string
  total: number
  calls: number
}

interface SellerEarnings {
  total_earnings: number
  accumulated_share: number
  in_flight_withdrawals: number
  withdrawable_balance: number
  earnings_by_api: EarningsByApi[]
}

interface ReadOnlySellerListing {
  id: string
  name: string
  category: string
  price_per_call: number
  payment_model: ApiListing['payment_model']
  seller_wallet: string
  method: string | null
  score: number | null
  uptime: number | null
  created_at: string
  is_active: boolean
  verified_at: string | null
  description: string
  auth_type: AuthType
  example_request: string | null
  example_response: string | null
  expected_status_codes: number[] | null
  request_contract_error?: string | null
}

interface ReadOnlySellerStatistics extends SellerEarnings {
  total_calls: number
  listings: ReadOnlySellerListing[]
}

export interface ListingEditForm {
  name: string
  category: string
  description: string
  endpoint_url: string
  auth_type: AuthType
  auth_param_name: string
  price_per_call: string
  method: string
  example_request: string
  body_required: boolean
  dynamic_path_supported: boolean
  path_parameters: DeclaredParameter[]
  query_parameters: DeclaredParameter[]
}

interface SellCallEntry {
  id: string
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

const { chainId: ARC_CHAIN_ID, usdcAddress: ARC_USDC, gatewayWallet: ARC_GATEWAY_WALLET } = ARC

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const

const GATEWAY_PENDING_WITHDRAWAL_ABI = [
  { name: 'withdrawingBalance', type: 'function', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'depositor', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'withdrawalBlock', type: 'function', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'depositor', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'initiateWithdrawal', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }], outputs: [] },
] as const

export const IS_ARC_MAINNET = ARC.chainId === ARC_MAINNET.chainId

// Keep in sync with src/app/api/seller/withdraw/route.ts MIN_WITHDRAW_USDC.
export const MIN_WITHDRAW_USDC = 1
const MIN_BUYER_WITHDRAW_USDC = 1

const appKit = new AppKit()

// This hook is instantiated only by the dashboard provider, never by route consumers.
function useDashboardWorkspaceState() {
  const { address, isConnected, connector } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const { signMessageAsync } = useSignMessage()
  const { request: authorizedFetch, sensitiveRequest } = useMarketplaceSession()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const { preferences } = useProductPreferences()
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences

  const privateSnapshotLoadedRef = useRef(false)
  const [myApis, setMyApis] = useState<ApiListing[]>([])
  const [calls, setCalls] = useState<ApiCall[]>([])
  const [sellerEarnings, setSellerEarnings] = useState<SellerEarnings | null>(null)
  const [loading, setLoading] = useState(false)
  const [gatewayStats, setGatewayStats] = useState<GatewayStats | null>(null)
  const [gatewayUnavailable, setGatewayUnavailable] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositStep, setDepositStep] = useState<'idle' | 'approving' | 'depositing'>('idle')
  const [depositError, setDepositError] = useState<string | null>(null)

  const { balances: bridgeBalances, refresh: refreshBridgeBalances } = useBridgeBalances()
  const { publicKey: solanaPubkey, connected: solanaConnected, disconnect: solanaDisconnect } = useWallet()
  const { setVisible: setSolanaModalVisible } = useWalletModal()
  const solanaBalance = useSolanaBridgeBalance(solanaPubkey?.toBase58() ?? null)
  const circleBridge = useBridge()
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawStep, setWithdrawStep] = useState<'idle' | 'withdrawing'>('idle')
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [withdrawFlatFee, setWithdrawFlatFee] = useState<number | null>(null)
  const [initiateStep, setInitiateStep] = useState<'idle' | 'initiating'>('idle')
  const [initiateError, setInitiateError] = useState<string | null>(null)
  const [releaseStep, setReleaseStep] = useState<'idle' | 'releasing'>('idle')
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [earningsWithdrawAmount, setEarningsWithdrawAmount] = useState('')
  const [earningsWithdrawStep, setEarningsWithdrawStep] = useState<'idle' | 'withdrawing' | 'checking'>('idle')
  const [earningsWithdrawError, setEarningsWithdrawError] = useState<string | null>(null)
  const [earningsWithdrawResult, setEarningsWithdrawResult] = useState<{ net: number; gas: number; tx: string } | null>(null)
  const [pendingWithdrawalRecovery, setPendingWithdrawalRecovery] = useState<{ id: string; status: string } | null>(null)
  const [withdrawalRecoveryMessage, setWithdrawalRecoveryMessage] = useState<string | null>(null)
  const [sellCallGroups, setSellCallGroups] = useState<SellCallGroup[]>([])
  const [detailsApi, setDetailsApi] = useState<string | null>(null)
  const [detailsSellApi, setDetailsSellApi] = useState<string | null>(null)
  const [editingApi, setEditingApi] = useState<ApiListing | null>(null)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState<ListingEditForm>({ name: '', category: '', description: '', endpoint_url: '', auth_type: 'public', auth_param_name: '', price_per_call: '', method: 'GET', example_request: '', body_required: false, dynamic_path_supported: false, path_parameters: [], query_parameters: [] })
  const [deletingApiId, setDeletingApiId] = useState<string | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [apiActionError, setApiActionError] = useState<string | null>(null)
  const [viewApiModal, setViewApiModal] = useState<{ apiId: string; apiName: string; method: string } | null>(null)
  const [viewApiResponse, setViewApiResponse] = useState<unknown>(null)
  const [viewApiLoading, setViewApiLoading] = useState(false)
  const [viewApiCopied, setViewApiCopied] = useState(false)
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState<number | null>(null)
  const balanceRefreshInFlight = useRef(new Map<string, Promise<boolean>>())
  const marketplaceRefreshInFlight = useRef(new Map<string, Promise<void>>())
  const gatewayRefreshInFlight = useRef(new Map<string, Promise<boolean>>())
  const sellerStatisticsInFlight = useRef(new Map<string, Promise<ReadOnlySellerStatistics | null>>())
  const privateRequestControllers = useRef(new Map<string, Set<AbortController>>())
  const myApisRef = useRef<ApiListing[]>([])
  const readOnlyApisRef = useRef<ApiListing[]>([])
  const balanceIsStale = useRef(false)
  const marketplaceIsStale = useRef(false)
  const sellerSalesCount = useRef<number | null>(null)
  const initialLoadAddress = useRef<string | null>(null)
  const initialAggregateRefreshStarted = useRef(false)
  const currentAddress = useRef(address)
  currentAddress.current = address
  const isCurrentWallet = useCallback((wallet: string) => currentAddress.current?.toLowerCase() === wallet, [])
  const privateFetch = useCallback(async (wallet: string, input: string) => {
    const controller = new AbortController()
    const controllers = privateRequestControllers.current.get(wallet) ?? new Set<AbortController>()
    controllers.add(controller)
    privateRequestControllers.current.set(wallet, controllers)
    try {
      return await authorizedFetch(input, { cache: 'no-store', signal: controller.signal })
    } finally {
      controllers.delete(controller)
      if (controllers.size === 0) privateRequestControllers.current.delete(wallet)
    }
  }, [authorizedFetch])

  const { data: walletUsdcRaw, refetch: refetchUsdcBalance } = useReadContract({
    address: ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, staleTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false },
  })

  const { data: withdrawingRaw, refetch: refetchWithdrawing } = useReadContract({
    address: ARC_GATEWAY_WALLET,
    abi: GATEWAY_PENDING_WITHDRAWAL_ABI,
    functionName: 'withdrawingBalance',
    args: [ARC_USDC, address ?? '0x0000000000000000000000000000000000000000'],
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, staleTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false },
  })

  const { data: withdrawalBlockRaw, refetch: refetchWithdrawalBlock } = useReadContract({
    address: ARC_GATEWAY_WALLET,
    abi: GATEWAY_PENDING_WITHDRAWAL_ABI,
    functionName: 'withdrawalBlock',
    args: [ARC_USDC, address ?? '0x0000000000000000000000000000000000000000'],
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, staleTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false },
  })

  const { data: currentBlock } = useBlockNumber({ chainId: ARC_CHAIN_ID, watch: true })

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

  const fetchGatewayStats = useCallback(() => {
    if (!address) return Promise.resolve(false)
    const wallet = address.toLowerCase()
    const existing = gatewayRefreshInFlight.current.get(wallet)
    if (existing) return existing
    const request = (async () => {
      try {
        // This public endpoint returns only Circle's balance, never offchain history.
        const res = await privateFetch(wallet, `/api/gateway/balance?wallet=${wallet}`)
        if (!res.ok) { if (isCurrentWallet(wallet)) setGatewayUnavailable(true); return false }
        const stats = await res.json() as GatewayStats
        if (typeof stats.gatewayAvailable !== 'string' || !isCurrentWallet(wallet)) return false
        setGatewayStats(stats)
        setGatewayUnavailable(false)
        return true
      } catch { if (isCurrentWallet(wallet)) setGatewayUnavailable(true); return false }
    })().finally(() => {
      if (gatewayRefreshInFlight.current.get(wallet) === request) gatewayRefreshInFlight.current.delete(wallet)
    })
    gatewayRefreshInFlight.current.set(wallet, request)
    return request
  }, [address, isCurrentWallet, privateFetch])

  const fetchSellerStatisticsSnapshot = useCallback(() => {
    if (!address) return Promise.resolve(null)
    const wallet = address.toLowerCase()
    const existing = sellerStatisticsInFlight.current.get(wallet)
    if (existing) return existing
    const request = (async () => {
      try {
        const response = await privateFetch(wallet, `/api/seller/statistics/${encodeURIComponent(wallet)}`)
        if (!response.ok) return null
        const statistics = await response.json() as ReadOnlySellerStatistics
        if (!Array.isArray(statistics.listings) || !isCurrentWallet(wallet)) return null
        return statistics
      } catch { return null }
    })().finally(() => {
      if (sellerStatisticsInFlight.current.get(wallet) === request) sellerStatisticsInFlight.current.delete(wallet)
    })
    sellerStatisticsInFlight.current.set(wallet, request)
    return request
  }, [address, isCurrentWallet, privateFetch])

  const fetchReadOnlySellerStatistics = useCallback(async () => {
    if (!address) return false
    const wallet = address.toLowerCase()
    const statistics = await fetchSellerStatisticsSnapshot()
    if (!statistics || !isCurrentWallet(wallet)) return false
    try {
      const safeListings: ApiListing[] = statistics.listings.map(listing => ({
        ...listing,
        encrypted_key: null,
        endpoint_url: '',
        auth_param_name: null,
      }))
      setSellerEarnings(statistics)
      readOnlyApisRef.current = safeListings
      if (!privateSnapshotLoadedRef.current) {
        myApisRef.current = safeListings
        setMyApis(safeListings)
      }
      if (sellerSalesCount.current !== null && statistics.total_calls > sellerSalesCount.current && preferencesRef.current.notifications.sellerSale) {
        const increase = statistics.total_calls - sellerSalesCount.current
        sendLocalNotification('New Mahshar sale', `${increase} new paid API call${increase === 1 ? '' : 's'} recorded.`)
      }
      sellerSalesCount.current = statistics.total_calls
      return true
    } catch { return false }
  }, [address, fetchSellerStatisticsSnapshot, isCurrentWallet])

  const fetchSellerEarnings = useCallback(async () => {
    if (!address) return false
    const wallet = address.toLowerCase()
    const statistics = await fetchSellerStatisticsSnapshot()
    if (!statistics || !isCurrentWallet(wallet)) return false
    setSellerEarnings(statistics)
    return true
  }, [address, fetchSellerStatisticsSnapshot, isCurrentWallet])

  const clearPrivateData = useCallback((wallet?: string) => {
    if (wallet && !isCurrentWallet(wallet)) return
    privateSnapshotLoadedRef.current = false
    myApisRef.current = readOnlyApisRef.current
    setMyApis(readOnlyApisRef.current)
    setSellCallGroups([])
    setCalls([])
  }, [isCurrentWallet])

  const fetchBuyerCalls = useCallback(async () => {
    if (!address) return false
    const wallet = address.toLowerCase()
    try {
      const response = await privateFetch(wallet, `/api/calls?buyer_wallet=${wallet}`)
      if (!response.ok) return false
      const data = await response.json() as { calls?: ApiCall[] }
      if (!isCurrentWallet(wallet)) return false
      setCalls(data.calls ?? [])
      return true
    } catch { return false }
  }, [address, isCurrentWallet, privateFetch])

  const loadPrivateSnapshot = useCallback(async () => {
    if (!address) return false
    const wallet = address.toLowerCase()
    const [callsResponse, buyerCallsLoaded, historyResponse] = await Promise.all([
      privateFetch(wallet, `/api/seller/calls?seller_wallet=${wallet}`),
      fetchBuyerCalls(),
      privateFetch(wallet, `/api/gateway/balance?wallet=${wallet}&include_history=true`),
    ])
    if (!isCurrentWallet(wallet)) return false
    if (callsResponse.status === 401 || historyResponse.status === 401) {
      clearPrivateData(wallet)
      return false
    }
    if (callsResponse.ok) {
      const groups = (await callsResponse.json() as { groups: SellCallGroup[] }).groups
      if (!isCurrentWallet(wallet)) return false
      setSellCallGroups(groups)
    }
    if (historyResponse.ok) {
      const history = await historyResponse.json() as GatewayStats
      if (!isCurrentWallet(wallet)) return false
      setGatewayStats(history)
    }
    if (!isCurrentWallet(wallet)) return false
    privateSnapshotLoadedRef.current = true
    return callsResponse.ok && buyerCallsLoaded && historyResponse.ok
  }, [address, clearPrivateData, fetchBuyerCalls, isCurrentWallet, privateFetch])

  const refreshMarketplaceData = useCallback(() => {
    if (!address) return Promise.resolve()
    const wallet = address.toLowerCase()
    const existing = marketplaceRefreshInFlight.current.get(wallet)
    if (existing) return existing
    const request = Promise.all([
      fetchReadOnlySellerStatistics(),
      privateSnapshotLoadedRef.current ? loadPrivateSnapshot() : fetchBuyerCalls(),
    ]).then(() => { if (isCurrentWallet(wallet)) marketplaceIsStale.current = false }).finally(() => {
      if (marketplaceRefreshInFlight.current.get(wallet) === request) marketplaceRefreshInFlight.current.delete(wallet)
    })
    marketplaceRefreshInFlight.current.set(wallet, request)
    return request
  }, [address, fetchBuyerCalls, fetchReadOnlySellerStatistics, isCurrentWallet, loadPrivateSnapshot])

  const refreshBalanceData = useCallback(() => {
    if (!address) return Promise.resolve(true)
    const wallet = address.toLowerCase()
    const existing = balanceRefreshInFlight.current.get(wallet)
    if (existing) return existing
    const request = Promise.all([
      fetchGatewayStats(),
      refetchUsdcBalance(),
      refetchWithdrawing(),
      refetchWithdrawalBlock(),
      refreshBridgeBalances(),
      solanaBalance.refresh(),
    ]).then(([gatewaySucceeded, walletResult, withdrawingResult, withdrawalBlockResult, bridgeSucceeded, solanaSucceeded]) => {
      if (!isCurrentWallet(wallet)) return false
      const succeeded = gatewaySucceeded && walletResult.isSuccess && withdrawingResult.isSuccess
        && withdrawalBlockResult.isSuccess && bridgeSucceeded && solanaSucceeded
      balanceIsStale.current = !succeeded
      if (succeeded) setBalanceUpdatedAt(Date.now())
      return succeeded
    }).finally(() => {
      if (balanceRefreshInFlight.current.get(wallet) === request) balanceRefreshInFlight.current.delete(wallet)
    })
    balanceRefreshInFlight.current.set(wallet, request)
    return request
  }, [address, fetchGatewayStats, isCurrentWallet, refetchUsdcBalance, refetchWithdrawing, refetchWithdrawalBlock, refreshBridgeBalances, solanaBalance.refresh])

  const fetchLiveData = useCallback(async () => {
    await Promise.all([refreshMarketplaceData(), refreshBalanceData()])
  }, [refreshMarketplaceData, refreshBalanceData])
  const markMarketplaceStale = useCallback(() => { marketplaceIsStale.current = true }, [])

  const runTargetedWalletRefresh = useCallback(async (resources: ReadonlySet<WalletRefreshResource>, scope: string) => {
    if (currentAddress.current?.toLowerCase() !== scope) return
    const requests: Promise<unknown>[] = []
    if (resources.has('arcWallet')) requests.push(refetchUsdcBalance())
    if (resources.has('gateway')) requests.push(fetchGatewayStats())
    if (resources.has('pendingWithdrawal')) requests.push(Promise.all([refetchWithdrawing(), refetchWithdrawalBlock()]))
    if (resources.has('evmBridge')) requests.push(refreshBridgeBalances())
    if (resources.has('solana')) requests.push(solanaBalance.refresh())
    if (resources.has('sellerEarnings')) requests.push(fetchSellerEarnings())
    await Promise.allSettled(requests)
  }, [fetchGatewayStats, fetchSellerEarnings, refetchUsdcBalance, refetchWithdrawalBlock, refetchWithdrawing, refreshBridgeBalances, solanaBalance.refresh])
  const targetedRefreshRunner = useRef(runTargetedWalletRefresh)
  targetedRefreshRunner.current = runTargetedWalletRefresh
  const targetedRefreshSnapshots = useRef<Record<WalletRefreshResource, unknown>>({
    arcWallet: null, gateway: null, pendingWithdrawal: null, evmBridge: null, solana: null, sellerEarnings: null,
  })
  targetedRefreshSnapshots.current = {
    arcWallet: walletUsdcRaw?.toString() ?? null,
    gateway: gatewayStats?.gatewayAvailable ?? null,
    pendingWithdrawal: `${withdrawingRaw?.toString() ?? ''}:${withdrawalBlockRaw?.toString() ?? ''}`,
    evmBridge: bridgeBalances.map(balance => `${balance.chainName}:${balance.usdcBalance}`).join('|'),
    solana: solanaBalance.usdcBalance,
    sellerEarnings: sellerEarnings ? `${sellerEarnings.withdrawable_balance}:${sellerEarnings.in_flight_withdrawals}:${sellerEarnings.total_earnings}` : null,
  }
  const targetedRefreshScheduler = useRef<ReturnType<typeof createTargetedWalletRefreshScheduler> | null>(null)
  if (!targetedRefreshScheduler.current) {
    targetedRefreshScheduler.current = createTargetedWalletRefreshScheduler({
      getScope: () => currentAddress.current ?? null,
      refresh: (resources, scope) => targetedRefreshRunner.current(resources, scope),
      getSnapshot: resource => targetedRefreshSnapshots.current[resource],
    })
  }
  const scheduleWalletRefresh = useCallback((action: WalletRefreshAction) => targetedRefreshScheduler.current?.schedule(action), [])
  useEffect(() => () => targetedRefreshScheduler.current?.cancel(), [address])

  useEffect(() => {
    const wallet = address?.toLowerCase() ?? null
    if (wallet && initialLoadAddress.current === wallet) return
    initialLoadAddress.current = wallet
    for (const [requestWallet, controllers] of privateRequestControllers.current) {
      if (requestWallet !== wallet) {
        for (const controller of controllers) controller.abort()
        privateRequestControllers.current.delete(requestWallet)
      }
    }
    initialAggregateRefreshStarted.current = false
    myApisRef.current = []
    readOnlyApisRef.current = []
    setMyApis([])
    setCalls([])
    setSellerEarnings(null)
    setSellCallGroups([])
    setGatewayStats(null)
    setGatewayUnavailable(false)
    setBalanceUpdatedAt(null)
    sellerSalesCount.current = null
    privateSnapshotLoadedRef.current = false
    setViewApiResponse(null)
    setViewApiModal(null)
    setViewApiLoading(false)
    setEarningsWithdrawAmount('')
    setEarningsWithdrawError(null)
    setEarningsWithdrawResult(null)
    setPendingWithdrawalRecovery(null)
    setWithdrawalRecoveryMessage(null)
    setEarningsWithdrawStep('idle')
    setDepositAmount('')
    setDepositError(null)
    setDepositStep('idle')
    setWithdrawAmount('')
    setWithdrawError(null)
    setWithdrawStep('idle')
    setInitiateError(null)
    setInitiateStep('idle')
    setReleaseError(null)
    setReleaseStep('idle')
    setWithdrawFlatFee(null)
    setApiActionError(null)
    setEditingApi(null)
    setShowEditModal(false)
    setDeletingApiId(null)
    if (!wallet) { setLoading(false); return }
    setLoading(true)
    void fetchLiveData().catch(() => {}).finally(() => { if (isCurrentWallet(wallet)) setLoading(false) })
  }, [address, fetchLiveData, isCurrentWallet])

  useVisibilityRefresh(refreshMarketplaceData, !!address)
  useVisibilityRefresh(refreshBalanceData, !!address && preferences.autoRefreshBalances)
  useEffect(() => {
    if (!address || balanceUpdatedAt !== null || initialAggregateRefreshStarted.current || !bridgeBalances.length) return
    if (bridgeBalances.some(balance => balance.isLoading || balance.usdcBalance === '?')) return
    initialAggregateRefreshStarted.current = true
    void refreshBalanceData()
  }, [address, balanceUpdatedAt, bridgeBalances, refreshBalanceData])

  async function beginEditApi(apiId: string) {
    if (!address) return
    const wallet = address.toLowerCase()
    setApiActionError(null)
    try {
      const response = await privateFetch(wallet, `/api/apis/${encodeURIComponent(apiId)}`)
      const payload = await response.json().catch(() => ({})) as { api?: ApiListing; error?: string }
      if (!isCurrentWallet(wallet)) return
      if (!response.ok || !payload.api) throw new Error(payload.error ?? 'The listing could not be loaded for editing.')
      const api = payload.api
      setEditingApi(api)
      setEditForm({
        name: api.name,
        category: api.category,
        description: api.description,
        endpoint_url: api.endpoint_url,
        auth_type: api.auth_type,
        auth_param_name: api.auth_param_name ?? '',
        price_per_call: String(api.price_per_call),
        method: api.method ?? 'GET',
        example_request: api.example_request ?? '',
        body_required: api.body_required === true,
        dynamic_path_supported: api.dynamic_path_supported === true,
        path_parameters: Array.isArray(api.path_parameters) ? api.path_parameters as DeclaredParameter[] : [],
        query_parameters: Array.isArray(api.query_parameters) ? api.query_parameters as DeclaredParameter[] : [],
      })
      setShowEditModal(true)
    } catch (error) {
      if (!isCurrentWallet(wallet)) return
      setApiActionError(error instanceof Error ? error.message : 'The listing could not be loaded for editing.')
    }
  }

  // Pre-estimate the flat withdrawal fee (gas + forwarder) once per session so it
  // can be shown inline before the user submits. Arc→Arc fees are per-intent, not
  // proportional to amount, so a nominal 1 USDC estimate covers all amounts.
  //
  // Dep is connector?.id (stable string) not the connector object — the object
  // reference from useAccount() is not guaranteed stable across renders and would
  // retrigger the effect on every render, causing a fetch loop.
  useEffect(() => {
    if (!address || !connector) { setWithdrawFlatFee(null); return }
    let cancelled = false
    const timer = setTimeout(() => {
      ;(async () => {
        try {
          const provider = (await connector.getProvider()) as EIP1193Provider
          const adapter = await createViemAdapterFromProvider({ provider })
          const chain = UnifiedBalanceChain.Arc
          const est = await appKit.unifiedBalance.estimateSpend({
            from: { adapter, allocations: [{ amount: '1', chain }] },
            to: { chain, recipientAddress: address, useForwarder: true },
            amount: '1',
            token: 'USDC',
          })
          if (!cancelled) setWithdrawFlatFee(est.fees.reduce((s, f) => s + parseFloat(f.amount), 0))
        } catch {
          if (!cancelled) setWithdrawFlatFee(null)
        }
      })()
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [address, connector?.id])

  async function handleDeposit() {
    if (!address || !depositAmount || !publicClient) return
    const wallet = address.toLowerCase()
    setDepositStep('approving')
    setDepositError(null)
    try {
      if (!connector) throw new Error('Connect your Arc wallet.')
      const evmConnector = connector
      const amount = usdcAmount(depositAmount)
      // Re-read the actual Arc balance; never treat a bridge's input as net received.
      const available = await publicClient.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })
      if (parseUnits(amount, 6) > available) throw new Error('Amount exceeds your current Arc USDC balance. Leave USDC for gas.')
      await switchChainAsync({ chainId: ARC_CHAIN_ID })
      // Wallet deposits are Arc EVM operations. Never consult the Solana wallet context here.
      const provider = await evmConnector.getProvider() as EIP1193Provider
      const accounts = await provider.request({ method: 'eth_accounts' })
      if (accounts[0]?.toLowerCase() !== address.toLowerCase()) throw new Error('Wallet changed. Review the deposit again.')
      const adapter = await createViemAdapterFromProvider({ provider })
      setDepositStep('depositing')
      await appKit.unifiedBalance.deposit({
        from: { adapter, chain: UnifiedBalanceChain.Arc },
        amount, token: 'USDC', allowanceStrategy: 'approve',
      })

      if (!isCurrentWallet(wallet)) return
      setDepositAmount('')
      scheduleWalletRefresh({ kind: 'gatewayDeposit' })
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      setDepositError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrentWallet(wallet)) setDepositStep('idle')
    }
  }

  async function handleWithdraw() {
    if (!address || !withdrawAmount || !connector) return
    const wallet = address.toLowerCase()
    setWithdrawStep('withdrawing')
    setWithdrawError(null)
    try {
      const amt = parseFloat(withdrawAmount)
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount')

      if (amt < MIN_BUYER_WITHDRAW_USDC)
        throw new Error(`Minimum withdrawal is $${MIN_BUYER_WITHDRAW_USDC.toFixed(2)} USDC.`)

      // Fees come from the Gateway balance ON TOP of the requested amount.
      // Recipient receives exactly amt; balance debited is amt + fees.
      const available = parseFloat(gatewayStats?.gatewayAvailable ?? '0')
      if (withdrawFlatFee !== null && amt + withdrawFlatFee > available) {
        throw new Error(
          `Insufficient balance. ${amt.toFixed(4)} USDC + ~${withdrawFlatFee.toFixed(4)} USDC fees = ` +
          `~${(amt + withdrawFlatFee).toFixed(4)} USDC needed, you have ${available.toFixed(4)} USDC.`,
        )
      }

      await switchChainAsync({ chainId: ARC_CHAIN_ID })

      const provider = (await connector.getProvider()) as EIP1193Provider
      const adapter = await createViemAdapterFromProvider({ provider })
      const destChain = UnifiedBalanceChain.Arc

      await appKit.unifiedBalance.spend({
        from: { adapter, allocations: [{ chain: UnifiedBalanceChain.Arc, amount: amt.toFixed(6) }] },
        to: { chain: destChain, recipientAddress: address, useForwarder: true },
        token: 'USDC',
        amount: amt.toFixed(6),
      })

      if (!isCurrentWallet(wallet)) return
      setWithdrawAmount('')
      if (preferencesRef.current.notifications.withdrawalCompleted) {
        sendLocalNotification('Withdrawal completed', `${amt.toFixed(6)} USDC was sent to your Arc wallet.`)
      }
      scheduleWalletRefresh({ kind: 'gatewayWithdrawal' })
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      const msg = err instanceof Error ? err.message : String(err)
      setWithdrawError(
        /signature|signer|isvalidsignature|1271/i.test(msg)
          ? 'Signature validation failed — try the trustless withdrawal (7 days) instead.'
          : msg,
      )
    } finally {
      if (isCurrentWallet(wallet)) setWithdrawStep('idle')
    }
  }

  async function handleInitiateWithdraw() {
    if (!address || !withdrawAmount || !publicClient) return
    const wallet = address.toLowerCase()
    setInitiateStep('initiating')
    setInitiateError(null)
    try {
      const amount = Math.round(parseFloat(withdrawAmount) * 1_000_000)
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount')
      const amountBigInt = BigInt(amount)

      const hash = await writeContractAsync({
        address: ARC_GATEWAY_WALLET,
        abi: GATEWAY_PENDING_WITHDRAWAL_ABI,
        functionName: 'initiateWithdrawal',
        args: [ARC_USDC, amountBigInt],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash })

      if (!isCurrentWallet(wallet)) return
      setWithdrawAmount('')
      scheduleWalletRefresh({ kind: 'trustlessWithdrawalInitiated' })
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      setInitiateError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrentWallet(wallet)) setInitiateStep('idle')
    }
  }

  async function handleReleasePending() {
    if (!address || !publicClient) return
    const wallet = address.toLowerCase()
    setReleaseStep('releasing')
    setReleaseError(null)
    try {
      const hash = await writeContractAsync({
        address: ARC_GATEWAY_WALLET,
        abi: GATEWAY_PENDING_WITHDRAWAL_ABI,
        functionName: 'withdraw',
        args: [ARC_USDC],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      if (!isCurrentWallet(wallet)) return
      scheduleWalletRefresh({ kind: 'trustlessWithdrawalReleased' })
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      setReleaseError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrentWallet(wallet)) setReleaseStep('idle')
    }
  }

  async function handleWithdrawEarnings() {
    if (!address || !earningsWithdrawAmount) return
    const wallet = address.toLowerCase()
    setEarningsWithdrawError(null)
    setEarningsWithdrawResult(null)
    setWithdrawalRecoveryMessage(null)
    setEarningsWithdrawStep('withdrawing')
    try {
      const amt = parseFloat(earningsWithdrawAmount)
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount')

      if (amt < MIN_WITHDRAW_USDC) {
        throw new Error(`Minimum withdrawal is $${MIN_WITHDRAW_USDC.toFixed(2)} USDC.`)
      }

      const available = sellerEarnings?.withdrawable_balance ?? 0
      if (amt > available) {
        throw new Error(`Amount exceeds withdrawable balance ($${available.toFixed(4)} USDC).`)
      }

      const timestamp = new Date().toISOString()
      const nonce = crypto.randomUUID()
      const message = buildWithdrawMessage({ sellerWallet: address, amountUsdc: amt.toFixed(6), timestamp, nonce })
      const signature = await signMessageAsync({ message })
      const res = await fetch('/api/seller/withdraw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seller_wallet: address, amount_usdc: amt, timestamp, nonce, signature }),
      })
      const body = await res.json().catch(() => ({})) as {
          withdrawal_id?: string
          requested_amount_usdc?: number
          net_amount_usdc?: number
          gas_cost_usdc?: number
          mint_tx_hash?: string
          status?: string
          error?: string
      }
      if (!isCurrentWallet(wallet)) return
      if (body.withdrawal_id && ['submission_unknown', 'mint_unknown', 'pending_mint'].includes(body.status ?? '')) {
        setPendingWithdrawalRecovery({ id: body.withdrawal_id, status: body.status! })
        setEarningsWithdrawAmount('')
        setWithdrawalRecoveryMessage('Withdrawal is still being confirmed. Your reserved balance is safely recorded and cannot be withdrawn twice.')
        markMarketplaceStale()
        scheduleWalletRefresh({ kind: 'sellerWithdrawal' })
        return
      }
      if (!res.ok || body.status !== 'minted') throw new Error(body.error ?? `Withdrawal failed (status: ${body.status ?? 'unknown'})`)
      setPendingWithdrawalRecovery(null)
      setEarningsWithdrawAmount('')
      setEarningsWithdrawResult({
          net: body.net_amount_usdc ?? 0,
          gas: body.gas_cost_usdc ?? 0,
          tx: body.mint_tx_hash ?? '',
      })
      if (preferencesRef.current.notifications.withdrawalCompleted) sendLocalNotification('Seller withdrawal completed', `${(body.net_amount_usdc ?? 0).toFixed(6)} USDC was sent to your wallet.`)
      markMarketplaceStale()
      scheduleWalletRefresh({ kind: 'sellerWithdrawal' })
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      setEarningsWithdrawError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrentWallet(wallet)) setEarningsWithdrawStep('idle')
    }
  }

  async function handleCheckWithdrawalStatus(withdrawalId?: string) {
    if (!address) return
    const id = withdrawalId ?? pendingWithdrawalRecovery?.id
    if (!id || earningsWithdrawStep !== 'idle') return
    const wallet = address.toLowerCase()
    setEarningsWithdrawStep('checking')
    setEarningsWithdrawError(null)
    setWithdrawalRecoveryMessage('Checking the safely reserved withdrawal status…')
    try {
      const timestamp = new Date().toISOString()
      const nonce = crypto.randomUUID()
      const message = buildConfirmMessage({ sellerWallet: address, withdrawalId: id, timestamp, nonce })
      const signature = await signMessageAsync({ message })
      const response = await authorizedFetch('/api/seller/withdraw/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withdrawal_id: id, seller_wallet: address, timestamp, nonce, signature }),
      })
      const body = await response.json().catch(() => ({})) as { status?: string; mint_tx_hash?: string; error?: string }
      if (!isCurrentWallet(wallet)) return
      if (body.status === 'minted') {
        setPendingWithdrawalRecovery(null)
        setWithdrawalRecoveryMessage('Withdrawal confirmed. The reserved balance was completed exactly once.')
        markMarketplaceStale()
        scheduleWalletRefresh({ kind: 'sellerWithdrawal' })
        return
      }
      if (['submission_unknown', 'mint_unknown', 'pending_mint'].includes(body.status ?? '')) {
        setPendingWithdrawalRecovery({ id, status: body.status! })
        setWithdrawalRecoveryMessage('Withdrawal is still being confirmed. Your reserved balance is safely recorded and cannot be withdrawn twice.')
        return
      }
      setPendingWithdrawalRecovery(null)
      throw new Error(body.error ?? 'Withdrawal status could not be confirmed.')
    } catch (error) {
      if (!isCurrentWallet(wallet)) return
      setEarningsWithdrawError(error instanceof Error ? error.message : 'Withdrawal status could not be confirmed.')
    } finally {
      if (isCurrentWallet(wallet)) setEarningsWithdrawStep('idle')
    }
  }

  async function handleEditSave() {
    if (!editingApi || !address) return
    const wallet = address.toLowerCase()
    setApiActionError(null)
    const nextAuthParamName = editForm.auth_type === 'queryparam' ? editForm.auth_param_name : editingApi.auth_param_name
    try {
      const sensitiveChanged = editingApi.endpoint_url !== editForm.endpoint_url
        || editingApi.auth_type !== editForm.auth_type
        || (editingApi.auth_param_name ?? '') !== (editForm.auth_type === 'queryparam' ? editForm.auth_param_name : (editingApi.auth_param_name ?? ''))
        || (editingApi.method ?? 'GET') !== editForm.method
        || editingApi.body_required !== editForm.body_required
        || editingApi.dynamic_path_supported !== editForm.dynamic_path_supported
        || JSON.stringify(editingApi.path_parameters ?? []) !== JSON.stringify(editForm.path_parameters)
        || JSON.stringify(editingApi.query_parameters ?? []) !== JSON.stringify(editForm.query_parameters)
      const res = await (sensitiveChanged ? sensitiveRequest : authorizedFetch)(`/api/apis/${editingApi.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seller_wallet: address,
          name: editForm.name,
          category: editForm.category,
          description: editForm.description,
          endpoint_url: editForm.endpoint_url,
          auth_type: editForm.auth_type,
          ...(editForm.auth_type === 'queryparam' ? { auth_param_name: editForm.auth_param_name } : {}),
          price_per_call: parseFloat(editForm.price_per_call),
          method: editForm.method,
          example_request: editForm.method === 'GET' ? '' : editForm.example_request,
          body_required: editForm.method === 'GET' ? false : editForm.body_required,
          dynamic_path_supported: editForm.dynamic_path_supported,
          path_parameters: editForm.dynamic_path_supported ? editForm.path_parameters : [],
          query_parameters: editForm.query_parameters,
        }),
      })
      if (!isCurrentWallet(wallet)) return
      if (res.ok) {
        setMyApis(prev => prev.map(a => a.id === editingApi.id ? {
          ...a,
          name: editForm.name,
          category: editForm.category,
          description: editForm.description,
          endpoint_url: editForm.endpoint_url,
          auth_type: editForm.auth_type,
          auth_param_name: nextAuthParamName,
          price_per_call: parseFloat(editForm.price_per_call),
          method: editForm.method,
          example_request: editForm.method === 'GET' ? '' : editForm.example_request,
          body_required: editForm.method === 'GET' ? false : editForm.body_required,
          dynamic_path_supported: editForm.dynamic_path_supported,
          path_parameters: editForm.dynamic_path_supported ? editForm.path_parameters : [],
          query_parameters: editForm.query_parameters,
          ...(sensitiveChanged || (a.example_request ?? '') !== (editForm.method === 'GET' ? '' : editForm.example_request)
            ? { is_active: false, verified_at: null } : {}),
        } : a))
        setShowEditModal(false)
        setEditingApi(null)
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string }
        if (!isCurrentWallet(wallet)) return
        setApiActionError(body.error ?? 'Failed to save changes')
      }
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      setApiActionError(err instanceof Error ? err.message : 'Failed to save changes')
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingApiId || deleteConfirmText !== 'DELETE' || !address) return
    const wallet = address.toLowerCase()
    setApiActionError(null)
    try {
      const res = await authorizedFetch(`/api/apis/${deletingApiId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: address }),
      })
      if (!isCurrentWallet(wallet)) return
      if (res.ok) {
        setMyApis(prev => prev.filter(a => a.id !== deletingApiId))
        setDeletingApiId(null)
        setDeleteConfirmText('')
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string }
        if (!isCurrentWallet(wallet)) return
        setApiActionError(body.error ?? 'Failed to delete API')
      }
    } catch (err: unknown) {
      if (!isCurrentWallet(wallet)) return
      setApiActionError(err instanceof Error ? err.message : 'Failed to delete API')
    }
  }

  async function toggleActive(apiId: string, currentStatus: boolean) {
    if (!address) return
    const wallet = address.toLowerCase()
    try {
      if (!currentStatus && !myApis.find(api => api.id === apiId)?.verified_at) {
        const verification = await authorizedFetch(`/api/apis/${apiId}/verify`, { method: 'POST' })
        const result = await verification.json()
        if (!isCurrentWallet(wallet)) return
        if (!verification.ok || !result.success) { setApiActionError(result.error ?? 'Endpoint verification failed'); return }
        if (typeof result.response_size_warning === 'string') setApiActionError(result.response_size_warning)
      }
      const res = await authorizedFetch(`/api/apis/${apiId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: address, is_active: !currentStatus }),
      })
      if (!isCurrentWallet(wallet)) return
      if (res.ok) {
        setMyApis(prev => prev.map(a => a.id === apiId ? { ...a, is_active: !currentStatus } : a))
      }
    } catch {
      if (!isCurrentWallet(wallet)) return
      setApiActionError('Unable to update listing activation')
    }
  }

  async function handleViewApi(apiId: string, apiName: string, method: string) {
    if (!address) return
    const wallet = address.toLowerCase()
    setViewApiModal({ apiId, apiName, method })
    setViewApiResponse(null)
    setViewApiLoading(true)
    try {
      const result = await readPurchasedResponse({ wallet: address, apiId, authorize: authorizedFetch })
      if (result.ok && isCurrentWallet(wallet)) setViewApiResponse(result.data.response_body)
    } finally {
      if (isCurrentWallet(wallet)) setViewApiLoading(false)
    }
  }

  return {
    address,
    isConnected,
    connector,
    publicClient,
    myApis,
    setMyApis,
    calls,
    sellerEarnings,
    loading,
    gatewayStats,
    gatewayUnavailable,
    depositAmount,
    setDepositAmount,
    depositStep,
    depositError,
    setDepositError,
    bridgeBalances,
    solanaPubkey,
    solanaConnected,
    solanaDisconnect,
    setSolanaModalVisible,
    solanaBalance,
    circleBridge,
    withdrawAmount,
    setWithdrawAmount,
    withdrawStep,
    withdrawError,
    withdrawFlatFee,
    initiateStep,
    initiateError,
    releaseStep,
    releaseError,
    earningsWithdrawAmount,
    setEarningsWithdrawAmount,
    earningsWithdrawStep,
    earningsWithdrawError,
    earningsWithdrawResult,
    pendingWithdrawalRecovery,
    withdrawalRecoveryMessage,
    sellCallGroups,
    walletUsdcRaw,
    balanceUpdatedAt,
    withdrawingRaw,
    withdrawalBlockRaw,
    currentBlock,
    callGroups,
    fetchLiveData,
    loadPrivateSnapshot,
    scheduleWalletRefresh,
    handleDeposit,
    handleWithdraw,
    handleInitiateWithdraw,
    handleReleasePending,
    handleWithdrawEarnings,
    handleCheckWithdrawalStatus,
    detailsApi,
    setDetailsApi,
    detailsSellApi,
    setDetailsSellApi,
    editingApi,
    setEditingApi,
    showEditModal,
    setShowEditModal,
    editForm,
    setEditForm,
    deletingApiId,
    setDeletingApiId,
    deleteConfirmText,
    setDeleteConfirmText,
    apiActionError,
    setApiActionError,
    viewApiModal,
    setViewApiModal,
    viewApiResponse,
    viewApiLoading,
    viewApiCopied,
    setViewApiCopied,
    beginEditApi,
    handleEditSave,
    handleDeleteConfirm,
    toggleActive,
    handleViewApi,
  }
}

const DashboardWorkspaceContext = createContext<ReturnType<typeof useDashboardWorkspaceState> | null>(null)

export function DashboardWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount()
  return <ConnectedDashboardWorkspace key={address?.toLowerCase() ?? 'disconnected'}>{children}</ConnectedDashboardWorkspace>
}

function ConnectedDashboardWorkspace({ children }: { children: React.ReactNode }) {
  const workspace = useDashboardWorkspaceState()
  return <DashboardWorkspaceContext.Provider value={workspace}>
    {children}
  </DashboardWorkspaceContext.Provider>
}

export function useDashboardWorkspace() {
  const workspace = useContext(DashboardWorkspaceContext)
  if (!workspace) throw new Error('useDashboardWorkspace must be used within DashboardWorkspaceProvider')
  return workspace
}
