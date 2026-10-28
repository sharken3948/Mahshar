'use client'
import { useState } from 'react'
import { bulkCounts, type BulkProgress } from '@/lib/free-api-worker/bulk-progress'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import type { Candidate } from '@/lib/free-api-worker/model'
import styles from './worker.module.css'

export function BulkList({ candidates, onClose, onSaved }: { candidates: Candidate[]; onClose: () => void; onSaved: (batch: BulkProgress) => void }) {
  const { request } = useMarketplaceSession()
  const [mode, setMode] = useState('FREE'), [price, setPrice] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [batchId] = useState(() => crypto.randomUUID())
  const validPrice = mode === 'FREE' || /^\d+(?:\.\d{1,6})?$/.test(price) && Number(price) > 0 && Number(price) < 10000
  async function publish() {
    if (busy || mode === 'PAID' && !rightsConfirmed) return
    setBusy(true); setNotice('Saving your authorized selection…')
    try {
      const response = await request('/api/admin/free-api-worker/batches', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: batchId, ids: candidates.map(row => row.lead.id), mode,
          price: mode === 'FREE' ? 0 : Number(price), confirmed: true, owner_rights_confirmed: mode === 'PAID' && rightsConfirmed }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Selection could not be saved')
      onSaved(body.batch)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Selection could not be confirmed. Reopen to check saved progress.') }
    finally { setBusy(false) }
  }
  return <section role="dialog" aria-modal="false" aria-labelledby="bulk-list-title" className={styles.confirm}>
    <h2 id="bulk-list-title">List {candidates.length} selected APIs</h2>
    <p>Owner: 0x540a0027509b1c9aa0a2c5c65491cc97083e16de</p>
    <label htmlFor="bulk-publication-mode">Publication </label>
    <select id="bulk-publication-mode" disabled={busy} value={mode} onChange={event => { setMode(event.target.value); setRightsConfirmed(false) }}>
      <option value="FREE">FREE</option><option value="PAID">PAID</option></select>
    {mode === 'PAID' && <label> USDC per API call <input type="number" min="0.000001" max="9999.999999" step="0.000001"
      disabled={busy} value={price} onChange={event => setPrice(event.target.value)} /></label>}
    <p>{mode === 'FREE' ? 'No payment per call.' : `${price || '—'} USDC per call for each API.`} Missing permission is not a prohibition or authorization for paid resale.</p>
    {mode === 'PAID' && <>
      <label><input type="checkbox" checked={rightsConfirmed} disabled={busy}
        onChange={event => setRightsConfirmed(event.target.checked)} /> I have reviewed and established the necessary rights for paid proxy/resale access to each selected API, including applicable provider restrictions.</label>
      <p>This records your confirmation; it does not change the saved provider permission classification or mean the Worker verified those rights.</p>
    </>}
    <ul>{candidates.map(row => <li key={row.lead.id}>{row.lead.name} · {row.result?.endpoint}
      <details><summary>Saved rights evidence</summary>
        <p>{row.result?.reason}</p>
        {row.result?.evidence.length ? row.result.evidence.map((item, index) => <p key={index}>
          <a href={item.url} target="_blank" rel="noreferrer">Source</a> · {item.note}</p>) : <p>No saved rights evidence. Missing evidence is not verified permission.</p>}
      </details>
    </li>)}</ul>
    <div className={styles.controls}>
      <button disabled={busy} onClick={onClose}>Cancel</button>
      <button disabled={busy || !validPrice || mode === 'PAID' && !rightsConfirmed} onClick={() => void publish()}>
        {busy ? 'Saving selection…' : 'Confirm publication'}</button>
    </div>
    <p role="status">{notice}</p>
  </section>
}

export function BulkProgressPanel({ batch, busy, notice, onResume, onRetry }: {
  batch: BulkProgress; busy: boolean; notice: string; onResume: () => void; onRetry: () => void
}) {
  const counts = bulkCounts(batch)
  return <section className={styles.confirm} aria-label="Saved Bulk List progress">
    <h2>Bulk List progress</h2>
    <p>{batch.mode} · {batch.price} USDC per call · {batch.items.length} authorized APIs</p>
    <p role="status">Published: {counts.published} · Failed: {counts.failed} · Processing: {counts.processing} · Remaining: {counts.remaining}</p>
    <p>Selection and progress are saved. If this page closes, reopen it and choose Resume. Completed listings and saved reviews are retained.</p>
    {batch.retry_at && Date.parse(batch.retry_at) > Date.now() && <p>Seller request limit: next attempt after {new Date(batch.retry_at).toLocaleString()}.</p>}
    {notice && <p role="status">{notice}</p>}
    <div className={styles.controls}>
      <button disabled={busy || !counts.remaining && !counts.processing} onClick={onResume}>{busy ? 'Processing…' : 'Resume remaining'}</button>
      <button disabled={busy || !!counts.processing || !counts.failed} onClick={onRetry}>Retry failed APIs</button>
    </div>
    <ul>{batch.items.map(item => <li key={item.candidate_id}>
      {item.name}: {item.status} · {item.stage}
      {item.listing_id && <> · Listing {item.listing_id}</>}
      {item.last_error && <p>{item.last_error}</p>}
    </li>)}</ul>
  </section>
}
