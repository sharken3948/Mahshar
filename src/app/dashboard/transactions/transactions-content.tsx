'use client'

import Link from 'next/link'
import type { TransactionFilter, TransactionHistory, TransactionRecord } from '@/lib/dashboard-transactions'
import dashboardStyles from '../dashboard.module.css'
import styles from './transactions.module.css'

const FILTERS: Array<{ value: TransactionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'earnings', label: 'Earnings' },
  { value: 'withdrawals', label: 'Withdrawals' },
]

function typeLabel(type: TransactionRecord['type']) {
  if (type === 'api_purchase') return 'API Purchase'
  if (type === 'seller_earning') return 'Seller Earning'
  return 'Withdrawal'
}

function typeClass(type: TransactionRecord['type']) {
  if (type === 'api_purchase') return styles.typePurchase
  if (type === 'seller_earning') return styles.typeEarning
  return styles.typeWithdrawal
}

function signedAmount(record: TransactionRecord) {
  const sign = record.amountDirection === 'inflow' ? '+' : record.amountDirection === 'outflow' ? '−' : ''
  return `${sign}${record.amountUsdc} USDC`
}

function amountClass(record: TransactionRecord) {
  if (record.amountDirection === 'inflow') return styles.positive
  if (record.amountDirection === 'outflow') return styles.negative
  return styles.muted
}

function formatDate(value: string, compact = false) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en', compact
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function shortReference(value: string) {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value
}

function lastActivityLabel(summary: TransactionHistory['summary']) {
  if (!summary.lastActivity) return 'No activity'
  return `${typeLabel(summary.lastActivity.type)} · ${formatDate(summary.lastActivity.occurredAt, true)}`
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return <section className={styles.summaryCard}><p>{label}</p><strong>{value}</strong><span>{note}</span></section>
}

export function TransactionHistoryContent({ history, loading, error, filter, selected, copied, onFilter, onRefresh, onRetry, onPrevious, onNext, onSelect, onClose, onCopy }: {
  history: TransactionHistory | null
  loading: boolean
  error: string | null
  filter: TransactionFilter
  selected: TransactionRecord | null
  copied: boolean
  onFilter: (filter: TransactionFilter) => void
  onRefresh: () => void
  onRetry: () => void
  onPrevious: () => void
  onNext: () => void
  onSelect: (record: TransactionRecord) => void
  onClose: () => void
  onCopy: (value: string) => void
}) {
  const degraded = history?.degradedSources.map(source => source.replace('_', ' ')).join(', ')
  const sellerHistoryLimited = history?.limitations.includes('seller_listing_cap')
  return (
    <div className={dashboardStyles.content}>
      <header className={dashboardStyles.pageHeader}>
        <p className={dashboardStyles.eyebrow}>FINANCIAL ACTIVITY</p>
        <div className={styles.headingRow}><div><h1>Recent Transactions</h1><p>Your recent Mahshar purchases, earnings, withdrawals, and settlement records. History is limited to 10 pages.</p></div><button type="button" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
      </header>

      <div className={styles.summaryGrid}>
        <SummaryCard label="Records shown" value={history ? String(history.summary.visibleCount) : '—'} note="Current page" />
        <SummaryCard label="Spent shown" value={history?.summary.visibleSpentUsdc != null ? `${history.summary.visibleSpentUsdc} USDC` : '—'} note="Purchases on this page" />
        <SummaryCard label="Earned shown" value={history?.summary.visibleEarnedUsdc != null ? `${history.summary.visibleEarnedUsdc} USDC` : '—'} note="Accounted seller share on this page" />
        <SummaryCard label="Last activity" value={history ? lastActivityLabel(history.summary) : '—'} note="Newest visible record" />
      </div>

      <section className={styles.historyCard}>
        <div className={styles.toolbar}>
          <div role="group" aria-label="Transaction filters" className={styles.filters}>{FILTERS.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => onFilter(option.value)}>{option.label}</button>)}</div>
          <p>Newest first</p>
        </div>

        {degraded && <div className={styles.degraded} role="status">Some history is temporarily unavailable: {degraded}. Available records are shown.</div>}
        {sellerHistoryLimited && <div className={styles.degraded} role="status">Seller history is limited to 500 owned listings. Other available records are shown.</div>}
        {error && <div className={styles.errorState} role="alert"><p>{error}</p><button type="button" onClick={onRetry}>Try again</button></div>}
        {!error && loading && !history && <div className={styles.loadingState}>Loading transaction records…</div>}
        {!error && !loading && history?.records.length === 0 && history.degradedSources.length > 0 && <div className={styles.errorState} role="status"><h2>Transaction history is partially unavailable</h2><p>No records are available from the sources that responded. Refresh to try the unavailable sources again.</p><button type="button" onClick={onRetry}>Refresh history</button></div>}
        {!error && !loading && history?.records.length === 0 && history.degradedSources.length === 0 && <div className={styles.emptyState}><h2>No transactions yet</h2><p>Mahshar purchases, seller earnings, and withdrawals associated with this wallet will appear here.</p><Link href="/marketplace">Explore Marketplace</Link></div>}
        {!error && history && history.records.length > 0 && <>
          <div className={styles.tableShell}>
            <table>
              <caption className="sr-only">Mahshar transaction records</caption>
              <thead><tr><th scope="col">Type</th><th scope="col">API / Action</th><th scope="col">Amount</th><th scope="col">Payment</th><th scope="col">Delivery</th><th scope="col">Date</th><th scope="col">Reference</th></tr></thead>
              <tbody>{history.records.map(record => <tr key={record.id}>
                <td><span className={`${styles.typeBadge} ${typeClass(record.type)}`}>{typeLabel(record.type)}</span></td>
                <th scope="row"><strong>{record.apiName ?? record.title}</strong><small>{record.role === 'buyer' ? 'Buyer activity' : 'Seller activity'}</small></th>
                <td className={amountClass(record)}>{signedAmount(record)}</td>
                <td><span className={styles.statusBadge}>{record.paymentStatus ?? record.status}</span></td>
                <td>{record.deliveryStatus ? <span className={record.deliveryStatus === 'Failed' ? styles.failedBadge : styles.statusBadge}>{record.deliveryStatus}</span> : <span className={styles.muted}>—</span>}</td>
                <td><time dateTime={record.occurredAt}>{formatDate(record.occurredAt, true)}</time></td>
                <td><button type="button" className={styles.viewButton} onClick={() => onSelect(record)}>View</button></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className={styles.pagination}><button type="button" disabled={history.page <= 1 || loading} onClick={onPrevious}>Previous</button><span>Page {history.page} of {history.maxPage} · Up to {history.maxAccessibleRecords} recent records</span><button type="button" disabled={history.page >= history.maxPage || !history.hasMore || loading} onClick={onNext}>Next</button></div>
        </>}
      </section>

      {selected && <div className={styles.drawerLayer} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
        <aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="transaction-detail-title">
          <div className={styles.drawerHeader}><div><p>TRANSACTION RECORD</p><h2 id="transaction-detail-title">{typeLabel(selected.type)}</h2></div><button type="button" aria-label="Close transaction details" onClick={onClose}>×</button></div>
          <DetailSection title="Transaction details">
            <Detail label="Type" value={typeLabel(selected.type)} />
            <Detail label="API / action" value={selected.apiName ?? selected.title} />
            <Detail label="Role" value={selected.role === 'buyer' ? 'Buyer' : 'Seller'} />
            <Detail label={selected.type === 'withdrawal' ? 'Requested amount' : 'Amount'} value={signedAmount(selected)} />
            <Detail label="Status" value={selected.status} />
            <Detail label="Date and time" value={formatDate(selected.occurredAt)} />
            {selected.completedAt && <Detail label="Completed" value={formatDate(selected.completedAt)} />}
          </DetailSection>
          {(selected.purchaseId || selected.paymentStatus || selected.deliveryStatus || selected.sellerShareUsdc || selected.netAmountUsdc || selected.platformShareUsdc) && <DetailSection title="Payment / Accounting">
            {selected.purchaseId && <Detail label="Purchase ID" value={selected.purchaseId} mono />}
            {selected.paymentStatus && <Detail label="Payment" value={selected.paymentStatus} />}
            {selected.deliveryStatus && <Detail label="Delivery" value={`${selected.deliveryStatus}${selected.deliveryHttpStatus ? ` · HTTP ${selected.deliveryHttpStatus}` : ''}`} />}
            {selected.grossAmountUsdc && <Detail label="Gross purchase" value={`${selected.grossAmountUsdc} USDC`} />}
            {selected.sellerShareUsdc && <Detail label="Seller share" value={`${selected.sellerShareUsdc} USDC`} />}
            {selected.netAmountUsdc && <Detail label={selected.status === 'Completed' ? 'Completed amount' : 'Expected net amount'} value={`${selected.netAmountUsdc} USDC`} />}
            {selected.platformShareUsdc && <Detail label="Platform share" value={`${selected.platformShareUsdc} USDC`} />}
          </DetailSection>}
          {(selected.onchainTransaction || selected.settlementReference) && <DetailSection title="Blockchain / Settlement">
            {selected.onchainTransaction && <div className={styles.referenceBlock}><span>Onchain Transaction</span><code title={selected.onchainTransaction.hash}>{shortReference(selected.onchainTransaction.hash)}</code><div><button type="button" onClick={() => onCopy(selected.onchainTransaction!.hash)}>{copied ? 'Copied' : 'Copy'}</button><a href={selected.onchainTransaction.explorerUrl} target="_blank" rel="noopener noreferrer">Open in Arc explorer ↗</a></div><small>{selected.onchainTransaction.network}</small></div>}
            {selected.settlementReference && <div className={styles.referenceBlock}><span>{selected.settlementReferenceLabel ?? 'Settlement Reference'}</span><code title={selected.settlementReference}>{shortReference(selected.settlementReference)}</code><button type="button" onClick={() => onCopy(selected.settlementReference!)}>{copied ? 'Copied' : 'Copy'}</button></div>}
          </DetailSection>}
        </aside>
      </div>}
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className={styles.detailSection}><h3>{title}</h3><dl>{children}</dl></section>
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? styles.mono : undefined}>{value}</dd></div>
}
