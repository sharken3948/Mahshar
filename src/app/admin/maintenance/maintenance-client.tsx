'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { MaintenanceCheckResult, MaintenanceDashboardDto, MaintenanceInventoryItem, MaintenanceStatus } from '@/lib/admin-maintenance/types'
import styles from './maintenance.module.css'

type Phase = 'loading' | 'ready' | 'checking' | 'error'

const statusLabel: Record<MaintenanceStatus, string> = {
  current: 'Current', update_available: 'Update available', deprecation_notice: 'Deprecation notice',
  action_required: 'Action required', check_failed: 'Check failed', unknown: 'Unknown',
}

function timeLabel(value: string | null) {
  if (!value) return 'Not checked yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function pendingResult(item: MaintenanceInventoryItem): MaintenanceCheckResult {
  return { ...item, latest: null, status: 'unknown', severity: 'Info', impact: 'Run a manual check to compare official upstream sources.', details: item.usage, recommended_action: 'Select Check for updates when you are ready.', checked_at: '' }
}

function SummaryCard({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return <article className={`${styles.summaryCard} ${styles[tone]}`}><span>{label}</span><strong>{value}</strong></article>
}

export function MaintenanceClient() {
  const request = useAdminRequest()
  const [phase, setPhase] = useState<Phase>('loading')
  const [dashboard, setDashboard] = useState<MaintenanceDashboardDto | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadInventory = useCallback(async () => {
    try {
      const response = await request('/api/admin/maintenance', { cache: 'no-store' })
      if (!response.ok) throw new Error('inventory unavailable')
      const value = await response.json() as MaintenanceDashboardDto
      setDashboard(value); setPhase('ready')
    } catch { setPhase('error') }
  }, [request])

  useEffect(() => { void loadInventory() }, [loadInventory])

  const check = useCallback(async () => {
    setPhase('checking')
    try {
      const response = await request('/api/admin/maintenance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!response.ok) throw new Error('check unavailable')
      const value = await response.json() as MaintenanceDashboardDto
      setDashboard(value); setPhase('ready')
    } catch { setPhase('error') }
  }, [request])

  const results = useMemo(() => dashboard?.results.length ? dashboard.results : (dashboard?.inventory || []).map(pendingResult), [dashboard])
  const selected = results.find(item => item.id === selectedId) || null
  const summary = dashboard?.summary || { critical: 0, important: 0, review: 0, current: 0, check_failures: 0 }

  return <div className={styles.page}>
    <section className={styles.heading}>
      <div><span>Operator watch</span><h1>Maintenance</h1><p>Manual, read-only checks for the dependencies and infrastructure Mahshar actually uses.</p></div>
      <button type="button" onClick={check} disabled={phase === 'checking' || phase === 'loading'}>{phase === 'checking' ? 'Checking official sources…' : 'Check for updates'}</button>
    </section>

    {phase === 'error' && <div className={styles.error}>A maintenance source or inventory read failed. Mahshar application behavior is unaffected. <button type="button" onClick={loadInventory}>Reload inventory</button></div>}

    <section className={styles.summary} aria-label="Maintenance summary">
      <SummaryCard label="Critical" value={summary.critical} tone="critical"/>
      <SummaryCard label="Important" value={summary.important} tone="important"/>
      <SummaryCard label="Review" value={summary.review} tone="review"/>
      <SummaryCard label="Current" value={summary.current} tone="current"/>
      <SummaryCard label="Check failures" value={summary.check_failures} tone="failure"/>
      <SummaryCard label="Last checked" value={timeLabel(dashboard?.checked_at || null)} tone="checked"/>
    </section>

    <section className={styles.panel}>
      <header><div><span>Bounded official sources</span><h2>Components</h2></div><small>No automatic updates or configuration changes</small></header>
      {phase === 'loading' ? <p className={styles.empty}>Loading current Mahshar inventory…</p> : results.length === 0 ? <p className={styles.empty}>No monitored components are available.</p> : <div className={styles.tableViewport}>
        <table><thead><tr><th>Component</th><th>Current</th><th>Latest / notice</th><th>Status</th><th>Severity</th><th>Mahshar impact</th><th>Checked</th><th>Details</th></tr></thead>
          <tbody>{results.map(item => <tr key={item.id}>
            <td><strong>{item.component}</strong><small>{item.category}</small></td>
            <td><code>{item.current}</code></td><td>{item.latest || '—'}</td>
            <td><span className={`${styles.chip} ${styles[item.status]}`}>{statusLabel[item.status]}</span></td>
            <td><span className={`${styles.severity} ${styles[`severity${item.severity}`]}`}>{item.severity}</span></td>
            <td>{item.impact}</td><td>{item.checked_at ? timeLabel(item.checked_at) : 'Not checked'}</td>
            <td><button type="button" onClick={() => setSelectedId(current => current === item.id ? null : item.id)} aria-expanded={selectedId === item.id}>Review</button></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>

    {selected && <section className={styles.details} aria-label={`${selected.component} details`}>
      <header><div><span>{selected.category}</span><h2>{selected.component}</h2></div><button type="button" onClick={() => setSelectedId(null)} aria-label="Close details">×</button></header>
      <div className={styles.detailGrid}>
        <div><h3>Current Mahshar usage</h3><p>{selected.usage}</p><dl><dt>Installed / configured</dt><dd>{selected.current}</dd><dt>Latest / notice</dt><dd>{selected.latest || 'Not checked'}</dd></dl></div>
        <div><h3>Impact</h3><p>{selected.impact}</p><p>{selected.details}</p></div>
        <div><h3>Manual next step</h3><p>{selected.recommended_action}</p><a href={selected.source_url} target="_blank" rel="noreferrer">Open official source</a></div>
      </div>
    </section>}
  </div>
}
