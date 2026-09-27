'use client'

import { useState } from 'react'
import { ARC_MAINNET } from '@/lib/arc'
import { BRIDGE_ACTIVITY_PREFIX, type NotificationPreference, type UsdcDecimals, useProductPreferences } from '@/components/ProductPreferencesProvider'
import { DashboardCardHeader } from '../dashboard-visuals'
import { useDashboardWorkspace } from '../dashboard-workspace'
import styles from '../dashboard.module.css'

const NOTIFICATIONS: Array<{ key: NotificationPreference; label: string; detail: string }> = [
  { key: 'bridgeCompleted', label: 'Bridge completed', detail: 'When a local bridge and deposit finishes.' },
  { key: 'bridgeFailed', label: 'Bridge failed', detail: 'When a local bridge or deposit needs attention.' },
  { key: 'sellerSale', label: 'Seller sale', detail: 'When the scheduled refresh finds new paid calls.' },
  { key: 'withdrawalCompleted', label: 'Withdrawal completed', detail: 'When a withdrawal submitted in this browser completes.' },
]

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className="inline-grid h-11 w-12 shrink-0 place-items-center rounded-full">
      <span aria-hidden="true" className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-[#2775CA]' : 'bg-slate-300'}`}>
        <span className={`absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </span>
    </button>
  )
}

function PreferenceRow({ label, detail, children }: { label: string; detail: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-5 border-b border-slate-100 py-4 last:border-0"><div className="min-w-0"><p className="text-sm font-semibold leading-6 text-slate-900">{label}</p><p className="text-sm leading-6 text-slate-500">{detail}</p></div>{children}</div>
}

export default function SettingsDashboardPage() {
  const { address, isConnected } = useDashboardWorkspace()
  const { preferences, updatePreferences, setNotification } = useProductPreferences()
  const [feedback, setFeedback] = useState<string | null>(null)
  const [notificationFeedback, setNotificationFeedback] = useState<string | null>(null)
  const maskedAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : null

  async function changeNotification(name: NotificationPreference, enabled: boolean) {
    setNotificationFeedback(null)
    if (!enabled) { setNotification(name, false); return }
    if (typeof Notification === 'undefined') {
      setNotificationFeedback('Browser notifications are not available in this browser.')
      return
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') {
      setNotificationFeedback('Allow notifications in your browser settings to enable these alerts.')
      return
    }
    setNotification(name, true)
  }

  function clearBridgeHistory() {
    if (!address) { setFeedback('Connect a wallet to clear its local bridge activity.'); return }
    try {
      localStorage.removeItem(BRIDGE_ACTIVITY_PREFIX + address.toLowerCase())
      setFeedback('Local bridge activity cleared for this wallet. Blockchain and server records were not changed.')
    } catch { setFeedback('Local bridge activity could not be cleared in this browser.') }
  }

  return (
    <div className={styles.content}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>ACCOUNT &amp; PREFERENCES</p>
        <h1>Settings</h1>
        <p>Manage local display, bridge, notification, and privacy preferences for this browser.</p>
      </div>

      <div className={styles.cards}>
        <section className={styles.card}>
          <DashboardCardHeader title="Account" subtitle="Your current Mahshar connection." icon="wallet" tone="blue" />
          <div className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Connection status</p><p className="mt-1 text-sm font-semibold text-slate-900">{isConnected ? 'Connected' : 'Not connected'}</p></div>
            <span className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-hidden="true" />
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Wallet address</p>
            {address ? <><code className="mt-2 block text-sm font-semibold text-slate-900">{maskedAddress}</code><code className="mt-2 block break-all text-xs leading-5 text-slate-500">{address}</code></> : <p className="mt-2 text-sm leading-6 text-slate-600">Connect a wallet to view its address here.</p>}
          </div>
        </section>

        <section className={styles.card}>
          <DashboardCardHeader title="Network" subtitle="Mahshar's USDC-first production environment." icon="balance" tone="blue" />
          <div className="mt-5 space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Production network</p><p className="mt-1 text-sm font-semibold text-slate-900">Arc Mainnet</p></div>
            <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 text-sm"><span className="text-slate-500">Chain ID</span><span className="font-semibold text-slate-900">{ARC_MAINNET.chainId}</span></div>
            <p className="text-sm leading-6 text-slate-600">USDC is the native asset used throughout the Mahshar environment.</p>
          </div>
        </section>

        <section className={styles.card}>
          <DashboardCardHeader title="Display preferences" subtitle="Choose how balances appear on this device." icon="settings" tone="purple" />
          <p className="mt-5 text-sm leading-6 text-slate-600">These preferences are stored locally and apply across the dashboard.</p>
          <PreferenceRow label="USDC decimal display" detail="Show balances with 2, 4, or 6 decimal places.">
            <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1" aria-label="USDC decimal display">
              {([2, 4, 6] as UsdcDecimals[]).map(value => <button key={value} type="button" aria-pressed={preferences.usdcDecimals === value} onClick={() => updatePreferences({ usdcDecimals: value })} className={`min-h-9 rounded-md px-3 text-sm font-semibold ${preferences.usdcDecimals === value ? 'bg-white text-[#2775CA] shadow-sm' : 'text-slate-500'}`}>{value}</button>)}
            </div>
          </PreferenceRow>
          <PreferenceRow label="Show very small balances" detail="Show source-chain balances below 0.01 USDC."><Toggle label="Show very small balances" checked={preferences.showSmallBalances} onChange={showSmallBalances => updatePreferences({ showSmallBalances })} /></PreferenceRow>
        </section>

        <section className={styles.card}>
          <DashboardCardHeader title="Bridge preferences" subtitle="Control local Bridge ordering and balance updates." icon="bridge" tone="green" />
          <p className="mt-5 text-sm leading-6 text-slate-600">Scheduled balance refresh uses one shared 60-second cycle and pauses in hidden tabs. Completed wallet actions may refresh only their affected balances sooner.</p>
          <PreferenceRow label="Funded chains first" detail="Sort source chains with spendable USDC above empty chains."><Toggle label="Funded chains first" checked={preferences.fundedChainsFirst} onChange={fundedChainsFirst => updatePreferences({ fundedChainsFirst })} /></PreferenceRow>
          <PreferenceRow label="Auto-refresh balances" detail="Refresh wallet and Mahshar balances on the 60-second background cycle."><Toggle label="Auto-refresh balances" checked={preferences.autoRefreshBalances} onChange={autoRefreshBalances => updatePreferences({ autoRefreshBalances })} /></PreferenceRow>
        </section>

        <section className={`${styles.card} md:col-span-2`}>
          <DashboardCardHeader title="Notification preferences" subtitle="Optional browser alerts from activity observed on this device." icon="settings" tone="pink" />
          <div className="mt-4 grid gap-x-8 md:grid-cols-2">{NOTIFICATIONS.map(item => <PreferenceRow key={item.key} label={item.label} detail={item.detail}><Toggle label={item.label} checked={preferences.notifications[item.key]} onChange={enabled => { void changeNotification(item.key, enabled) }} /></PreferenceRow>)}</div>
          {notificationFeedback && <p role="status" className="mt-3 text-sm leading-6 text-amber-700">{notificationFeedback}</p>}
        </section>

        <section className={styles.card}>
          <DashboardCardHeader title="Privacy & local data" subtitle="Manage private browser data without changing financial records." icon="wallet" tone="blue" />
          <div className={`${styles.settingsCardBody} mt-5 grid gap-3`}>
            <button type="button" onClick={clearBridgeHistory} className="border border-red-200 bg-red-50 px-4 py-3 text-left text-sm font-semibold text-red-700 hover:bg-red-100">Clear local bridge activity history</button>
            <p className="text-sm leading-6 text-slate-500">Clearing local activity does not delete blockchain transactions, server accounting, or bridge recovery state.</p>
            {feedback && <p role="status" className="text-sm font-medium leading-6 text-slate-700">{feedback}</p>}
          </div>
        </section>

        <section className={styles.card}>
          <DashboardCardHeader title="Support" subtitle="Contact the Mahshar team." icon="settings" tone="green" />
          <div className={`${styles.settingsCardBody} mt-5 rounded-xl border border-slate-200 bg-slate-50 p-5`}>
            <p className="text-sm leading-6 text-slate-600">Need help with your account or the dashboard?</p>
            <a href="mailto:support@mahshar.xyz" className="mt-3 inline-flex rounded-lg bg-[#2775CA] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1e63b5]">support@mahshar.xyz</a>
          </div>
        </section>
      </div>
    </div>
  )
}
