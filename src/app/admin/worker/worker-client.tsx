'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import { workerControlAvailability } from '@/lib/admin-worker/availability'
import { verificationLabel, workerCompletionLabel } from '@/lib/admin-worker/presentation'
import type { WorkerQualifiedLeadDto, WorkerQualifiedLeadsDto, WorkerRunDto, WorkerRunsDto, WorkerStatusDto } from '@/lib/admin-worker/types'
import { workerLeadContactLabel } from './lead-presentation'
import { QualificationLabel } from './qualification-label'
import styles from './worker.module.css'

const REFRESH_INTERVAL_MS = 12_000

function statusLabel(value: string) {
  return value.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())
}

function timeLabel(value: string | null) {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(time)) : '—'
}

function RunStatus({ status }: { status: WorkerRunDto['status'] }) {
  return <span className={`${styles.badge} ${styles[`status_${status}`]}`}>{statusLabel(status)}</span>
}

function Progress({ run }: { run: WorkerRunDto }) {
  const percentage = Math.round(run.counts.qualified / run.targets.qualified * 100)
  return <div className={styles.progressGroup}>
    <div><span>{run.counts.qualified} / {run.targets.qualified} qualified</span><strong>{percentage}%</strong></div>
    <progress max={run.targets.qualified} value={run.counts.qualified} aria-label={`${run.counts.qualified} of ${run.targets.qualified} qualified leads`}/>
  </div>
}

function LatestRun({ run }: { run: WorkerRunDto | null }) {
  if (!run) return <div className={styles.empty}>No Worker batch has run yet.</div>
  return <>
    <div className={styles.runSummary}>
      <div><span>Run</span><code title={run.id}>{run.id}</code></div>
      <div><span>Status</span><RunStatus status={run.status}/></div>
      <div><span>Started</span><strong>{timeLabel(run.started_at)}</strong></div>
      <div><span>Completed / stopped</span><strong>{timeLabel(run.completed_at ?? run.stopped_at)}</strong></div>
    </div>
    <Progress run={run}/>
    <div className={styles.runSummary}>
      <div><span>Raw scanned</span><strong>{run.counts.raw_scanned} / {run.targets.raw_limit}</strong></div>
      <div><span>Remaining to target</span><strong>{run.targets.remaining}</strong></div>
      <div><span>Completion</span><strong>{workerCompletionLabel(run)}</strong></div>
      <div><span>Source exhausted</span><strong>{run.source_exhausted ? 'Yes' : 'No'}</strong></div>
    </div>
    <div className={styles.countGrid}>
      {Object.entries(run.counts).map(([label, value]) => <div key={label}><span>{statusLabel(label)}</span><strong>{value}</strong></div>)}
      {Object.entries(run.resources).map(([label, value]) => <div key={label}><span>{statusLabel(label)}</span><strong>{value}</strong></div>)}
    </div>
  </>
}

function EvidenceLinks({ lead }: { lead: WorkerQualifiedLeadDto }) {
  return <div className={styles.detailLinks}>
    {lead.official_site && <a href={lead.official_site} target="_blank" rel="noopener noreferrer">Official site</a>}
    {lead.docs_url && <a href={lead.docs_url} target="_blank" rel="noopener noreferrer">Official docs</a>}
    {lead.pricing_url && <a href={lead.pricing_url} target="_blank" rel="noopener noreferrer">Pricing</a>}
    {lead.github_url && <a href={lead.github_url} target="_blank" rel="noopener noreferrer">GitHub</a>}
    {lead.directory_sources.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">Directory source {index + 1}</a>)}
  </div>
}

function LeadDetails({ lead }: { lead: WorkerQualifiedLeadDto }) {
  return <div className={styles.leadDetails}>
    <section><h3>AI qualification</h3><p>{lead.summary}</p>{lead.reason_codes.length > 0 && <small>{lead.reason_codes.map(statusLabel).join(' · ')}</small>}</section>
    <section><h3>Technical evidence</h3><EvidenceLinks lead={lead}/><dl><div><dt>Auth</dt><dd>Supported or not declared</dd></div><div><dt>Pricing</dt><dd>{verificationLabel(lead.pricing_available)}</dd></div></dl></section>
    <section><h3>Traction signals</h3><dl><div><dt>Activity</dt><dd>{lead.traction_level ? statusLabel(lead.traction_level) : 'Unknown'}{lead.traction_score === null ? '' : ` · score ${lead.traction_score}`}</dd></div><div><dt>Confidence</dt><dd>{statusLabel(lead.traction_confidence)}</dd></div></dl><p>{lead.traction_summary ?? 'No bounded activity estimate available.'}</p>{lead.traction_signals.length > 0 && <ul>{lead.traction_signals.map(signal => <li key={signal}>{statusLabel(signal)}</li>)}</ul>}</section>
    <section><h3>Contact</h3><dl><div><dt>Actionable</dt><dd>{lead.actionable ? 'Yes' : 'No'}</dd></div><div><dt>Email ready</dt><dd>{lead.email_ready ? 'Yes' : 'No'}</dd></div><div><dt>Email</dt><dd>{lead.preferred_email ?? '—'}</dd></div><div><dt>Official route</dt><dd>{lead.official_contact_url ? <a href={lead.official_contact_url} target="_blank" rel="noopener noreferrer">Open contact</a> : '—'}</dd></div></dl>{lead.contact_evidence.length > 0 && <ul>{lead.contact_evidence.map(evidence => <li key={`${evidence.type}:${evidence.value}`}><a href={evidence.source_url} target="_blank" rel="noopener noreferrer">{statusLabel(evidence.purpose)} · {statusLabel(evidence.source_type)}</a></li>)}</ul>}</section>
    <section><h3>Concerns</h3>{lead.traction_concerns.length > 0 ? <ul>{lead.traction_concerns.map(concern => <li key={concern}>{statusLabel(concern)}</li>)}</ul> : <p>None recorded.</p>}</section>
    <section><h3>Timeline</h3><dl><div><dt>Discovered</dt><dd>{timeLabel(lead.discovered_at)}</dd></div><div><dt>Last evidence/activity</dt><dd>{timeLabel(lead.last_activity_at ?? lead.last_evidence_at)}</dd></div></dl></section>
  </div>
}

export function WorkerClient() {
  const request = useAdminRequest()
  const mounted = useRef(true)
  const lastAttempt = useRef(0)
  const hasKnownData = useRef(false)
  const [status, setStatus] = useState<WorkerStatusDto | null>(null)
  const [runs, setRuns] = useState<WorkerRunDto[]>([])
  const [leads, setLeads] = useState<WorkerQualifiedLeadDto[]>([])
  const [leadCounts, setLeadCounts] = useState<WorkerQualifiedLeadsDto['counts'] | null>(null)
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null)
  const [leadsPhase, setLeadsPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'degraded' | 'unavailable'>('loading')
  const [busy, setBusy] = useState<'start' | 'stop' | 'resume' | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    lastAttempt.current = Date.now()
    const load = async <T,>(url: string): Promise<T> => {
      const response = await request(url, { cache: 'no-store' })
      if (!response.ok) throw new Error('worker_refresh_unavailable')
      return response.json() as Promise<T>
    }
    const [statusResult, runsResult, leadsResult] = await Promise.allSettled([
      load<WorkerStatusDto>('/api/admin/worker/status'),
      load<WorkerRunsDto>('/api/admin/worker/runs?limit=10'),
      load<WorkerQualifiedLeadsDto>('/api/admin/worker/leads?limit=25'),
    ])
    let failed = false
    if (statusResult.status === 'fulfilled') {
      if (mounted.current) { setStatus(statusResult.value); hasKnownData.current = true }
    } else failed = true
    if (runsResult.status === 'fulfilled') {
      if (mounted.current) { setRuns(runsResult.value.runs); hasKnownData.current = true }
    } else failed = true
    if (leadsResult.status === 'fulfilled') {
      if (mounted.current) { setLeads(leadsResult.value.leads); setLeadCounts(leadsResult.value.counts); setLeadsPhase('ready'); hasKnownData.current = true }
    } else { if (mounted.current) setLeadsPhase('failed'); failed = true }
    if (mounted.current) setPhase(failed ? (hasKnownData.current ? 'degraded' : 'unavailable') : 'ready')
  }, [request])

  useEffect(() => {
    void refresh()
    const refreshIfDue = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAttempt.current >= REFRESH_INTERVAL_MS) void refresh()
    }
    const timer = window.setInterval(refreshIfDue, REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', refreshIfDue)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshIfDue) }
  }, [refresh])

  const controls = useMemo(() => workerControlAvailability(status), [status])

  const command = useCallback(async (action: 'start' | 'stop' | 'resume') => {
    setBusy(action); setCommandError(null)
    try {
      const response = await request(`/api/admin/worker/${action}`, { method: 'POST' })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error === 'worker_already_active' ? 'A Worker batch is already active.'
          : body?.error === 'worker_not_resumable' ? 'No safe resumable checkpoint is available.'
            : 'The Worker command could not be completed.')
      }
      await refresh()
    } catch (error) {
      if (mounted.current) setCommandError(error instanceof Error ? error.message : 'The Worker command could not be completed.')
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [refresh, request])

  const checkpoint = status?.checkpoint
  return <div className={styles.page}>
    <section className={styles.heading}>
      <div><span className={styles.eyebrow}>Isolated discovery control</span><h1>Worker Agent</h1><p>Discover and qualify one durable, bounded batch of public API candidates at a time.</p></div>
      <div className={`${styles.overallStatus} ${styles[`overall_${status?.status ?? 'stopped'}`]}`}>
        <i/><div><span>Worker status</span><strong>{status ? statusLabel(status.status) : 'Loading'}</strong></div>
      </div>
    </section>

    {phase === 'degraded' && <div className={styles.warning} role="status">Refresh failed. Showing the last known Worker state.</div>}
    {phase === 'unavailable' && <div className={styles.warning} role="alert">Worker status is temporarily unavailable. Core Mahshar remains unaffected.</div>}
    {commandError && <div className={styles.error} role="alert">{commandError}</div>}

    <section className={styles.statusGrid} aria-label="Worker configuration">
      <article><span>Qualified target</span><strong>{status?.qualified_target ?? '—'}</strong><small>Only actionable technical fits count</small></article>
      <article><span>Raw scan hard cap</span><strong>{status?.raw_candidate_limit ?? '—'}</strong><small>Stops safely even below target</small></article>
      <article><span>Last checkpoint</span><strong>{checkpoint ? `${checkpoint.nextIndex} / ${checkpoint.batchSize}` : 'None'}</strong><small>Compact checkpoint version {checkpoint?.version ?? '—'}</small></article>
      <article><span>Last completed</span><strong className={styles.timeValue}>{timeLabel(status?.last_completed_at ?? null)}</strong><small>Durable completion timestamp</small></article>
    </section>

    <section className={styles.controlPanel}>
      <div><span>Batch controls</span><h2>Lifecycle</h2><p>Stop is cooperative and takes effect at a safe chunk boundary. Resume creates a new run from the last safe checkpoint.</p></div>
      <div className={styles.controls}>
        <button type="button" onClick={() => void command('start')} disabled={!controls.canStart || busy !== null}>{busy === 'start' ? 'Starting…' : 'Start'}</button>
        <button type="button" className={styles.stopButton} onClick={() => void command('stop')} disabled={!controls.canStop || busy !== null}>{busy === 'stop' ? 'Requesting…' : 'Stop'}</button>
        <button type="button" onClick={() => void command('resume')} disabled={!controls.canResume || busy !== null}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>
      </div>
    </section>

    <section className={styles.notice}>
      <div aria-hidden="true">i</div><p><strong>Discovery V1</strong>Bounded public API discovery, technical Fit, and official contact research are enabled. Leads remain Admin-only; no outreach, account creation, or Marketplace listing occurs.</p>
    </section>

    <section className={styles.panel}>
      <header><div><span>Verified outreach channel required · bounded to 25 rows</span><h2>Contact-ready Discovery leads</h2></div></header>
      {leadCounts && <div className={styles.leadCounts} aria-label="Discovery lead counts">
        <span><strong>{leadCounts.actionable_qualified}</strong> actionable Qualified / {leadCounts.technical_qualified} technical</span>
        <span><strong>{leadCounts.actionable_review_candidates}</strong> actionable Review / {leadCounts.technical_review_candidates} technical</span>
        <span><strong>{leadCounts.email_ready}</strong> email-ready</span>
        <span><strong>{leadCounts.contact_form_only}</strong> contact-form-only</span>
        <span><strong>{leadCounts.contact_unavailable}</strong> unavailable</span>
        <span><strong>{leadCounts.contact_unknown}</strong> unknown</span>
      </div>}
      {leadsPhase === 'loading' ? <div className={styles.empty} role="status">Loading qualified leads…</div>
        : leadsPhase === 'failed' ? <div className={styles.empty} role="alert">Qualified leads are temporarily unavailable.</div>
          : leads.length === 0 ? <div className={styles.empty}>No contact-ready Qualified or Review Candidate leads are available.</div> : <div className={`${styles.tableViewport} ${styles.leadsTable}`}><table>
        <thead><tr><th>API</th><th>Provider</th><th>Category</th><th>Fit</th><th>Status</th><th>Preferred Email</th><th>Official Contact</th><th>Email-ready</th><th>Activity</th><th>Last Evidence</th><th>Details</th></tr></thead>
        <tbody>{leads.map(lead => {
          const expanded = expandedLeadId === lead.id
          return <Fragment key={lead.id}><tr className={styles.leadRow}>
            <td data-label="API"><strong title={lead.product}>{lead.product}</strong></td>
            <td data-label="Provider"><span title={lead.provider}>{lead.provider}</span></td>
            <td data-label="Category"><span>Public API</span></td>
            <td data-label="Fit"><strong>{lead.fit_score}</strong></td>
            <td data-label="Status"><QualificationLabel status={lead.status} reasonCodes={lead.reason_codes}/></td>
            <td data-label="Preferred Email"><span>{lead.preferred_email ?? '—'}</span></td>
            <td data-label="Official Contact">{lead.official_contact_url
              ? <a href={lead.official_contact_url} target="_blank" rel="noopener noreferrer">{workerLeadContactLabel(lead)}</a> : <span>—</span>}</td>
            <td data-label="Email-ready"><span>{lead.email_ready ? 'Yes' : 'No'}</span></td>
            <td data-label="Activity"><span>{lead.traction_level ? statusLabel(lead.traction_level) : 'Unknown'}{lead.traction_score === null ? '' : ` · score ${lead.traction_score}`}</span></td>
            <td data-label="Last Evidence"><span>{timeLabel(lead.last_activity_at ?? lead.last_evidence_at)}</span></td>
            <td data-label="Details"><button type="button" className={styles.detailsButton} aria-expanded={expanded} aria-controls={`lead-${lead.id}`} onClick={() => setExpandedLeadId(expanded ? null : lead.id)}>{expanded ? 'Close' : 'Details'}</button></td>
          </tr>{expanded && <tr className={styles.detailRow}><td id={`lead-${lead.id}`} colSpan={11}><LeadDetails lead={lead}/></td></tr>}</Fragment>
        })}</tbody>
      </table></div>}
    </section>

    <section className={styles.panel}>
      <header><div><span>Durable execution</span><h2>Current / latest run</h2></div>{status?.latest_run && <RunStatus status={status.latest_run.status}/>}</header>
      <div className={styles.panelBody}>{phase === 'loading' && !status ? <div className={styles.empty}>Loading Worker state…</div> : <LatestRun run={status?.latest_run ?? null}/>}</div>
    </section>

    <section className={styles.panel}>
      <header><div><span>Bounded to 10 rows</span><h2>Recent runs</h2></div><button type="button" className={styles.refreshButton} onClick={() => void refresh()} disabled={phase === 'loading'}>Refresh</button></header>
      {runs.length === 0 ? <div className={styles.empty}>No run history is available.</div> : <div className={styles.tableViewport}><table>
        <thead><tr><th>Run</th><th>Status</th><th>Progress</th><th>Started</th><th>Finished</th></tr></thead>
        <tbody>{runs.map(run => <tr key={run.id}>
          <td data-label="Run"><strong>#{run.run_number}</strong><code title={run.id}>{run.id}</code></td>
          <td data-label="Status"><RunStatus status={run.status}/>{run.error_code && <small>{run.error_code.replace(/_/g, ' ')}</small>}</td>
          <td data-label="Progress"><span>{run.processed_count} / {run.batch_size}</span></td>
          <td data-label="Started"><span>{timeLabel(run.started_at)}</span></td>
          <td data-label="Finished"><span>{timeLabel(run.completed_at ?? run.stopped_at)}</span></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>
}
