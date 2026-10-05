'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { useDashboardWorkspace } from './dashboard-workspace'
import { DashboardCardHeader, DashboardIcon, UsdcUnit } from './dashboard-visuals'
import { useProductPreferences } from '@/components/ProductPreferencesProvider'
import styles from './dashboard.module.css'

function formatWhen(value: string): string {
  return new Date(value).toLocaleString()
}

export default function DashboardPage() {
  const { formatUsdc } = useProductPreferences()
  const { isConnected, myApis, sellerEarnings, gatewayStats, walletUsdcRaw, walletUsdcStatus, walletUsdcLoading, withdrawingRaw, callGroups, sellCallGroups, solanaConnected, solanaBalance } = useDashboardWorkspace()
  const activeApis = myApis.filter(api => api.is_active)
  const recentBuys = [...callGroups].sort((a, b) => b.lastCalled.localeCompare(a.lastCalled)).slice(0, 3)
  const recentSells = [...sellCallGroups].sort((a, b) => b.lastCalled.localeCompare(a.lastCalled)).slice(0, 3)
  const pendingWithdrawal = withdrawingRaw != null && withdrawingRaw > BigInt(0)
  const reservedEarnings = (sellerEarnings?.in_flight_withdrawals ?? 0) > 0
  const solanaIssue = solanaBalance.error
  const solanaReady = solanaConnected && !solanaBalance.isLoading && !solanaIssue

  return (
    <div className={styles.content}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>YOUR ECONOMY, CONNECTED</p>
        <h1>Dashboard</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">A concise view of your Mahshar wallet, earnings, services, and recent API activity.</p>
      </div>

      {!isConnected ? (
        <section className="flex min-h-[50vh] flex-col items-center justify-center gap-6 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="rounded-2xl bg-blue-50 p-5 text-[#2775CA]"><DashboardIcon name="wallet" /></div>
          <div><h2 className="text-2xl font-bold text-[#0D0D0D]">Connect Your Wallet</h2><p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">Connect to view your Mahshar overview and manage funds through the dedicated workspace routes.</p></div>
          <ConnectButton />
        </section>
      ) : (
        <>
          <div className="mb-8 grid min-w-0 gap-5 lg:grid-cols-4">
            <SummaryCard href="/dashboard/wallet" title="Wallet USDC" subtitle={walletUsdcStatus === 'stale' ? 'Last known Arc balance · refreshing.' : walletUsdcStatus === 'unknown' ? walletUsdcLoading ? 'Checking Arc balance…' : 'Balance temporarily unavailable.' : 'Your USDC held on Arc.'} icon="wallet" tone="blue" value={walletUsdcRaw != null ? formatUsdc(walletUsdcRaw, true) : '—'} detail="Open Wallet" />
            <SummaryCard href="/dashboard/wallet" title="Mahshar Balance" subtitle="Available for paid APIs." icon="balance" tone="pink" value={gatewayStats ? formatUsdc(gatewayStats.gatewayAvailable) : '—'} detail="Open Wallet" />
            <SummaryCard href="/dashboard/earnings" title="Seller Earnings" subtitle="Available seller share." icon="earnings" tone="green" value={sellerEarnings ? formatUsdc(sellerEarnings.withdrawable_balance) : '—'} detail="Open Earnings" />
            <SummaryCard href="/dashboard/apis" title="Active APIs" subtitle="Services currently available." icon="apis" tone="purple" value={String(activeApis.length)} detail="Open APIs" suffix={'of ' + myApis.length} unit={null} />
          </div>

          {(pendingWithdrawal || reservedEarnings || myApis.length === 0 || activeApis.length !== myApis.length || solanaIssue || !solanaReady) && (
            <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-bold text-[#0D0D0D]">Important status</h2>
              <p className="mt-1 text-sm text-slate-500">Items that may need your attention.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {pendingWithdrawal && <Link href="/dashboard/wallet" className="rounded-xl bg-blue-50 p-4 text-sm text-[#2467B5]">Pending trustless withdrawal: {formatUsdc(withdrawingRaw, true)} USDC. Review its release status in Wallet.</Link>}
                {reservedEarnings && <Link href="/dashboard/earnings" className="rounded-xl bg-emerald-50 p-4 text-sm text-[#198254]">{formatUsdc(sellerEarnings?.in_flight_withdrawals ?? 0)} USDC is deducted or reserved by non-expired withdrawal records. Review Earnings for details.</Link>}
                {myApis.length === 0 ? <Link href="/dashboard/apis" className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">You have not listed an API yet. Open APIs to manage your services.</Link> : activeApis.length !== myApis.length ? <Link href="/dashboard/apis" className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Some APIs are inactive. Open APIs to review service status.</Link> : null}
                {solanaIssue ? <Link href="/dashboard/solana" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">Solana source balance information is unavailable. Open Solana to Arc to review the RPC error.</Link> : !solanaReady ? <Link href="/dashboard/solana" className="rounded-xl bg-violet-50 p-4 text-sm text-violet-700">No Solana source wallet is available in this overview. Open Solana to Arc to connect or review it.</Link> : null}
              </div>
            </section>
          )}

          <div className={styles.cards}>
            <ActivityPreview title="Recent buys" description="Your latest paid API activity." href="/dashboard/apis" linkLabel="Open APIs" empty="No recent API purchases." groups={recentBuys} buyer />
            <ActivityPreview title="Recent sells" description="Latest calls to your listed APIs." href="/dashboard/earnings" linkLabel="Open Earnings" empty="No recent calls to your listed APIs." groups={recentSells} />
          </div>

          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><h2>My listed APIs</h2><p>A compact view of your services.</p></div><Link href="/dashboard/apis" className={styles.listLink}>Manage APIs</Link></div>
            {myApis.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No APIs listed yet.</p> : (
              <div className="overflow-x-auto">
                <table className={`${styles.listedApisTable} w-full text-left text-sm`}>
                  <caption className="sr-only">Preview of listed APIs</caption>
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr><th scope="col" className="px-3 py-3">API</th><th scope="col" className="px-3 py-3">Status</th><th scope="col" className="px-3 py-3 text-right">Calls</th><th scope="col" className="px-3 py-3 text-right">Buyer payments</th></tr></thead>
                  <tbody>{myApis.slice(0, 4).map(api => {
                    const earnings = sellerEarnings?.earnings_by_api.find(earning => earning.api_id === api.id)
                    const calls = earnings?.calls
                    const revenue = earnings?.total
                    return <tr key={api.id} className="border-b border-slate-100 last:border-0"><th scope="row" className="font-medium text-slate-900">{api.name}</th><td><span className={api.is_active ? 'rounded-full bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700' : 'rounded-full bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600'}>{api.is_active ? 'Active' : 'Inactive'}</span></td><td className="text-right tabular-nums">{calls ?? '—'}</td><td className="text-right font-mono tabular-nums">{revenue != null ? formatUsdc(revenue) : '—'} USDC</td></tr>
                  })}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function SummaryCard({ href, title, subtitle, icon, tone, value, detail, suffix, unit = 'USDC' }: {
  href: string
  title: string
  subtitle: string
  icon: 'wallet' | 'balance' | 'earnings' | 'apis'
  tone: 'blue' | 'pink' | 'green' | 'purple'
  value: string
  detail: string
  suffix?: string
  unit?: 'USDC' | null
}) {
  return <Link href={href} className={`${styles.card} ${styles.summaryCard}`}><DashboardCardHeader title={title} subtitle={subtitle} icon={icon} tone={tone} /><div className={styles.balanceValue}>{value}{unit === 'USDC' ? <UsdcUnit /> : <span className={styles.countSuffix}>{suffix}</span>}</div><p className="text-xs text-slate-500">{detail}</p></Link>
}

function ActivityPreview({ title, description, href, linkLabel, empty, groups, buyer = false }: {
  title: string
  description: string
  href: string
  linkLabel: string
  empty: string
  buyer?: boolean
  groups: Array<{ apiId?: string; api_id?: string; name?: string; api_name?: string; count: number; successRate: number; lastCalled: string; spent?: number }>
}) {
  const { formatUsdc } = useProductPreferences()
  return (
    <section className={styles.card}>
      <div className={styles.sectionHeading}><div><h2>{title}</h2><p>{description}</p></div><Link href={href} className={styles.listLink}>{linkLabel}</Link></div>
      {groups.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">{empty}</p> : (
        <div className="divide-y divide-slate-100">{groups.map(group => {
          const name = group.name ?? group.api_name ?? 'Unknown'
          const id = group.apiId ?? group.api_id ?? name
          return <div key={id} className="flex items-center justify-between gap-4 py-3 text-sm"><div className="min-w-0"><p className="truncate font-medium text-slate-900">{name}</p><p className="text-xs text-slate-500">{group.count} calls · {group.successRate}% successful</p></div><div className="shrink-0 text-right">{buyer && <p className="font-mono tabular-nums text-slate-900">{formatUsdc(group.spent ?? 0)} USDC</p>}<p className="text-xs text-slate-500">{formatWhen(group.lastCalled)}</p></div></div>
        })}</div>
      )}
    </section>
  )
}
