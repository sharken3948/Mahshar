'use client'
import { useState } from 'react'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import type { Candidate } from '@/lib/free-api-worker/model'
import styles from './worker.module.css'

type Outcome = { id: string; listingId?: string; url?: string; success: boolean; error?: string; retryAfter?: number }
export function BulkList({ candidates, onClose, onComplete }: { candidates: Candidate[]; onClose: () => void; onComplete: () => Promise<void> }) {
  const { request } = useMarketplaceSession()
  const [mode, setMode] = useState('FREE'), [price, setPrice] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [outcomes, setOutcomes] = useState<Outcome[]>([]), [notice, setNotice] = useState('')
  const validPrice = mode === 'FREE' || /^\d+(?:\.\d{1,6})?$/.test(price) && Number(price) > 0 && Number(price) < 10000
  async function publish() {
    if (mode === 'PAID' && !rightsConfirmed) return
    setBusy(true); setNotice('Publishing through Seller…')
    const completed = new Map(outcomes.filter(item => item.success).map(item => [item.id, item]))
    const pending = candidates.filter(row => !completed.has(row.lead.id))
    try {
      for (let offset = 0; offset < pending.length; offset += 5) {
        let ids = pending.slice(offset, offset + 5).map(row => row.lead.id)
        for (let attempt = 0; attempt < 2 && ids.length; attempt++) {
          const response = await request('/api/admin/free-api-worker/list', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids, mode, price: mode === 'FREE' ? 0 : Number(price), confirmed: true,
              owner_rights_confirmed: mode === 'PAID' && rightsConfirmed }) })
          const body = await response.json()
          if (!response.ok) throw new Error(body.error ?? 'Publication unavailable')
          const results = body.results as Outcome[]
          for (const result of results) completed.set(result.id, result)
          setOutcomes([...completed.values()]); await onComplete()
          const limited = results.filter(row => !row.success && row.retryAfter)
          ids = limited.map(row => row.id)
          if (ids.length && attempt === 0) {
            const seconds = Math.max(...limited.map(row => row.retryAfter!))
            setNotice(`Seller request limit: continuing after ${seconds} seconds. Completed listings are saved.`)
            await new Promise(resolve => window.setTimeout(resolve, seconds * 1000))
            setNotice('Publishing through Seller…')
          }
        }
      }
      setNotice('Processing finished. Unpublished candidates remain available for retry.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Publication interrupted. Retry reconciles saved listings.') }
    finally { setBusy(false); await onComplete() }
  }
  const successes = outcomes.filter(item => item.success).length
  return <section role="dialog" aria-modal="false" aria-labelledby="bulk-list-title" className={styles.confirm}>
    <h2 id="bulk-list-title">List {candidates.length} selected APIs</h2>
    <p>Owner: 0x540a0027509b1c9aa0a2c5c65491cc97083e16de</p>
    <label htmlFor="bulk-publication-mode">Publication </label>
    <select id="bulk-publication-mode" disabled={busy || !!outcomes.length} value={mode} onChange={event => { setMode(event.target.value); setRightsConfirmed(false) }}>
      <option value="FREE">FREE</option><option value="PAID">PAID</option></select>
    {mode === 'PAID' && <label> USDC per API call <input type="number" min="0.000001" max="9999.999999" step="0.000001"
      disabled={busy || !!outcomes.length} value={price} onChange={event => setPrice(event.target.value)} /></label>}
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
      <button disabled={busy} onClick={onClose}>{outcomes.length ? 'Close' : 'Cancel'}</button>
      <button disabled={busy || !validPrice || mode === 'PAID' && !rightsConfirmed || successes === candidates.length} onClick={() => void publish()}>
        {busy ? 'Publishing…' : outcomes.length ? 'Retry unpublished APIs' : 'Confirm publication'}</button>
    </div>
    <p role="status">{notice} {outcomes.length > 0 && `${successes} published · ${outcomes.filter(item => !item.success).length} unsuccessful · ${candidates.length - outcomes.length} unprocessed`}</p>
    {outcomes.map(item => <p key={item.id}>{candidates.find(row => row.lead.id === item.id)?.lead.name}: {item.success
      ? <a href={item.url}>Published · {item.listingId}</a> : item.error}</p>)}
  </section>
}
