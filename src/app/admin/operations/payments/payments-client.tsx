'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { RecentPaymentsDto } from '@/lib/admin/operations-types'
import { formatState, SectionState, StatusBadge, timeLabel, type OperationsPhase } from '../operations-ui'
import styles from '../operations.module.css'

function isProblematic(settlement: string, delivery: string) {
  return ['SETTLEMENT_UNKNOWN', 'MANUAL_REVIEW', 'SETTLEMENT_SUBMITTED'].includes(settlement) ||
    ['UNKNOWN', 'FAILED_RETRYABLE', 'FAILED_FINAL'].includes(delivery)
}

export function PaymentsClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<RecentPaymentsDto | null>(null)
  const [phase, setPhase] = useState<OperationsPhase>('loading')
  const [limit, setLimit] = useState(25)
  const [problematic, setProblematic] = useState(false)
  const [settlement, setSettlement] = useState('all')
  const [delivery, setDelivery] = useState('all')
  const sequence = useRef(0)

  const load = useCallback(async () => {
    const current = ++sequence.current
    setPhase(previous => data && previous !== 'unavailable' ? 'degraded' : 'loading')
    try {
      const response = await request(`/api/admin/operations/payments?limit=${limit}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('payments unavailable')
      const value = await response.json() as RecentPaymentsDto
      if (current !== sequence.current) return
      setData(value); setPhase(value.payments.length ? 'ready' : 'empty')
    } catch {
      if (current === sequence.current) setPhase(data ? 'degraded' : 'unavailable')
    }
  }, [data, limit, request])
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { void loadRef.current() }, [limit])

  const rows = useMemo(() => (data?.payments ?? []).filter(row => {
    if (problematic && !isProblematic(row.settlement_state, row.delivery_state)) return false
    if (settlement !== 'all' && row.settlement_state !== settlement) return false
    if (delivery !== 'all' && row.delivery_state !== delivery) return false
    return true
  }), [data, delivery, problematic, settlement])

  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>Durable payment state</span><h1>Payments</h1><p>Recent settlement and delivery attempts, sanitized before they reach the browser.</p></div>
      <button className={styles.primaryButton} type="button" onClick={load} disabled={phase === 'loading'}><span aria-hidden="true">↻</span>Manual refresh</button>
    </section>
    <section className={`${styles.filterPanel} ${styles.compactFilters}`} aria-label="Payment filters">
      <label className={styles.checkField}><input type="checkbox" checked={problematic} onChange={event => setProblematic(event.target.checked)}/><span>Problematic only</span></label>
      <Filter label="Settlement state" value={settlement} onChange={setSettlement} options={['all','ACCOUNTING_COMPLETE','SETTLEMENT_CONFIRMED','SETTLEMENT_UNKNOWN','SETTLEMENT_SUBMITTED','MANUAL_REVIEW','PREPARED']}/>
      <Filter label="Delivery state" value={delivery} onChange={setDelivery} options={['all','SUCCEEDED','NOT_STARTED','FAILED_RETRYABLE','FAILED_FINAL','UNKNOWN','IN_PROGRESS']}/>
      <label className={styles.filterField}><span>Recent rows</span><select value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option></select></label>
    </section>
    <section className={`${styles.panel} ${styles.operationsTablePanel}`}>
      <header className={styles.panelHeader}><div><span>Bounded recent read</span><h2>Settlement attempts</h2></div><div className={styles.resultSummary}>{phase === 'degraded' && <em>Refresh failed · showing prior result</em>}<strong>{data ? `${rows.length} of ${data.payments.length}` : '—'}</strong></div></header>
      <SectionState phase={phase} empty="No settlement attempts are available." onRetry={load}/>
      {data && data.payments.length > 0 && rows.length === 0 && <div className={styles.sectionMessage}><strong>No matching attempts</strong><span>Filters apply only to this bounded recent window.</span></div>}
      {rows.length > 0 && <div className={styles.tableViewport}><table className={`${styles.table} ${styles.operationsTable}`}>
        <thead><tr><th>Listing</th><th>Settlement</th><th>Delivery</th><th>Financials</th><th>Parties</th><th>Updated</th><th>Diagnostic IDs</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td data-label="Listing"><strong>{row.listing?.name ?? 'Unavailable'}</strong><small>{row.listing?.id ?? 'No listing link'}</small></td>
          <td data-label="Settlement"><StatusBadge value={row.settlement_state}/><small>{formatState(row.accounting_state)}</small></td>
          <td data-label="Delivery"><StatusBadge value={row.delivery_state}/>{row.delivery_http_status && <small>HTTP {row.delivery_http_status}</small>}{row.delivery_error_code && <small>{formatState(row.delivery_error_code)}</small>}</td>
          <td data-label="Financials"><strong>{row.buyer_charge_usdc ? `${row.buyer_charge_usdc} USDC` : 'Unavailable'}</strong><small>Seller {row.seller_share_usdc ? `${row.seller_share_usdc} USDC` : 'Unavailable'}</small></td>
          <td data-label="Parties"><code>{row.payer}</code><small>Seller {row.seller}</small></td>
          <td data-label="Updated"><span>{timeLabel(row.updated_at)}</span><small>Created {timeLabel(row.created_at)}</small></td>
          <td data-label="Diagnostic IDs"><code title={row.id}>Attempt {row.id}</code><small title={row.purchase_id ?? undefined}>Purchase {row.purchase_id ?? 'Not linked'}</small><small title={row.evidence_id ?? undefined}>Evidence {row.evidence_id ?? 'Unavailable'}</small></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return <label className={styles.filterField}><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option} value={option}>{option === 'all' ? 'All' : formatState(option)}</option>)}</select></label>
}
