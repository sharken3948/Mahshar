'use client'

import type { IssueSeverity, OperationalSignalDto } from '@/lib/admin/operations-types'
import styles from './operations.module.css'

export type OperationsPhase = 'loading' | 'ready' | 'empty' | 'degraded' | 'unavailable'

export function formatState(state: string) {
  return state.toLowerCase().split('_').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ')
}

export function timeLabel(value: string | null) {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable'
}

export function StatusBadge({ value, severity }: { value: string; severity?: IssueSeverity }) {
  const informational = severity === 'informational'
  const critical = !informational && (severity === 'critical' || /SETTLEMENT_UNKNOWN|MANUAL_REVIEW|DELIVERY_UNKNOWN/.test(value) || value === 'UNKNOWN')
  const warning = !informational && (severity === 'warning' || /FAILED|SETTLEMENT_SUBMITTED|DEGRADED|UNAVAILABLE|BLOCKED|INVALID|EXCLUDED|INACTIVE|UNVERIFIED/.test(value))
  const positive = /ACCOUNTING_COMPLETE|SETTLEMENT_CONFIRMED|SUCCEEDED|READY|ACTIVE|VALID|VISIBLE|ELIGIBLE|VERIFIED/.test(value) && !critical && !warning
  return <span className={`${styles.statusBadge} ${critical ? styles.statusCritical : warning ? styles.statusWarn : positive ? styles.statusGood : styles.statusNeutral}`}>{formatState(value)}</span>
}

export function SectionState({ phase, empty, onRetry }: { phase: OperationsPhase; empty: string; onRetry: () => void }) {
  if (phase === 'loading') return <div className={styles.sectionLoading}><span/><span/><span/></div>
  if (phase === 'unavailable') return <div className={styles.sectionMessage}><strong>Data unavailable</strong><span>This Admin read failed without affecting Mahshar.</span><button type="button" onClick={onRetry}>Try again</button></div>
  if (phase === 'empty') return <div className={styles.sectionMessage}><strong>Nothing to show</strong><span>{empty}</span></div>
  return null
}

export function SignalGrid({ signals }: { signals: OperationalSignalDto[] }) {
  return <section className={styles.signalGrid}>{signals.map(item => <article className={styles.signalCard} key={item.id}>
    <div className={styles.signalHead}><span className={styles.signalIcon} aria-hidden="true"/><StatusBadge value={item.state}/></div>
    <h2>{item.label}</h2>
    <p>{item.detail}</p>
    {item.metadata && <small>{item.metadata}</small>}
  </article>)}</section>
}
