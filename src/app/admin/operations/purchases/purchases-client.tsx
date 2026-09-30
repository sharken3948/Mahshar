'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { PurchaseDetailDto, PurchaseDto, PurchasesDto } from '@/lib/admin/operations-types'
import { SectionState, StatusBadge, timeLabel, type OperationsPhase } from '../operations-ui'
import styles from '../operations.module.css'

export function PurchasesClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<PurchasesDto | null>(null)
  const [phase, setPhase] = useState<OperationsPhase>('loading')
  const [limit, setLimit] = useState(25)
  const [selected, setSelected] = useState<PurchaseDto | null>(null)
  const [detail, setDetail] = useState<PurchaseDetailDto | null>(null)
  const [detailPhase, setDetailPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const sequence = useRef(0)

  const load = useCallback(async () => {
    const current = ++sequence.current
    setPhase(previous => data && previous !== 'unavailable' ? 'degraded' : 'loading')
    try {
      const response = await request(`/api/admin/operations/purchases?limit=${limit}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('purchases unavailable')
      const value = await response.json() as PurchasesDto
      if (current !== sequence.current) return
      setData(value); setPhase(value.purchases.length ? 'ready' : 'empty')
    } catch { if (current === sequence.current) setPhase(data ? 'degraded' : 'unavailable') }
  }, [data, limit, request])
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { void loadRef.current() }, [limit])

  const openDetail = async (purchase: PurchaseDto) => {
    setSelected(purchase); setDetail(null); setDetailPhase('loading')
    try {
      const response = await request(`/api/admin/operations/purchases/${encodeURIComponent(purchase.id)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('detail unavailable')
      setDetail(await response.json() as PurchaseDetailDto); setDetailPhase('ready')
    } catch { setDetailPhase('unavailable') }
  }

  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>Accounting records</span><h1>Purchases</h1><p>Recent purchases and their durable settlement linkage. Missing historical fields are never reconstructed.</p></div>
      <button className={styles.primaryButton} type="button" onClick={load} disabled={phase === 'loading'}><span aria-hidden="true">↻</span>Manual refresh</button>
    </section>
    <section className={`${styles.filterPanel} ${styles.rowsFilter}`}><label className={styles.filterField}><span>Recent rows</span><select value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option></select></label><p>API-call metadata loads only when a purchase is opened.</p></section>
    <section className={`${styles.panel} ${styles.operationsTablePanel}`}>
      <header className={styles.panelHeader}><div><span>Bounded recent read</span><h2>Purchase records</h2></div><div className={styles.resultSummary}>{phase === 'degraded' && <em>Refresh failed · showing prior result</em>}<strong>{data ? `${data.purchases.length} shown` : '—'}</strong></div></header>
      <SectionState phase={phase} empty="No purchase records are available." onRetry={load}/>
      {data && data.purchases.length > 0 && <div className={styles.tableViewport}><table className={`${styles.table} ${styles.operationsTable}`}>
        <thead><tr><th>Listing</th><th>Buyer / seller</th><th>Amounts</th><th>Settlement</th><th>Delivery</th><th>Timestamp</th><th>Detail</th></tr></thead>
        <tbody>{data.purchases.map(row => <tr key={row.id}>
          <td data-label="Listing"><strong>{row.listing?.name ?? 'Unavailable'}</strong><small>{row.listing?.id ?? 'No listing link'}</small><code>{row.id}</code></td>
          <td data-label="Buyer / seller"><code>{row.buyer}</code><small>Seller {row.seller}</small></td>
          <td data-label="Amounts"><strong>{row.buyer_amount_usdc ? `${row.buyer_amount_usdc} USDC` : 'Unavailable'}</strong><small>Seller share {row.seller_share_usdc ? `${row.seller_share_usdc} USDC` : 'Historical / unlinked'}</small></td>
          <td data-label="Settlement">{row.historical_unlinked ? <StatusBadge value="HISTORICAL_UNLINKED"/> : row.settlement_state ? <StatusBadge value={row.settlement_state}/> : <span className={styles.muted}>Link unavailable</span>}<small>{row.settlement_attempt_id ?? 'Historical / unlinked'}</small></td>
          <td data-label="Delivery">{row.delivery_state ? <StatusBadge value={row.delivery_state}/> : <span className={styles.muted}>Historical / unlinked</span>}{row.delivery_http_status && <small>HTTP {row.delivery_http_status}</small>}</td>
          <td data-label="Timestamp"><span>{timeLabel(row.created_at)}</span></td>
          <td data-label="Detail"><button className={styles.rowButton} type="button" onClick={() => void openDetail(row)}>View safe detail</button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    {selected && (
      <PurchaseDetail selected={selected} detail={detail} phase={detailPhase} onClose={() => { setSelected(null); setDetail(null) }}/>
    )}
  </div>
}

function PurchaseDetail({ selected, detail, phase, onClose }: { selected: PurchaseDto; detail: PurchaseDetailDto | null; phase: 'loading' | 'ready' | 'unavailable'; onClose: () => void }) {
  return <div className={styles.detailBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className={styles.detailSheet} role="dialog" aria-modal="true" aria-labelledby="purchase-detail-title">
      <header><div><span>Read-only detail</span><h2 id="purchase-detail-title">Purchase</h2></div><button type="button" onClick={onClose} aria-label="Close purchase detail">×</button></header>
      <div className={styles.detailBody}>
        <dl className={styles.detailList}><div><dt>Purchase ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Listing</dt><dd>{selected.listing?.name ?? 'Unavailable'}</dd></div><div><dt>Settlement attempt</dt><dd><code>{selected.settlement_attempt_id ?? 'Historical / unlinked'}</code></dd></div><div><dt>Settlement</dt><dd>{selected.settlement_state ? <StatusBadge value={selected.settlement_state}/> : 'Historical / unlinked'}</dd></div><div><dt>Delivery</dt><dd>{selected.delivery_state ? <StatusBadge value={selected.delivery_state}/> : 'Historical / unlinked'}</dd></div><div><dt>Timestamp</dt><dd>{timeLabel(selected.created_at)}</dd></div></dl>
        <div className={styles.detailCalls}><h3>Safe API-call metadata</h3>{phase === 'loading' && <p>Loading this purchase only…</p>}{phase === 'unavailable' && <p>Detail is unavailable. Core delivery is unaffected.</p>}{phase === 'ready' && detail?.api_calls.length === 0 && <p>No linked API-call metadata.</p>}{detail?.api_calls.map(call => <article key={call.id}><div><StatusBadge value={call.success ? 'SUCCEEDED' : 'FAILED'}/><span>{call.latency_ms === null ? 'Latency unavailable' : `${call.latency_ms} ms`}</span></div><code>{call.id}</code><small>{timeLabel(call.created_at)}{call.payment_type ? ` · ${call.payment_type}` : ''}</small></article>)}</div>
      </div>
    </section>
  </div>
}
