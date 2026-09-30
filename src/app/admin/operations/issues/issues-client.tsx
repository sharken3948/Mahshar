'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { OperationsIssuesDto } from '@/lib/admin/operations-types'
import { SectionState, StatusBadge, timeLabel, type OperationsPhase } from '../operations-ui'
import styles from '../operations.module.css'

type IssueView = 'needs_attention' | 'informational' | 'all'

export function IssuesClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<OperationsIssuesDto | null>(null)
  const [phase, setPhase] = useState<OperationsPhase>('loading')
  const [limit, setLimit] = useState(25)
  const [view, setView] = useState<IssueView>('needs_attention')
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const current = ++sequence.current
    setPhase(previous => data && previous !== 'unavailable' ? 'degraded' : 'loading')
    try {
      const response = await request(`/api/admin/operations/issues?limit=${limit}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('issues unavailable')
      const value = await response.json() as OperationsIssuesDto
      if (current !== sequence.current) return
      setData(value); setPhase(value.count ? 'ready' : 'empty')
    } catch { if (current === sequence.current) setPhase(data ? 'degraded' : 'unavailable') }
  }, [data, limit, request])
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { void loadRef.current() }, [limit])
  const unavailableSources = data?.sources.filter(source => source.state === 'unavailable') ?? []
  const visibleIssues = data?.issues.filter(issue => view === 'all' || issue.presentation === view) ?? []
  const viewLabel = view === 'needs_attention' ? 'Needs Attention' : view === 'informational' ? 'Informational' : 'All Durable Conditions'

  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>Current durable state</span><h1>Recent Issues</h1><p>Operational conditions that are relevant now—not a fabricated historical event log.</p></div>
      <button className={styles.primaryButton} type="button" onClick={load} disabled={phase === 'loading'}><span aria-hidden="true">↻</span>Manual refresh</button>
    </section>
    <section className={`${styles.issueSummary} ${data?.counts.needs_attention_entities ? styles.issueSummaryCritical : ''}`}>
      <div><span>Needs review</span><strong>{data ? `${data.counts.needs_attention_entities}${data.truncated || !data.complete ? '+' : ''}` : '—'}</strong>{data && <small>{data.counts.needs_attention_conditions} condition{data.counts.needs_attention_conditions === 1 ? '' : 's'}</small>}</div>
      <p>The review count is deduplicated by durable entity. Informational delivery records require accounting complete plus the full legacy-null signature. Every other condition defaults to Needs Attention, and all raw durable conditions remain available.</p>
      <label className={styles.filterField}><span>Rows shown</span><select value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option></select></label>
    </section>
    {data && <div className={styles.issueTabs} role="tablist" aria-label="Recent issue classification">
      <button type="button" role="tab" aria-selected={view === 'needs_attention'} className={view === 'needs_attention' ? styles.issueTabActive : ''} onClick={() => setView('needs_attention')}><span>Needs Attention</span><strong>{data.counts.needs_attention_entities}</strong><small>{data.counts.needs_attention_conditions} conditions</small></button>
      <button type="button" role="tab" aria-selected={view === 'informational'} className={view === 'informational' ? styles.issueTabActive : ''} onClick={() => setView('informational')}><span>Informational</span><strong>{data.counts.informational_conditions}</strong><small>conditions</small></button>
      <button type="button" role="tab" aria-selected={view === 'all'} className={view === 'all' ? styles.issueTabActive : ''} onClick={() => setView('all')}><span>All Durable Conditions</span><strong>{data.counts.all_conditions}</strong><small>conditions</small></button>
    </div>}
    {unavailableSources.length > 0 && <div className={styles.degradedBanner} role="status">Partial issue coverage. Unavailable source{unavailableSources.length === 1 ? '' : 's'}: {unavailableSources.map(source => source.label).join(', ')}. Other current durable sources remain visible; the count is a known minimum.</div>}
    <section className={`${styles.panel} ${styles.issuesPanel}`}>
      <header className={styles.panelHeader}><div><span>Read-only operator context</span><h2>{viewLabel}</h2></div>{phase === 'degraded' ? <em>Stale</em> : unavailableSources.length > 0 ? <em>Partial</em> : null}</header>
      <SectionState phase={phase} empty="No current durable issues were found in the bounded taxonomy." onRetry={load}/>
      {data && phase !== 'loading' && visibleIssues.length === 0 && <div className={styles.sectionMessage}><strong>Nothing in this view</strong><span>No loaded durable conditions match {viewLabel}.</span></div>}
      {data && visibleIssues.length > 0 && <div className={styles.issueList}>{visibleIssues.map(issue => <details className={`${styles.issueRecord} ${issue.severity === 'critical' ? styles.issueCritical : issue.severity === 'informational' ? styles.issueInformational : styles.issueWarning}`} key={issue.id}>
        <summary><span className={styles.issueSeverity}>{issue.severity === 'critical' ? 'Critical' : issue.severity === 'informational' ? 'Informational' : 'Warning'}</span><div><strong>{issue.type.replaceAll('_', ' ')}</strong><small>{issue.listing?.name ?? issue.entity_id}</small></div><StatusBadge value={issue.settlement_state ?? issue.delivery_state ?? issue.type} severity={issue.severity}/><time>{timeLabel(issue.updated_at)}</time><span className={styles.issueChevron} aria-hidden="true">⌄</span></summary>
        <div className={styles.issueDetail}>
          <p>{issue.explanation}</p>
          <dl><div><dt>Classification</dt><dd>{issue.presentation === 'needs_attention' ? 'Needs Attention' : 'Informational'}</dd></div><div><dt>Entity</dt><dd><code>{issue.entity_id}</code></dd></div><div><dt>Listing</dt><dd>{issue.listing ? `${issue.listing.name} · ${issue.listing.id}` : 'Not applicable'}</dd></div><div><dt>Wallet</dt><dd><code>{issue.wallet ?? 'Unavailable'}</code></dd></div><div><dt>Settlement</dt><dd>{issue.settlement_state ?? 'Not applicable'}</dd></div><div><dt>Delivery</dt><dd>{issue.delivery_state ?? 'Not applicable'}</dd></div><div><dt>Purchase</dt><dd><code>{issue.purchase_id ?? 'Not linked'}</code></dd></div><div><dt>Safe error code</dt><dd>{issue.error_code ?? 'Unavailable'}</dd></div><div><dt>Durable timestamp</dt><dd>{timeLabel(issue.updated_at)}</dd></div></dl>
        </div>
      </details>)}</div>}
    </section>
  </div>
}
