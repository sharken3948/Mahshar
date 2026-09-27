'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useRef, useState } from 'react'
import { MIN_WITHDRAW_USDC, useDashboardWorkspace } from '../dashboard-workspace'
import { DashboardCardHeader, DashboardIcon } from '../dashboard-visuals'
import { useProductPreferences } from '@/components/ProductPreferencesProvider'
import { useWalletAuthorization } from '@/hooks/useWalletAuthorization'
import { arcMainnet } from '@/lib/chains'
import styles from '../dashboard.module.css'

const RECENT_WITHDRAWAL_LIMIT = 6

type WithdrawalStatus = 'pending_mint' | 'minted' | 'expired' | 'failed'

interface WithdrawalRecord {
  id: string
  amount_usdc: string | number
  net_amount_usdc: string | number
  gas_cost_usdc: string | number
  status: WithdrawalStatus
  mint_tx_hash: string | null
  created_at: string
  minted_at: string | null
}

export default function EarningsDashboardPage() {
  const { formatUsdc } = useProductPreferences()
  const { request: authorizedFetch } = useWalletAuthorization()
  const {
    address, isConnected, sellerEarnings, myApis, sellCallGroups,
    earningsWithdrawAmount, setEarningsWithdrawAmount, earningsWithdrawStep,
    earningsWithdrawError, earningsWithdrawResult, handleWithdrawEarnings,
  } = useDashboardWorkspace()
  const currentAddress = useRef(address)
  currentAddress.current = address
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[] | null>(null)
  const [withdrawalHistoryWallet, setWithdrawalHistoryWallet] = useState<string | null>(null)
  const [withdrawalHistoryState, setWithdrawalHistoryState] = useState<'idle' | 'loading' | 'loaded'>('idle')
  const [withdrawalHistoryError, setWithdrawalHistoryError] = useState<string | null>(null)
  const [showAllWithdrawals, setShowAllWithdrawals] = useState(false)

  useEffect(() => {
    setWithdrawals(null)
    setWithdrawalHistoryWallet(null)
    setWithdrawalHistoryState('idle')
    setWithdrawalHistoryError(null)
    setShowAllWithdrawals(false)
  }, [address])

  async function loadWithdrawalHistory() {
    if (!address || withdrawalHistoryState === 'loading') return
    const requestedWallet = address.toLowerCase()
    setWithdrawalHistoryState('loading')
    setWithdrawalHistoryError(null)
    try {
      const response = await authorizedFetch(`/api/seller/earnings?seller_wallet=${encodeURIComponent(requestedWallet)}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => ({})) as { withdrawals?: WithdrawalRecord[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Withdrawal history is unavailable.')
      if (currentAddress.current?.toLowerCase() !== requestedWallet) return
      setWithdrawals(Array.isArray(payload.withdrawals) ? payload.withdrawals : [])
      setWithdrawalHistoryWallet(requestedWallet)
      setWithdrawalHistoryState('loaded')
    } catch (error) {
      if (currentAddress.current?.toLowerCase() !== requestedWallet) return
      setWithdrawals(null)
      setWithdrawalHistoryWallet(null)
      setWithdrawalHistoryState('idle')
      setWithdrawalHistoryError(error instanceof Error ? error.message : 'Withdrawal history is unavailable.')
    }
  }

  return (
    <div className={styles.content}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>BUILD. EARN. GROW.</p>
        <h1>Earnings</h1>
        <p className="mt-2 text-sm text-slate-500">Review your API revenue and withdraw your available seller earnings.</p>
      </div>

      {!isConnected ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-6">
          <div className="rounded-2xl bg-emerald-50 p-5 text-[#198254]"><DashboardIcon name="earnings" /></div>
          <h2 className="text-2xl font-bold">Connect Your Wallet</h2>
          <p className="text-center text-sm text-slate-500">Connect your seller wallet to view earnings and withdraw USDC.</p>
          <ConnectButton />
        </div>
      ) : (
        <>
          <div className="mb-8 grid min-w-0 gap-5 lg:grid-cols-3">
            <section className={styles.card}>
              <p className="text-sm font-semibold text-[#198254]">Withdrawable Earnings</p>
              <div className="break-words font-mono font-bold tabular-nums">{sellerEarnings ? formatUsdc(sellerEarnings.withdrawable_balance) : '—'} <span className="text-sm font-normal text-slate-500">USDC</span></div>
              <p className="text-xs text-slate-500">Seller share available for withdrawal.</p>
            </section>
            <section className={styles.card}>
              <p className="text-sm font-semibold text-[#198254]">Lifetime Earned</p>
              <div className="break-words font-mono font-bold tabular-nums">{sellerEarnings ? formatUsdc(sellerEarnings.total_earnings) : '—'} <span className="text-sm font-normal text-slate-500">USDC</span></div>
              <p className="text-xs text-slate-500">All-time gross purchase revenue, before the platform share.</p>
            </section>
            <section className={styles.card}>
              <p className="text-sm font-semibold text-slate-600">Reserved by Withdrawals</p>
              <div className="break-words font-mono font-bold tabular-nums">{sellerEarnings ? formatUsdc(sellerEarnings.in_flight_withdrawals) : '—'} <span className="text-sm font-normal text-slate-500">USDC</span></div>
              <p className="text-xs text-slate-500">Includes pending_mint, minted, and failed withdrawals deducted from available earnings.</p>
            </section>
          </div>

          <div className={styles.cards}>
            <section className={styles.card}>
              <DashboardCardHeader title="Withdraw earnings" subtitle="Send your available earnings to your wallet." icon="earnings" tone="green" />
            <p className="text-xs text-[#6B7280] mb-3">
              Withdrawable balance: <span className="font-medium text-[#00B050]">{sellerEarnings ? `${formatUsdc(sellerEarnings.withdrawable_balance)} USDC` : 'Unavailable'}</span>.
              The platform mints on Arc and deducts the estimated gas cost from your payout. Your wallet will prompt for a signature to authorize the withdrawal. Minimum withdrawal: ${MIN_WITHDRAW_USDC.toFixed(2)}.
            </p>
            <div className="flex gap-2 items-center">
              <input
                type="number"
                value={earningsWithdrawAmount}
                aria-label="Seller earnings withdrawal amount in USDC"
                onChange={e => setEarningsWithdrawAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.0001"
                disabled={!sellerEarnings || earningsWithdrawStep !== 'idle'}
                className="w-full flex-1 bg-[#FAFAF8] border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA] disabled:opacity-50"
              />
              <span className="text-sm text-[#6B7280]">USDC</span>
              <button
                onClick={() => { void handleWithdrawEarnings() }}
                disabled={!sellerEarnings || earningsWithdrawStep !== 'idle' || !earningsWithdrawAmount}
                className="bg-[#00B050] hover:bg-[#008F42] text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {earningsWithdrawStep === 'idle' ? 'Withdraw Earnings' : 'Withdrawing...'}
              </button>
            </div>
            {sellerEarnings && sellerEarnings.in_flight_withdrawals > 0 && (
              <p className="text-xs text-[#6B7280] mt-2">
                Reserved by withdrawals: ${formatUsdc(sellerEarnings.in_flight_withdrawals)} USDC
              </p>
            )}
            {earningsWithdrawResult && (
              <p className="text-xs text-[#16A34A] mt-2">
                Sent {formatUsdc(earningsWithdrawResult.net)} USDC to your wallet (gas: ${formatUsdc(earningsWithdrawResult.gas)}). Tx {earningsWithdrawResult.tx.slice(0, 10)}…
              </p>
            )}
            {earningsWithdrawError && <p className="text-xs text-[#DC2626] mt-2">{earningsWithdrawError}</p>}
            <WithdrawalHistory
              withdrawals={withdrawalHistoryWallet === address?.toLowerCase() ? withdrawals : null}
              loading={withdrawalHistoryState === 'loading'}
              error={withdrawalHistoryError}
              showAll={showAllWithdrawals}
              setShowAll={setShowAllWithdrawals}
              onLoad={() => { void loadWithdrawalHistory() }}
              formatUsdc={formatUsdc}
            />
            </section>
            <section className={styles.card}>
              <DashboardCardHeader title="Earnings by API" subtitle="Revenue from purchases of your services." icon="apis" tone="green" />
              <p className="mb-4 text-xs text-slate-500">All amounts are in USDC. Revenue is the gross purchase total. Calls counts purchases; success rate reflects the existing seller call records. Price/call is the current listing price.</p>
              {!sellerEarnings ? (
                <p className="text-sm text-slate-500">Earnings data is not available yet.</p>
              ) : sellerEarnings.earnings_by_api.length === 0 ? (
                <p className="text-sm text-slate-500">No API purchase earnings to display yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Earnings by API, in USDC</caption>
                    <thead className="border-b border-slate-200 text-xs text-slate-500">
                      <tr>
                        <th scope="col" className="px-3 py-3">API</th>
                        <th scope="col" className="px-3 py-3 text-right">Calls</th>
                        <th scope="col" className="px-3 py-3 text-right">Current price/call</th>
                        <th scope="col" className="px-3 py-3 text-right">Gross revenue</th>
                        <th scope="col" className="px-3 py-3 text-right">Success rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellerEarnings.earnings_by_api.map(earning => {
                        const listing = myApis.find(api => api.id === earning.api_id)
                        const callGroup = sellCallGroups.find(group => group.api_id === earning.api_id)
                        return (
                          <tr key={earning.api_id} className="border-b border-slate-100 last:border-0">
                            <th scope="row" className="break-words px-3 py-4 font-medium">{earning.api_name}</th>
                            <td className="px-3 py-4 text-right tabular-nums">{earning.calls}</td>
                            <td className="whitespace-nowrap px-3 py-4 text-right font-mono tabular-nums">{listing ? listing.price_per_call : '—'}</td>
                            <td className="whitespace-nowrap px-3 py-4 text-right font-mono tabular-nums text-[#198254]">{formatUsdc(earning.total)}</td>
                            <td className="px-3 py-4 text-right tabular-nums">{callGroup ? `${callGroup.successRate}%` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function WithdrawalHistory({ withdrawals, loading, error, showAll, setShowAll, onLoad, formatUsdc }: {
  withdrawals: WithdrawalRecord[] | null
  loading: boolean
  error: string | null
  showAll: boolean
  setShowAll: (value: boolean) => void
  onLoad: () => void
  formatUsdc: (value: string | number | bigint, atomic?: boolean) => string
}) {
  const visibleWithdrawals = showAll ? withdrawals ?? [] : (withdrawals ?? []).slice(0, RECENT_WITHDRAWAL_LIMIT)
  const hasMore = (withdrawals?.length ?? 0) > RECENT_WITHDRAWAL_LIMIT

  return (
    <div className={styles.withdrawalHistory}>
      <div className={styles.withdrawalHistoryHeader}>
        <div><h3>Withdrawal History</h3><p>Recent seller withdrawals from this wallet.</p></div>
        <div className={styles.withdrawalHistoryActions}>
          {withdrawals !== null && <button type="button" onClick={onLoad} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>}
          {hasMore && <button type="button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show recent' : 'View all withdrawals'}</button>}
        </div>
      </div>

      {withdrawals === null ? (
        <div className={styles.withdrawalHistoryEmpty}>
          <p>{error ?? 'Confirm with your connected wallet to view private withdrawal history.'}</p>
          <button type="button" onClick={onLoad} disabled={loading}>{loading ? 'Waiting for wallet…' : error ? 'Try again' : 'View withdrawal history'}</button>
        </div>
      ) : withdrawals.length === 0 ? (
        <p className={styles.withdrawalHistoryEmpty}>No withdrawals yet</p>
      ) : (
        <ul className={styles.withdrawalHistoryList}>
          {visibleWithdrawals.map(withdrawal => {
            const status = withdrawalStatus(withdrawal.status)
            const hash = withdrawal.mint_tx_hash
            return (
              <li key={withdrawal.id} className={styles.withdrawalHistoryRow}>
                <time dateTime={withdrawal.created_at}>{formatWithdrawalDate(withdrawal.created_at)}</time>
                <div className={styles.withdrawalAmounts}>
                  <span><small>Requested</small><strong>{formatUsdc(withdrawal.amount_usdc)} USDC</strong></span>
                  <span><small>Gas</small><strong>{formatUsdc(withdrawal.gas_cost_usdc)} USDC</strong></span>
                  <span><small>Received</small><strong>{formatUsdc(withdrawal.net_amount_usdc)} USDC</strong></span>
                </div>
                <span className={`${styles.withdrawalStatus} ${styles[status.className]}`}>{status.label}</span>
                <div className={styles.withdrawalTransaction}>
                  {hash ? <><code title={hash}>{shortTransactionHash(hash)}</code><a href={`${arcMainnet.blockExplorers.default.url}/tx/${encodeURIComponent(hash)}`} target="_blank" rel="noopener noreferrer">View on Explorer</a></> : <span aria-label="No transaction hash">—</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function withdrawalStatus(status: WithdrawalStatus) {
  if (status === 'minted') return { label: 'Completed', className: 'withdrawalStatusCompleted' as const }
  if (status === 'pending_mint') return { label: 'Pending', className: 'withdrawalStatusPending' as const }
  return { label: 'Failed', className: 'withdrawalStatusFailed' as const }
}

function shortTransactionHash(hash: string) {
  return hash.length > 10 ? `${hash.slice(0, 6)}...${hash.slice(-4)}` : hash
}

function formatWithdrawalDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
