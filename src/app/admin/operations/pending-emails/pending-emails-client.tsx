'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { PendingEmails } from '@/lib/admin-worker/mail-list-types'
import styles from '../operations.module.css'

export function PendingEmailsResults({ data, page, loading, marking, onMark }: {
  data: PendingEmails | null; page: number; loading: boolean; marking: string | null; onMark: (id: string) => void
}) {
  if (loading && !data) return <p role="status" className={styles.sectionMessage}>Loading pending emails…</p>
  if (!data) return <p className={styles.sectionMessage}>Pending emails are unavailable.</p>
  if (!data.items.length) return <p role="status" className={styles.sectionMessage}>No pending emails on this page.</p>
  return <div className={styles.tableViewport}><table className={`${styles.table} ${styles.pendingEmailsTable}`}>
    <thead><tr><th scope="col">No.</th><th scope="col">API Name</th><th scope="col">Email Address</th><th scope="col">Action</th></tr></thead>
    <tbody>{data.items.map((item, index) => <tr key={item.id}>
      <td data-label="No."><span>{(page - 1) * 25 + index + 1}</span></td>
      <td data-label="API Name"><strong>{item.apiName}</strong></td>
      <td data-label="Email Address"><span>{item.emailAddress}</span></td>
      <td data-label="Action"><button type="button" className={styles.rowButton} disabled={!!marking || loading}
        aria-label={`Mark ${item.apiName} as sent`} onClick={() => onMark(item.id)}>
        {marking === item.id ? 'Saving…' : 'Mark as Sent'}</button></td>
    </tr>)}</tbody>
  </table></div>
}

export function PendingEmailsClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<PendingEmails | null>(null)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [marking, setMarking] = useState<string | null>(null)
  const sequence = useRef(0)
  const markingRef = useRef(false)
  const cursor = cursors[cursors.length - 1]
  const load = useCallback(async () => {
    const version = ++sequence.current
    setLoading(true)
    try {
      const response = await request(`/api/admin/worker/mail-list${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('unavailable')
      const value = await response.json() as PendingEmails
      if (version !== sequence.current) return
      setData(value); setFailure(null)
    } catch {
      if (version === sequence.current) { setData(null); setFailure('Pending emails could not be loaded. Please retry.') }
    } finally { if (version === sequence.current) setLoading(false) }
  }, [cursor, request])
  useEffect(() => {
    void load()
    const refresh = () => { if (document.visibilityState === 'visible' && !markingRef.current) void load() }
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      sequence.current++; window.clearInterval(timer)
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  async function markSent(id: string) {
    if (markingRef.current) return
    markingRef.current = true; setMarking(id); setFailure(null)
    sequence.current++
    try {
      const response = await request(`/api/admin/worker/mail-list/${encodeURIComponent(id)}/mark-sent`, { method: 'POST' })
      if (!response.ok) throw new Error(response.status === 409 ? 'changed' : 'unavailable')
      const value = await response.json()
      if (value.status !== 'manual_sent') throw new Error('unavailable')
      if (cursor !== null) { setData(null); setCursors([null]) }
      else await load()
    } catch (error) {
      setFailure(error instanceof Error && error.message === 'changed'
        ? 'This entry is no longer eligible. Refresh the list.'
        : 'The update could not be confirmed. Retry safely; marking an email as sent is idempotent.')
    } finally { markingRef.current = false; setMarking(null) }
  }

  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>Admin only · Automation</span><h1>Pending Emails</h1>
        <p>Send emails externally, then mark them as sent here. This page never sends email.</p></div>
      <button type="button" className={styles.rowButton} disabled={loading || !!marking} onClick={() => void load()}>Refresh</button>
    </section>
    <p className={styles.probeNote}>Verified contact readiness does not establish outreach permission. Mark as Sent records your declaration, not verified delivery.</p>
    {failure && <div role="alert" className={styles.degradedBanner}>{failure}</div>}
    <section className={`${styles.panel} ${styles.operationsTablePanel}`} aria-label="Pending emails" aria-busy={loading}>
      <PendingEmailsResults data={data} page={cursors.length} loading={loading} marking={marking} onMark={id => void markSent(id)}/>
      <div className={styles.pagination}><span>Page {cursors.length}</span><div>
        <button type="button" className={styles.rowButton} disabled={cursors.length === 1 || loading || !!marking}
          onClick={() => { setData(null); setCursors(value => value.slice(0, -1)) }}>Previous</button>
        <button type="button" className={styles.rowButton} disabled={!data?.nextCursor || loading || !!marking}
          onClick={() => { if (data?.nextCursor) { setData(null); setCursors(value => [...value, data.nextCursor]) } }}>Next</button>
      </div></div>
    </section>
  </div>
}
