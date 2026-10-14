'use client'

import { useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { WorkerDashboard, WorkerProviderDetail, WorkerInvitation } from '@/lib/admin-worker/dashboard-types'
import type { WorkerStatusDto } from '@/lib/admin-worker/types'
import styles from './worker.module.css'

export function dashboardStatus(status: WorkerStatusDto | null): string {
  if (!status) return 'Unavailable'
  if (status.status === 'failed' && !status.acquisition?.running) return 'Error'
  if (status.acquisition?.running && status.acquisition.waiting) return 'Waiting'
  if (status.acquisition?.running || status.status === 'running' || status.status === 'stop_requested') return 'Running'
  return 'Stopped'
}

function time(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded'
}

export function DashboardContent({ dashboard, status, page, onPage, unavailable }: {
  dashboard: WorkerDashboard | null; status: WorkerStatusDto | null; page: number; onPage: (page: number) => void; unavailable: boolean
}) {
  const request = useAdminRequest()
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const [selection, setSelection] = useState<string | null>(null)
  const [detail, setDetail] = useState<WorkerProviderDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { if (selection && !dialog.current?.open) dialog.current?.showModal() }, [selection])
  useEffect(() => () => { generation.current++ }, [])

  async function view(id: string, detailPage = 0) {
    const version = ++generation.current
    setSelection(id); setDetail(null); setLoading(true); setError(false)
    try {
      const response = await request(`/api/admin/worker/providers/${encodeURIComponent(id)}?page=${detailPage}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('unavailable')
      const value = await response.json() as WorkerProviderDetail
      if (version === generation.current) setDetail(value)
    } catch { if (version === generation.current) setError(true) }
    finally { if (version === generation.current) setLoading(false) }
  }
  function close() { generation.current++; dialog.current?.close(); setSelection(null); setDetail(null) }
  const metrics = dashboard?.metrics
  const cards = [
    { name: 'APIs Found', value: metrics?.found, note: 'Distinct discovered providers' },
    { name: 'Qualified APIs', value: metrics?.qualified, note: 'Providers with a qualified API' },
    { name: 'Invitations Prepared', value: metrics?.prepared, note: 'Recorded Groq invitations · excludes mock and unknown-origin drafts' },
    { name: 'Invitations Sent', value: metrics?.sent, note: 'Real initial invitations accepted · excludes simulation' },
    { name: 'Replies Received', value: metrics?.replies, note: metrics ? `${metrics.inbound_received} inbound messages · provider sender identity unverified` : 'Verified provider reply count unavailable' },
  ]
  const activity = dashboard?.recent[0]
  const run = status?.latest_run
  return <>
    <div className={styles.currentActivity} aria-live="polite"><span>Last confirmed activity</span><strong>{activity ? `${activity.provider} · ${activity.label}` : 'No provider activity available'}</strong>
      <small>{status?.status === 'stop_requested' ? 'Stop requested · finishing dispatched work' : status?.acquisition?.waiting ? 'Waiting for the next bounded cloud batch' : activity ? time(activity.at) : 'Activity appears after it is saved'}</small></div>
    <section className={styles.metricGrid} aria-label="Acquisition results">{cards.map(card => <article key={card.name}><span>{card.name}</span><strong>{card.value ?? '—'}</strong><small>{card.note}</small></article>)}</section>
    {unavailable && <div className={styles.warning} role="status">Acquisition results could not refresh. Available values are the last saved snapshot.</div>}
    <section className={styles.panel}>
      <header><div><span>Saved provider outcomes</span><h2>Provider activity</h2></div><small>{dashboard ? `${dashboard.total} providers` : 'Loading…'}</small></header>
      {!dashboard ? <div className={styles.empty}>{unavailable ? 'Provider activity unavailable.' : 'Loading providers…'}</div> : dashboard.providers.length === 0 ? <div className={styles.empty}>No providers on this page.</div> : <div className={styles.tableViewport}><table className={styles.providerTable}>
        <thead><tr><th>Provider / API</th><th>Qualification</th><th>Invitation</th><th>Delivery</th><th>Action</th></tr></thead>
        <tbody>{dashboard.providers.map(provider => <tr key={provider.id}>
          <td data-label="Provider / API"><strong>{provider.name}</strong><small>{provider.domain}</small></td>
          <td data-label="Qualification"><span className={styles.badge}>{provider.qualification}</span>{provider.reason && <small>{provider.reason}</small>}</td>
          <td data-label="Invitation">{provider.invitation}</td><td data-label="Delivery">{provider.delivery}</td>
          <td data-label="Action"><button type="button" className={styles.detailsButton} onClick={() => void view(provider.id)} aria-label={`View ${provider.name}`}>View</button></td>
        </tr>)}</tbody>
      </table></div>}
      <div className={styles.pagination}><button className={styles.detailsButton} disabled={!dashboard || page === 0} onClick={() => onPage(page - 1)}>Previous</button><span>Page {page + 1}</span><button className={styles.detailsButton} disabled={!dashboard || (page + 1) * 25 >= dashboard.total} onClick={() => onPage(page + 1)}>Next</button></div>
    </section>
    <section className={styles.panel}><header><div><span>Persisted records · latest saved states</span><h2>Recent activity</h2></div></header><ul className={styles.activityList}>
      {run?.stopped_at && <li><div><strong>Worker stopped</strong><span>Last recorded run</span></div><time>{time(run.stopped_at)}</time></li>}
      {dashboard?.recent.map(event => <li key={event.id}><div><strong>{event.provider}</strong><span>{event.label}</span></div><time>{time(event.at)}</time></li>)}
      {!dashboard?.recent.length && !run?.stopped_at && <li>No confirmed activity available.</li>}
    </ul></section>
    <dialog ref={dialog} className={styles.invitationDialog} aria-labelledby="invitation-title" onCancel={event => { event.preventDefault(); close() }}>
      <header><div><span>Read-only saved records</span><h2 id="invitation-title">{detail?.provider.name ?? 'Provider details'}</h2></div><button type="button" className={styles.detailsButton} onClick={close} autoFocus>Close</button></header>
      {loading ? <p role="status">Loading saved invitations…</p> : error ? <p role="alert">Saved invitations are unavailable. Close and try again.</p> : detail && <>
        <p>{detail.provider.qualification}{detail.provider.reason ? ` · ${detail.provider.reason}` : ''}</p>
        {!detail.invitations.length && <p>No saved initial invitation on this page.</p>}
        {detail.invitations.map(invitation => <InvitationRecord key={`${invitation.source}:${invitation.id}`} invitation={invitation}/>)}
        <div className={styles.pagination}><button className={styles.detailsButton} disabled={detail.page === 0} onClick={() => void view(detail.provider.id, detail.page - 1)}>Previous records</button><span>Page {detail.page + 1}</span><button className={styles.detailsButton} disabled={!detail.has_more} onClick={() => void view(detail.provider.id, detail.page + 1)}>Next records</button></div>
      </>}
    </dialog>
  </>
}

export function InvitationRecord({ invitation }: { invitation: WorkerInvitation }) {
  return <article className={styles.invitation}>
          <div className={styles.invitationMeta}><span className={styles.badge}>{invitation.status}</span><span>{invitation.source === 'acquisition' ? 'Acquisition · mock transport only' : 'Admin Outreach'}</span></div>
          <dl><div><dt>Recipient</dt><dd>{invitation.recipient ?? 'Not recorded'}</dd></div>
            <div><dt>Generator</dt><dd>{invitation.generator === 'groq' ? 'Groq · recorded provenance' : 'Unknown · origin not recorded'}</dd></div>
            <div><dt>Prepared</dt><dd>{time(invitation.prepared_at)}{invitation.source === 'outreach' ? ' · original draft creation' : invitation.generator === 'groq' ? ' · draft checkpoint' : ' · exact preparation time unavailable'}</dd></div>
            <div><dt>Reserved</dt><dd>{time(invitation.reserved_at)}</dd></div><div><dt>{invitation.source === 'acquisition' ? 'Simulated dispatch' : 'Sent'}</dt><dd>{time(invitation.sent_at)}</dd></div><div><dt>Delivery</dt><dd>{invitation.delivery}</dd></div></dl>
          <h3>{invitation.subject}</h3><pre>{invitation.body}</pre>
          {invitation.events.length > 0 && <ul>{invitation.events.map((event, index) => <li key={index}>{event.label} · {time(event.at)}</li>)}</ul>}
        </article>
}
