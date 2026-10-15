'use client'

import { useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { WorkerActivity, WorkerActivityHistory, WorkerDashboard, WorkerProviderDetail, WorkerInvitation, WorkerContactRoute } from '@/lib/admin-worker/dashboard-types'
import { contactCoverageLabel } from '@/lib/admin-worker/contact-coverage'
import type { WorkerStatusDto } from '@/lib/admin-worker/types'
import { CompactRecords } from './compact-records'
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

function contactUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch { return null }
}

export function ContactChannels({ contacts }: { contacts: WorkerContactRoute[] }) {
  return <section><h3>Saved contact channels</h3><p>Published contact details do not grant permission to send. Forms require manual review; no form is submitted here.</p>
    {!contacts.length && <p>No saved contact channels on this page.</p>}
    <CompactRecords records={contacts} label="Saved contact channels">{visible => visible.map(contact => {
      const url = contactUrl(contact.type === 'email' ? contact.source_url : contact.value)
      const label = contact.type === 'email' ? 'Verified email' : contact.form_state === 'available'
        ? 'Official form available' : contact.form_state === 'manual_required' ? 'CAPTCHA / manual review required' : 'Official contact page · form not confirmed'
      return <article key={contact.id} className={styles.invitation}><h4>{label} · {contact.purpose}</h4>
        <p>{contact.value}</p>{url && <a href={url} target="_blank" rel="noopener noreferrer">{contact.form_state ? 'Open official form' : 'View official source'}</a>}
        <p>Verified: {time(contact.verified_at)}</p></article>
    })}</CompactRecords>
  </section>
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
  const [selectedEvent, setSelectedEvent] = useState<WorkerActivity | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState(false)
  useEffect(() => { if (selection && !dialog.current?.open) dialog.current?.showModal() }, [selection])
  useEffect(() => () => { generation.current++ }, [])

  async function view(id: string, detailPage = 0, event: WorkerActivity | null = null) {
    const version = ++generation.current
    setSelection(id); setSelectedEvent(event); setDetail(null); setLoading(true); setError(false)
    setTimelineError(false); setTimelineLoading(false)
    try {
      const response = await request(`/api/admin/worker/providers/${encodeURIComponent(id)}?page=${detailPage}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('unavailable')
      const value = await response.json() as WorkerProviderDetail
      if (version === generation.current) setDetail(value)
    } catch { if (version === generation.current) setError(true) }
    finally { if (version === generation.current) setLoading(false) }
  }
  function close() { generation.current++; dialog.current?.close(); setSelection(null); setDetail(null); setSelectedEvent(null) }
  function viewEvent(event: WorkerActivity) {
    if (event.provider_id) { void view(event.provider_id, 0, event); return }
    generation.current++; setSelection(event.id); setSelectedEvent(event); setDetail(null); setLoading(false); setError(false)
  }
  async function olderProviderActivity() {
    if (!detail?.activity.next_cursor || timelineLoading) return
    const version = generation.current
    const { at, id } = detail.activity.next_cursor
    setTimelineLoading(true); setTimelineError(false)
    try {
      const response = await request(`/api/admin/worker/activity?${new URLSearchParams({ provider: detail.provider.id, before: at, id })}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('unavailable')
      const value = await response.json() as WorkerActivityHistory
      if (generation.current === version) setDetail(current => current && ({ ...current, activity: {
        events: [...current.activity.events, ...value.events], next_cursor: value.next_cursor,
      } }))
    } catch { if (generation.current === version) setTimelineError(true) }
    finally { if (generation.current === version) setTimelineLoading(false) }
  }
  const metrics = dashboard?.metrics
  const cards = [
    { name: 'APIs Found', value: metrics?.found, note: 'Distinct discovered providers' },
    { name: 'Qualified APIs', value: metrics?.qualified, note: 'Providers with a qualified API' },
    { name: 'Invitations Prepared', value: metrics?.prepared, note: 'Recorded Groq invitations · excludes mock and unknown-origin drafts' },
    { name: 'Invitations Sent', value: metrics?.sent, note: 'Real initial invitations accepted · excludes simulation' },
    { name: 'Replies Received', value: metrics?.replies, note: metrics ? `${metrics.inbound_received} inbound messages · provider sender identity unverified` : 'Verified provider reply count unavailable' },
  ]
  return <>
    <LiveActivity dashboard={dashboard} status={status} unavailable={unavailable} onView={viewEvent}/>
    <section className={styles.metricGrid} aria-label="Acquisition results">{cards.map(card => <article key={card.name}><span>{card.name}</span><strong>{card.value ?? '—'}</strong><small title={card.note}>{card.note}</small></article>)}</section>
    {unavailable && <div className={styles.warning} role="status">Acquisition results could not refresh. Available values are the last saved snapshot.</div>}
    <section className={styles.panel}>
      <header><div><span>Latest saved activity · each provider once</span><h2>Provider Activity</h2></div><small>{dashboard ? `${dashboard.total} providers` : 'Loading…'}</small></header>
      {!dashboard ? <div className={styles.empty}>{unavailable ? 'Provider activity unavailable.' : 'Loading providers…'}</div> : dashboard.providers.length === 0 ? <div className={styles.empty}>No providers on this page.</div> : <CompactRecords records={dashboard.providers} label="Provider activity on this page">{providers => <div className={`${styles.tableViewport} ${styles.providerViewport}`}><table className={styles.providerTable}>
        <thead><tr><th>Provider / API</th><th>Discovered</th><th>Qualification</th><th>Contact</th><th>Invitation</th><th>Action</th></tr></thead>
        <tbody>{providers.map(provider => <tr key={provider.id}>
          <td data-label="Provider / API"><strong>{provider.name}</strong><small>{provider.domain}</small></td>
          <td data-label="Discovered"><span>{time(provider.discovered_at)}</span><small>Latest: {time(provider.latest_activity_at)}</small></td>
          <td data-label="Qualification"><span className={styles.badge}>{provider.qualification}</span>{provider.reason && <small>{provider.reason}</small>}</td>
          <td data-label="Contact"><span>{provider.contact}</span></td>
          <td data-label="Invitation"><span>{provider.invitation}</span><small>{provider.delivery}</small></td>
          <td data-label="Action"><button type="button" className={styles.detailsButton} onClick={() => void view(provider.id)} aria-label={`View ${provider.name}`}>View</button></td>
        </tr>)}</tbody>
      </table></div>}</CompactRecords>}
      <div className={styles.pagination}><button className={styles.detailsButton} disabled={!dashboard || page === 0} onClick={() => onPage(page - 1)}>Previous</button><span>Page {page + 1}</span><button className={styles.detailsButton} disabled={!dashboard || (page + 1) * 25 >= dashboard.total} onClick={() => onPage(page + 1)}>Next</button></div>
    </section>
    <dialog ref={dialog} className={styles.invitationDialog} aria-labelledby="invitation-title" onCancel={event => { event.preventDefault(); close() }}>
      <header><div><span>Read-only saved records</span><h2 id="invitation-title">{detail?.provider.name ?? selectedEvent?.provider ?? 'Provider details'}</h2></div><button type="button" className={styles.detailsButton} onClick={close} autoFocus>Close</button></header>
      {selectedEvent && <article className={styles.invitation}><h3>{selectedEvent.stage ?? 'Saved activity'}</h3><p>{selectedEvent.label}</p><time dateTime={selectedEvent.at}>{time(selectedEvent.at)}</time></article>}
      {loading ? <p role="status">Loading saved invitations…</p> : error ? <p role="alert">Saved invitations are unavailable. Close and try again.</p> : detail && <>
        <p>{detail.provider.qualification}{detail.provider.reason ? ` · ${detail.provider.reason}` : ''}</p>
        <p>{detail.provider.domain} · {detail.provider.invitation} · {detail.provider.delivery}</p>
        <p>Discovered: {time(detail.provider.discovered_at)} · {detail.provider.contact}</p>
        <ContactChannels contacts={detail.contacts ?? []}/>
        <h3>Saved activity timeline</h3>
        <CompactRecords records={detail.activity.events} label="Saved provider activity timeline">{events => <ul className={styles.detailTimeline}>{events.map(event => <li key={event.id}><strong>{event.stage ?? 'Saved activity'}</strong><p>{event.label}</p><time dateTime={event.at}>{time(event.at)}</time></li>)}</ul>}</CompactRecords>
        {!detail.activity.events.length && <p>No saved activity available.</p>}
        {detail.activity.next_cursor && <button type="button" className={styles.detailsButton} disabled={timelineLoading} onClick={() => void olderProviderActivity()}>{timelineLoading ? 'Loading…' : 'Load older provider activity'}</button>}
        {timelineError && <p role="alert">Older activity could not load. Try again.</p>}
        <h3>Saved research results</h3>
        {!detail.research.length && <p>No saved research results on this page.</p>}
        <CompactRecords records={detail.research} label="Saved provider research results">{research => research.map(result => <article key={result.id} className={styles.invitation}>
          <h3>{result.qualification}</h3><p>{result.summary ?? 'No qualification summary recorded.'}</p><p>Qualified: {time(result.qualified_at)}</p>
          <p>Contact: {contactCoverageLabel(result.contact_state, result.contact)} · {time(result.contact_researched_at)}{result.email ? ` · ${result.email}` : ''}</p>
          {result.traction && <p>{result.traction}</p>}
          {result.evidence.map(evidence => <div key={evidence.id}><strong>{evidence.role}</strong><p>{evidence.summary ?? 'No evidence summary recorded.'}</p><p>{evidence.url}</p><time dateTime={evidence.checked_at}>{time(evidence.checked_at)}</time></div>)}
        </article>)}</CompactRecords>
        <h3>Saved invitations and delivery</h3>
        {!detail.invitations.length && <p>No saved initial invitation on this page.</p>}
        <CompactRecords records={detail.invitations} label="Saved invitations">{invitations => invitations.map(invitation => <InvitationRecord key={`${invitation.source}:${invitation.id}`} invitation={invitation}/>)}</CompactRecords>
        <div className={styles.pagination}><button className={styles.detailsButton} disabled={detail.page === 0} onClick={() => void view(detail.provider.id, detail.page - 1, selectedEvent)}>Previous records</button><span>Page {detail.page + 1}</span><button className={styles.detailsButton} disabled={!detail.has_more} onClick={() => void view(detail.provider.id, detail.page + 1, selectedEvent)}>Next records</button></div>
      </>}
    </dialog>
  </>
}

export function confirmedActivityLabel(status: WorkerStatusDto | null, event?: WorkerActivity) {
  if (status?.acquisition?.running && status.acquisition.waiting) return 'Waiting'
  if (dashboardStatus(status) === 'Stopped') return 'Stopped'
  return event?.stage ? `Last confirmed: ${event.stage}` : 'Waiting for update'
}

export function LiveActivity({ dashboard, status, unavailable, onView }: {
  dashboard: WorkerDashboard | null; status: WorkerStatusDto | null; unavailable: boolean; onView: (event: WorkerActivity) => void
}) {
  const request = useAdminRequest()
  const generation = useRef(0)
  const [history, setHistory] = useState<WorkerActivityHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => () => { generation.current++ }, [])
  const latest = dashboard?.recent[0]
  const events = history?.events ?? dashboard?.recent.slice(0, 3) ?? []
  const provider = dashboard?.recent.find(event => event.provider_id)?.provider
  async function more() {
    const cursor = history?.next_cursor ?? dashboard?.activity_next_cursor
    if (!cursor || loading) return
    const version = ++generation.current
    const snapshot = history?.events ?? dashboard?.recent ?? []
    setLoading(true); setFailed(false)
    try {
      const response = await request(`/api/admin/worker/activity?${new URLSearchParams({ before: cursor.at, id: cursor.id })}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('unavailable')
      const value = await response.json() as WorkerActivityHistory
      if (generation.current === version) setHistory({ events: [...snapshot, ...value.events], next_cursor: value.next_cursor })
    } catch { if (generation.current === version) setFailed(true) }
    finally { if (generation.current === version) setLoading(false) }
  }
  function collapse() { generation.current++; setHistory(null); setLoading(false); setFailed(false) }
  return <section className={styles.panel} aria-label="Live Activity">
    <header><div><span>Persisted Worker activity</span><h2>Live Activity</h2></div><small>Refreshes every 12 seconds while visible</small></header>
    <div className={styles.currentActivity} aria-live="polite">
      <span>Current activity</span><strong>{confirmedActivityLabel(status, latest)}</strong>
      <span>Last confirmed provider / API</span><strong title={provider}>{provider ?? 'Waiting for update'}</strong>
      <small title={latest?.label}>{latest ? `${time(latest.at)} · ${latest.label}` : 'No confirmed activity available.'}</small>
      <small>Exact executing stage and provider are not recorded. Showing saved activity.</small>
    </div>
    {status?.status === 'stop_requested' && <p className={styles.warning} role="status">Stop requested · dispatched work may still finish.</p>}
    {status?.status === 'failed' && <p className={styles.error} role="alert">Worker error: {status.latest_run?.error_code ?? 'See run details.'}</p>}
    {unavailable && <p className={styles.warning} role="status">Activity refresh failed. Showing the last saved snapshot.</p>}
    <div className={history ? styles.historyViewport : undefined} role={history ? 'region' : undefined} aria-label={history ? 'Available activity history' : undefined} tabIndex={history ? 0 : undefined} id="worker-activity-history">
      <ul className={styles.activityList}>{events.map(event => <li key={event.id}>
        <div><strong title={event.provider}>{event.provider}</strong><span title={event.label}>{event.stage ? `${event.stage} · ` : ''}{event.label}</span></div>
        <time dateTime={event.at}>{time(event.at)}</time><button type="button" className={styles.detailsButton} onClick={() => onView(event)} aria-label={`View activity for ${event.provider}`}>View</button>
      </li>)}</ul>
    </div>
    <div className={styles.pagination}>
      <span>{history ? `${events.length} saved events loaded · history snapshot` : 'Latest three confirmed events'}</span>
      {(history ? history.next_cursor : dashboard?.activity_next_cursor) && <button type="button" className={styles.detailsButton} onClick={() => void more()} disabled={loading} aria-expanded={!!history} aria-controls="worker-activity-history">{loading ? 'Loading…' : history ? 'Load older events' : 'View All'}</button>}
      {history && <button type="button" className={styles.detailsButton} onClick={collapse}>Show Less</button>}
    </div>
    {failed && <p className={styles.warning} role="alert">Activity history could not load. Saved events remain available; try again.</p>}
  </section>
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
