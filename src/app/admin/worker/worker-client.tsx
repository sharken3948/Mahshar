'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import { workerControlAvailability } from '@/lib/admin-worker/availability'
import { verificationLabel, workerCompletionLabel } from '@/lib/admin-worker/presentation'
import type { WorkerQualifiedLeadDto, WorkerQualifiedLeadsDto, WorkerRunDto, WorkerRunsDto, WorkerStatusDto } from '@/lib/admin-worker/types'
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

export function WorkerClient() {
  const request = useAdminRequest()
  const mounted = useRef(true)
  const lastAttempt = useRef(0)
  const hasKnownData = useRef(false)
  const [status, setStatus] = useState<WorkerStatusDto | null>(null)
  const [runs, setRuns] = useState<WorkerRunDto[]>([])
  const [leads, setLeads] = useState<WorkerQualifiedLeadDto[]>([])
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
      if (mounted.current) { setLeads(leadsResult.value.leads); setLeadsPhase('ready'); hasKnownData.current = true }
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
      <article><span>Qualified target</span><strong>{status?.qualified_target ?? '—'}</strong><small>Only final qualified leads count</small></article>
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
      <div aria-hidden="true">i</div><p><strong>Discovery V1</strong>Bounded public API discovery and Groq fit qualification are enabled. Leads remain Admin-only; no outreach, account creation, or Marketplace listing occurs.</p>
    </section>

    <section className={styles.panel}>
      <header><div><span>Qualified 70+ · manual review 60–69 · bounded to 25 rows</span><h2>Qualified & Review Candidates</h2></div></header>
      {leadsPhase === 'loading' ? <div className={styles.empty} role="status">Loading qualified leads…</div>
        : leadsPhase === 'failed' ? <div className={styles.empty} role="alert">Qualified leads are temporarily unavailable.</div>
          : leads.length === 0 ? <div className={styles.empty}>No qualified or review candidates are available.</div> : <div className={`${styles.tableViewport} ${styles.leadsTable}`}><table>
        <thead><tr><th>Provider / API</th><th>Fit / band</th><th>Traction estimate</th><th>Contactability</th><th>AI qualification summary</th><th>Verified evidence</th><th>Discovered</th></tr></thead>
        <tbody>{leads.map(lead => <tr key={lead.id}>
          <td data-label="Provider / API"><strong>{lead.provider}</strong><span>{lead.product}</span></td>
          <td data-label="Fit / band"><strong>{lead.fit_score}</strong><QualificationLabel status={lead.status} reasonCodes={lead.reason_codes}/></td>
          <td data-label="Traction estimate"><strong>{lead.traction_score ?? 'Unknown'}</strong><span>{lead.traction_level ? statusLabel(lead.traction_level) : 'Unknown'} activity · {statusLabel(lead.traction_confidence)} confidence</span><small>{lead.traction_summary ?? 'No bounded activity estimate available.'}{lead.last_activity_at ? ` · Last supported activity ${timeLabel(lead.last_activity_at)}` : ''}</small></td>
          <td data-label="Contactability"><span>{statusLabel(lead.contactability)}</span></td>
          <td data-label="AI qualification summary"><span>{lead.summary}</span></td>
          <td data-label="Verified evidence">{lead.official_site && <a href={lead.official_site} target="_blank" rel="noopener noreferrer">Official site</a>}{lead.docs_url && <>{lead.official_site && ' · '}<a href={lead.docs_url} target="_blank" rel="noopener noreferrer">Official docs</a></>}<small>Pricing: {verificationLabel(lead.pricing_available)} · Contact: {verificationLabel(lead.contact_available)}</small>{lead.directory_sources.length > 0 && <small>Directory assertions: {lead.directory_sources.map((url, index) => <span key={url}>{index > 0 && ' · '}<a href={url} target="_blank" rel="noopener noreferrer">Source {index + 1}</a></span>)}</small>}</td>
          <td data-label="Discovered"><span>{timeLabel(lead.discovered_at)}</span></td>
        </tr>)}</tbody>
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
