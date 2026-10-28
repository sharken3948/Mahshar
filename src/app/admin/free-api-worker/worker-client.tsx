'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import type { Candidate } from '@/lib/free-api-worker/model'
import type { State } from '@/lib/free-api-worker/store'
import { BulkList, BulkProgressPanel } from './bulk-list'
import { bulkCounts, mergeBulkProgress, runBulkSelection, type BulkProgress } from '@/lib/free-api-worker/bulk-progress'
import styles from './worker.module.css'

type Snapshot = {
  progress: { total: number; completed: number; unfinished: number; active: number; batchSize: number }
  state: State; summary: { admitted: number; functional: number; usable: number; successPercent: number }
  total: number; pageSize: number; candidates: Candidate[]; nextRetry: string | null
}
export function FreeApiWorkerClient() {
  const { request, wallet } = useMarketplaceSession(), { address } = useAccount()
  const owner = wallet === '0x540a0027509b1c9aa0a2c5c65491cc97083e16de' && address?.toLowerCase() === wallet
  const [data, setData] = useState<Snapshot | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [view, setView] = useState('usable')
  const [selected, setSelected] = useState<Set<string>>(new Set()), [confirming, setConfirming] = useState(false)
  const [movingFailed, setMovingFailed] = useState(false), [failedNotice, setFailedNotice] = useState('')
  const [publishing, setPublishing] = useState<Candidate[] | null>(null)
  const [batch, setBatch] = useState<BulkProgress | null>(null), [batchBusy, setBatchBusy] = useState(false), [batchNotice, setBatchNotice] = useState('')
  const processing = useRef(false), mounted = useRef(true)
  const liveWallet = useRef(wallet); liveWallet.current = wallet
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const unfinished = batch && (bulkCounts(batch).remaining > 0 || bulkCounts(batch).processing > 0)
  const [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams({ view, q: query, page: String(page) })
      const [response, progress] = await Promise.all([
        request(`/api/admin/free-api-worker/status?${params}`, { cache: 'no-store', signal }),
        request('/api/admin/free-api-worker/batches', { cache: 'no-store', signal }),
      ])
      const saved = await progress.json()
      if (!progress.ok) throw new Error(saved.error ?? 'Saved Bulk List progress unavailable')
      if (!signal?.aborted) setBatch(previous => mergeBulkProgress(previous, saved.batch))
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Worker unavailable')
      if (!signal?.aborted) { setData(body); setError(''); setSelected(current => new Set([...current].filter(id => body.candidates.some((row: Candidate) => row.lead.id === id)))) }
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Worker unavailable') }
  }, [request, view, query, page])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(controller.signal) }, 5000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [load])
  useEffect(() => { setSelected(new Set()); setConfirming(false); setMovingFailed(false) }, [query, view, page])
  async function runSavedBatch(saved: BulkProgress, retry = false) {
    if (processing.current || !owner) return
    const authorizedWallet = wallet
    processing.current = true; setBatchBusy(true); setBatch(saved); setBatchNotice('Processing saved selection…')
    try {
      if (retry) {
        const response = await request(`/api/admin/free-api-worker/batches/${saved.id}`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry_failed' }) })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Retry unavailable')
        saved = body.batch
      }
      await runBulkSelection({ batch: saved, request,
        stopped: () => !mounted.current || liveWallet.current !== authorizedWallet,
        onProgress: value => { if (mounted.current) setBatch(previous => mergeBulkProgress(previous, value)) },
        wait: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
      })
      if (mounted.current) setBatchNotice('Pass complete. Failed APIs remain saved for review or retry.')
    } catch (cause) {
      if (mounted.current) setBatchNotice((cause instanceof Error ? cause.message : 'Request interrupted.') + ' Progress is saved; Resume reconciles unfinished work.')
    } finally {
      processing.current = false
      if (mounted.current) { setBatchBusy(false); await load() }
    }
  }
  async function removeSelected() {
    setBusy(true); setError('')
    try {
      const response = await request('/api/admin/free-api-worker/remove', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], confirmed: true }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Removal unavailable')
      setSelected(new Set()); setConfirming(false); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Removal unavailable') }
    finally { setBusy(false) }
  }
  async function moveToFailed() {
    if (!owner || processing.current) return
    setBusy(true); setFailedNotice('')
    try {
      const response = await request('/api/admin/free-api-worker/failed', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'move', ids: [...selected], confirmed: true }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Move unavailable')
      setFailedNotice(`${body.moved} candidates moved to Failed APIs. Drafts and saved evidence retained.`)
      setMovingFailed(false); setSelected(new Set()); await load()
    } catch (cause) { setFailedNotice(cause instanceof Error ? cause.message : 'Move unavailable') }
    finally { setBusy(false) }
  }
  async function recheckSelected() {
    if (!owner || processing.current) return
    const ids = [...selected], authorizedWallet = wallet
    let checked = 0, recovered = 0, unresolved = 0
    processing.current = true; setBusy(true)
    try {
      for (const id of ids) {
        if (!mounted.current || liveWallet.current !== authorizedWallet) break
        setFailedNotice(`Rechecking ${checked + 1} / ${ids.length} · Recovered: ${recovered} · Unresolved: ${unresolved}`)
        const response = await request('/api/admin/free-api-worker/failed', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'recheck', ids: [id], confirmed: true }) })
        const body = await response.json()
        if ([401, 403].includes(response.status)) throw new Error(body.error ?? 'Owner session required')
        checked++; if (response.ok && body.recovered) recovered++; else unresolved++
      }
      if (mounted.current) setFailedNotice(`Recheck complete: ${checked} checked · ${recovered} recovered · ${unresolved} unresolved. No APIs published. See saved details; interrupted requests may be retried manually after the current request finishes.`)
    } catch (cause) {
      if (mounted.current) setFailedNotice((cause instanceof Error ? cause.message : 'Recheck interrupted') + '. Saved state is retained. Rechecks do not restart automatically.')
    } finally {
      processing.current = false
      if (mounted.current) { setBusy(false); await load() }
    }
  }
  async function control(action: 'start' | 'stop' | 'resume') {
    setBusy(true); setError('')
    try {
      const response = await request('/api/admin/free-api-worker/control', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Control unavailable')
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Control unavailable') }
    finally { setBusy(false) }
  }
  return <main className={styles.main}>
    <div className={styles.header}><div><h1>Free API Worker</h1><p>Discover · Validate · Ready to List</p></div>
      <div className={styles.controls}>{(['start', 'stop', 'resume'] as const).map(action => <button key={action}
        disabled={busy || batchBusy || !!publishing || !owner || (action === 'stop' ? data?.state.status !== 'running' : data?.state.status === 'running' || !!data?.progress.active)}
        onClick={() => void control(action)}>{action[0].toUpperCase() + action.slice(1)}</button>)}</div></div>
    <p className={styles.note}>Ready to List contains free, working APIs prepared for the owner's decision. It does not establish paid resale rights or publish anything to the Marketplace.</p>
    {error && <p role="alert">{error}</p>}
    {data && <p aria-live="polite">{data.state.status} · {data.state.inventory?.sourceCount ?? data.summary.admitted} existing inventory · {data.summary.functional} functional · {data.summary.usable} Ready to List</p>}
    {data && <p aria-live="polite">{data.progress.completed} / {data.progress.total} records completed · {data.progress.unfinished} unfinished · {data.progress.active} in flight · Batches of 50</p>}
    {data?.state.discovery && <p className={styles.note}>Discovery: {Object.values(data.state.discovery.stats).reduce((total, source) => total + source.admitted, 0)} new candidates this pass{data.state.discovery.refreshAt ? ` · Next source refresh: ${new Date(data.state.discovery.refreshAt).toLocaleString()}` : ' · Processing configured sources'}</p>}
    {data?.state.error && <p role="status">{data.state.error}</p>}
    {data?.state.status === 'stopped' && <p className={styles.note}>Resume continues unfinished work after active requests finish. Saved completed evaluations are retained. Provider pauses are respected.</p>}
    {data?.state.status === 'stopped' && data.nextRetry && <p className={styles.note}>Next saved retry: {new Date(data.nextRetry).toLocaleString()}</p>}
    <div className={styles.filters}><label>View <select aria-label="View" value={view} onChange={event => { setView(event.target.value); setPage(1) }}>
      <option value="usable">Ready to List</option><option value="failed">Failed APIs</option><option value="all">All candidates and evidence</option></select></label>
      <label>Search <input value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder="API or provider" /></label></div>
    <div className={styles.controls}>
      <span>{selected.size} selected on this page</span>
      <button disabled={!owner || busy || batchBusy || !!publishing || !selected.size || !['usable', 'failed'].includes(view)} onClick={() => setConfirming(true)}>Remove Selected</button>
      {view === 'usable' && <button disabled={!owner || busy || batchBusy || !!publishing || confirming || !selected.size} onClick={() => setMovingFailed(true)}>Move to Failed</button>}
      {view === 'failed' && <button disabled={!owner || busy || batchBusy || confirming || !selected.size} onClick={() => void recheckSelected()}>Recheck Failed</button>}
      <button disabled={!owner || busy || batchBusy || !!publishing || confirming || !selected.size || !!unfinished || view !== 'usable'} onClick={() => setPublishing((data?.candidates ?? []).filter(row => selected.has(row.lead.id)))}>Bulk List</button>
    </div>
    {failedNotice && <p role="status">{failedNotice}</p>}
    {view === 'failed' && <p className={styles.note}>Only manually moved candidates appear here. Recheck refreshes selected evidence without publication or automatic retries.</p>}
    {movingFailed && <div role="alertdialog" aria-modal="false" aria-labelledby="failed-title" className={styles.confirm}>
      <h2 id="failed-title">Move {selected.size} selected candidates to Failed APIs?</h2>
      <p>They will leave Ready to List. Existing drafts, latest Bulk List errors and validation evidence are retained.</p>
      <div className={styles.controls}><button autoFocus disabled={busy} onClick={() => setMovingFailed(false)}>Cancel</button>
        <button disabled={busy} onClick={() => void moveToFailed()}>Confirm move to Failed</button></div>
    </div>}
    {publishing && <BulkList candidates={publishing} onClose={() => setPublishing(null)} onSaved={saved => { setPublishing(null); void runSavedBatch(saved) }} />}
    {batch && <BulkProgressPanel batch={batch} busy={batchBusy || busy || movingFailed || !owner} notice={batchNotice}
      onResume={() => { void runSavedBatch(batch) }} onRetry={() => { void runSavedBatch(batch, true) }} />}
    {confirming && <div role="alertdialog" aria-modal="false" aria-labelledby="remove-title" className={styles.confirm}>
      <h2 id="remove-title">Remove {selected.size} selected candidates?</h2>
      <p>They will stay out of Ready to List on future runs. Saved evidence and Marketplace products are preserved.</p>
      <div className={styles.controls}><button autoFocus disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        <button disabled={busy} onClick={() => void removeSelected()}>Confirm removal</button></div>
    </div>}
    <CandidateTable candidates={data?.candidates ?? []} showEvidence={view !== 'usable'} selected={selected}
      selectable={owner && ['usable', 'failed'].includes(view) && !busy && !batchBusy && !confirming && !movingFailed && !publishing}
      onSelection={setSelected} />
    {data?.total === 0 && <p>No candidates in this view.</p>}
    <div className={styles.controls}><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
      <span>Page {page} · {data?.total ?? 0} results</span><button disabled={!data || page * data.pageSize >= data.total} onClick={() => setPage(p => p + 1)}>Next</button></div>
  </main>
}

export function CandidateTable({ candidates, showEvidence = false, selected = new Set<string>(), selectable = false, onSelection }: {
  candidates: Candidate[]; showEvidence?: boolean; selected?: Set<string>; selectable?: boolean; onSelection?: (ids: Set<string>) => void
}) {
  const allSelected = candidates.length > 0 && candidates.every(row => selected.has(row.lead.id))
  return <div className={styles.scroll}><table><thead><tr>
    <th><input type="checkbox" aria-label="Select all visible filtered candidates" disabled={!selectable || !candidates.length}
      checked={allSelected} onChange={event => onSelection?.(new Set(event.target.checked ? candidates.map(row => row.lead.id) : []))} /></th>
    <th>API</th><th>Working endpoint</th><th>Source / docs</th><th>Last successful validation</th><th>Details</th>
  </tr></thead><tbody>{candidates.map(({ lead, result, attempts, listingId, publishedAt, manualFailedAt, failureReason, recheckUntil, recheckResult }) => <tr key={lead.id}>
    <td><input type="checkbox" aria-label={`Select ${lead.name}`} disabled={!selectable} checked={selected.has(lead.id)}
      onChange={event => { const next = new Set(selected); if (event.target.checked) next.add(lead.id); else next.delete(lead.id); onSelection?.(next) }} /></td>
    <td><strong>{lead.name}</strong><small>{lead.providerId}</small></td>
    <td>{result?.endpoint ? <a href={result.endpoint} target="_blank" rel="noreferrer">{result.endpoint}</a> : '—'}</td>
    <td><a href={lead.docs} target="_blank" rel="noreferrer">Documentation</a>{lead.sources.map(source => <small key={source}>
      <a href={source} target="_blank" rel="noreferrer">Source</a></small>)}</td>
    <td>{result?.lastSuccess ? new Date(result.lastSuccess).toLocaleString() : '—'}</td>
    <td><details><summary>Saved evidence</summary>
      <p>Technical: {result?.technical ?? 'Pending'} · Free access: {result?.freeAccess ?? 'UNVERIFIED'} · Attempts: {attempts}</p>
      <p>{result?.reason}</p>
      {manualFailedAt && <p>Manually moved to Failed APIs: {new Date(manualFailedAt).toLocaleString()}</p>}
      {failureReason && <p>Latest saved error / outcome: {failureReason}</p>}
      {recheckUntil && Date.parse(recheckUntil) > Date.now() && <p>Recheck processing. Saved results will appear here.</p>}
      {recheckResult?.validation && <details><summary>Latest recheck evidence</summary>
        <p>{recheckResult.validation.reason} · {recheckResult.validation.freeAccess} · {recheckResult.validation.permission}</p>
        {recheckResult.validation.endpoint && <p>Checked endpoint: {recheckResult.validation.endpoint}</p>}
        {recheckResult.validation.tests.map((test, index) => <p key={index}>{test.url} · {test.status ?? 'No response'} · {test.reason}</p>)}
        {recheckResult.validation.evidence.map((evidence, index) => <p key={index}>{evidence.url} · {evidence.note} · SHA256: {evidence.sha256}</p>)}
      </details>}
      {listingId && <p>Marketplace listing: {listingId} · {publishedAt ? `Published ${new Date(publishedAt).toLocaleString()}` : 'Prepared draft'}</p>}
      {showEvidence && <p>Commercial permission: {result?.permission ?? 'UNKNOWN'}</p>}
      {result && <>
        <p>Terms review: {result.termsChecked ? 'Completed; see saved findings below' : 'Incomplete'}. Internal preparation does not establish paid resale rights.</p>
        <a href={result.docs} target="_blank" rel="noreferrer">Validation source</a>
        {result.evidence.map((evidence, index) => <p key={index}><a href={evidence.url} target="_blank" rel="noreferrer">Evidence page</a>
          <small>{evidence.note}</small><small>{evidence.checkedAt} · SHA256: {evidence.sha256}</small></p>)}
        {result.tests.map((test, index) => <p key={index}><small>{test.url} · {test.status ?? 'No response'} · {test.reason} · SHA256: {test.sha256 ?? '—'}</small></p>)}
      </>}
    </details></td>
  </tr>)}</tbody></table></div>
}
