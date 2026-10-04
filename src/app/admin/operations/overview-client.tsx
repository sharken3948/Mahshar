'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { ListingCountsDto, OperationsSnapshotDto, RecentPaymentsDto, TreasuryBalanceDto } from '@/lib/admin/operations-types'
import { formatState, SectionState, StatusBadge, timeLabel, type OperationsPhase } from './operations-ui'
import { TreasuryCard } from './treasury-card'
import styles from './operations.module.css'

type Phase = OperationsPhase
type Resource<T> = { phase: Phase; data: T | null }
type ResourceKey = 'counts' | 'snapshot' | 'payments' | 'treasury'

const refreshAfter = { counts: 300_000, snapshot: 60_000, payments: 60_000, treasury: 60_000 } as const

function createRequestPool(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  const drain = () => {
    while (active < limit && queue.length) {
      active += 1
      queue.shift()?.()
    }
  }
  return {
    run<T>(task: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => { task().then(resolve, reject).finally(() => { active -= 1; drain() }) })
        drain()
      })
    },
  }
}

function MetricCard({ label, value, tone, resource }: { label: string; value: number | null; tone: 'blue' | 'green' | 'purple' | 'slate'; resource: Resource<ListingCountsDto> }) {
  const unavailable = resource.phase === 'unavailable'
  return <article className={`${styles.metricCard} ${styles[`tone${tone[0].toUpperCase()}${tone.slice(1)}`]}`}>
    <div className={styles.metricHead}><span>{label}</span><i/></div>
    {resource.phase === 'loading' ? <span className={styles.metricSkeleton}/> : unavailable ? <strong className={styles.metricUnavailable}>Unavailable</strong> : <strong>{value?.toLocaleString() ?? '—'}</strong>}
    <small>{resource.phase === 'degraded' ? 'Refresh failed · showing last result' : 'Production listing inventory'}</small>
  </article>
}

export function OverviewClient() {
  const request = useAdminRequest()
  const pool = useMemo(() => createRequestPool(2), [])
  const mounted = useRef(true)
  const initialized = useRef(false)
  const lastAttempt = useRef<Record<ResourceKey, number>>({ counts: 0, snapshot: 0, payments: 0, treasury: 0 })
  const [counts, setCounts] = useState<Resource<ListingCountsDto>>({ phase: 'loading', data: null })
  const [snapshot, setSnapshot] = useState<Resource<OperationsSnapshotDto>>({ phase: 'loading', data: null })
  const [payments, setPayments] = useState<Resource<RecentPaymentsDto>>({ phase: 'loading', data: null })
  const [treasury, setTreasury] = useState<Resource<TreasuryBalanceDto>>({ phase: 'loading', data: null })

  // React development Strict Mode runs effect setup, cleanup, then setup again.
  // Re-arm the mounted flag on every setup so a completed Admin read can leave
  // its loading state after that development-only lifecycle check.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async <T,>(key: ResourceKey, url: string, setResource: React.Dispatch<React.SetStateAction<Resource<T>>>, isEmpty: (value: T) => boolean) => {
    lastAttempt.current[key] = Date.now()
    setResource(current => ({ phase: current.data ? 'degraded' : 'loading', data: current.data }))
    try {
      const response = await pool.run(() => request(url, { cache: 'no-store' }))
      if (!response.ok) throw new Error('operations read unavailable')
      const data = await response.json() as T
      if (mounted.current) setResource({ phase: isEmpty(data) ? 'empty' : 'ready', data })
    } catch {
      if (mounted.current) setResource(current => ({ phase: current.data ? 'degraded' : 'unavailable', data: current.data }))
    }
  }, [pool, request])

  const refreshCounts = useCallback(() => load('counts', '/api/admin/operations/counts', setCounts, () => false), [load])
  const refreshSnapshot = useCallback(() => load('snapshot', '/api/admin/operations/snapshot', setSnapshot, value => value.total === 0), [load])
  const refreshPayments = useCallback(() => load('payments', '/api/admin/operations/recent-payments', setPayments, value => value.payments.length === 0), [load])
  const refreshTreasury = useCallback(() => load('treasury', '/api/admin/operations/treasury', setTreasury, () => false), [load])

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      void refreshCounts(); void refreshSnapshot(); void refreshPayments(); void refreshTreasury()
    }
    const refreshIfVisible = (key: ResourceKey, refresh: () => Promise<void>) => {
      if (document.visibilityState === 'visible' && Date.now() - lastAttempt.current[key] >= refreshAfter[key]) void refresh()
    }
    const countsTimer = window.setInterval(() => refreshIfVisible('counts', refreshCounts), refreshAfter.counts)
    const snapshotTimer = window.setInterval(() => refreshIfVisible('snapshot', refreshSnapshot), refreshAfter.snapshot)
    const paymentsTimer = window.setInterval(() => refreshIfVisible('payments', refreshPayments), refreshAfter.payments)
    const treasuryTimer = window.setInterval(() => refreshIfVisible('treasury', refreshTreasury), refreshAfter.treasury)
    const visibility = () => {
      if (document.visibilityState !== 'visible') return
      refreshIfVisible('counts', refreshCounts); refreshIfVisible('snapshot', refreshSnapshot); refreshIfVisible('payments', refreshPayments); refreshIfVisible('treasury', refreshTreasury)
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.clearInterval(countsTimer); window.clearInterval(snapshotTimer); window.clearInterval(paymentsTimer); window.clearInterval(treasuryTimer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [refreshCounts, refreshPayments, refreshSnapshot, refreshTreasury])

  const settlementMax = Math.max(1, ...(snapshot.data?.settlement.map(item => item.count) ?? []))
  const deliveryMax = Math.max(1, ...(snapshot.data?.delivery.map(item => item.count) ?? []))
  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>Mainnet operations</span><h1>Overview</h1><p>A read-only view of listing inventory and durable payment state.</p></div>
      <div className={styles.headingStatus}><span/><div><strong>Observing production</strong><small>Admin failures are isolated</small></div></div>
    </section>

    <TreasuryCard resource={treasury} onRetry={refreshTreasury}/>

    <section className={styles.metrics} aria-label="Listing counts">
      <MetricCard label="Total API Listings" value={counts.data?.total ?? null} tone="blue" resource={counts}/>
      <MetricCard label="Active APIs" value={counts.data?.active ?? null} tone="green" resource={counts}/>
      <MetricCard label="Inactive APIs" value={counts.data?.inactive ?? null} tone="slate" resource={counts}/>
      <MetricCard label="Verified APIs" value={counts.data?.verified ?? null} tone="purple" resource={counts}/>
    </section>

    <section className={styles.twoColumn}>
      <article className={styles.panel}>
        <header className={styles.panelHeader}><div><span>Durable state</span><h2>Settlement snapshot</h2></div>{snapshot.phase === 'degraded' && <em>Stale</em>}</header>
        <SectionState phase={snapshot.phase} empty="No durable settlement attempts exist." onRetry={refreshSnapshot}/>
        {snapshot.data && <div className={styles.distribution}>
          {snapshot.data.settlement.map(item => <div className={styles.distributionRow} key={item.state}>
            <div><span>{formatState(item.state)}</span><strong>{item.count}</strong></div><i><b style={{ width: `${Math.max(4, item.count / settlementMax * 100)}%` }}/></i>
          </div>)}
        </div>}
      </article>
      <article className={styles.panel}>
        <header className={styles.panelHeader}><div><span>Upstream delivery</span><h2>Delivery snapshot</h2></div>{snapshot.phase === 'degraded' && <em>Stale</em>}</header>
        <SectionState phase={snapshot.phase} empty="No delivery state has been recorded." onRetry={refreshSnapshot}/>
        {snapshot.data && <div className={`${styles.distribution} ${styles.deliveryDistribution}`}>
          {snapshot.data.delivery.map(item => <div className={styles.distributionRow} key={item.state}>
            <div><span>{formatState(item.state)}</span><strong>{item.count}</strong></div><i><b style={{ width: `${Math.max(4, item.count / deliveryMax * 100)}%` }}/></i>
          </div>)}
        </div>}
      </article>
    </section>

    <section className={`${styles.panel} ${styles.paymentsPanel}`}>
      <header className={styles.panelHeader}><div><span>Bounded to 25 rows</span><h2>Recent payments</h2></div><button type="button" onClick={refreshPayments} disabled={payments.phase === 'loading'}>Refresh</button></header>
      <SectionState phase={payments.phase} empty="No settlement attempts are available." onRetry={refreshPayments}/>
      {payments.data && payments.data.payments.length > 0 && <div className={styles.tableViewport}>
        <table className={styles.table}>
          <thead><tr><th>Listing</th><th>Settlement</th><th>Delivery</th><th>Updated</th><th>Diagnostic IDs</th></tr></thead>
          <tbody>{payments.data.payments.map(payment => <tr key={payment.id}>
            <td data-label="Listing"><strong>{payment.listing?.name ?? 'Unavailable'}</strong><small>{payment.listing?.id ?? 'No listing link'}</small></td>
            <td data-label="Settlement"><StatusBadge value={payment.settlement_state}/>{payment.reason_code && <small>{formatState(payment.reason_code)}</small>}</td>
            <td data-label="Delivery"><StatusBadge value={payment.delivery_state}/>{payment.delivery_http_status && <small>HTTP {payment.delivery_http_status}</small>}</td>
            <td data-label="Updated"><span>{timeLabel(payment.updated_at)}</span><small>Created {timeLabel(payment.created_at)}</small></td>
            <td data-label="Diagnostic IDs"><code title={payment.id}>Attempt {payment.id}</code>{payment.purchase_id && <small title={payment.purchase_id}>Purchase {payment.purchase_id}</small>}{payment.evidence_id && <small title={payment.evidence_id}>Evidence {payment.evidence_id}</small>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  </div>
}
