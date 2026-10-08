'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import { outreachStatuses, type OutreachDashboardDto, type OutreachLeadDto, type OutreachStatus } from '@/lib/admin-outreach/types'
import { ProviderMessageId } from './provider-message-id'
import styles from './outreach.module.css'

const labels: Record<OutreachStatus, string> = {
  contact_ready: 'Contact Ready', draft: 'Drafts', sent: 'Sent', needs_reply: 'Needs Reply',
  interested: 'Interested', rejected: 'Rejected', do_not_contact: 'Do Not Contact', closed: 'Closed',
}

const manualTransitions: Record<OutreachStatus, OutreachStatus[]> = {
  contact_ready: ['do_not_contact', 'closed'],
  draft: ['contact_ready', 'do_not_contact', 'closed'],
  sent: ['needs_reply', 'interested', 'rejected', 'do_not_contact', 'closed'],
  needs_reply: ['sent', 'interested', 'rejected', 'do_not_contact', 'closed'],
  interested: ['needs_reply', 'rejected', 'do_not_contact', 'closed'],
  rejected: ['do_not_contact', 'closed'], do_not_contact: [], closed: [],
}

function timeLabel(value: string | null) {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time) : '—'
}

function LeadDetails({ lead }: { lead: OutreachLeadDto }) {
  const sentMessage = lead.history.find(message => message.status === 'sent' && message.provider_message_id)
  return <div className={styles.details}>
    <section><h3>Why it fits</h3><p>{lead.summary}</p><small>{lead.reason_codes.join(' · ') || 'No additional qualification codes.'}</small></section>
    <section><h3>Contact evidence</h3><p>{lead.preferred_email}</p>{lead.contact_evidence.map(item => <a key={`${item.type}:${item.value}`} href={item.source_url} target="_blank" rel="noopener noreferrer">{item.purpose} · {item.source_type}</a>)}</section>
    <section><h3>API information</h3>{lead.official_site && <a href={lead.official_site} target="_blank" rel="noopener noreferrer">Official site</a>}{lead.docs_url && <a href={lead.docs_url} target="_blank" rel="noopener noreferrer">Official docs</a>}{lead.github_url && <a href={lead.github_url} target="_blank" rel="noopener noreferrer">GitHub</a>}<p>{lead.traction_summary ?? 'No bounded activity summary available.'}</p></section>
    <ProviderMessageId value={sentMessage?.provider_message_id ?? null} className={styles.deliveryMetadata}/>
  </div>
}

export function OutreachClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<OutreachDashboardDto | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [filter, setFilter] = useState<OutreachStatus | 'contact_form_only'>('contact_ready')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await request('/api/admin/outreach', { cache: 'no-store' })
      if (!response.ok) throw new Error('Outreach data is temporarily unavailable.')
      setData(await response.json() as OutreachDashboardDto); setPhase('ready')
    } catch { setPhase('failed') }
  }, [request])

  useEffect(() => { void refresh() }, [refresh])
  const selected = data?.leads.find(lead => lead.id === selectedId) ?? null
  useEffect(() => {
    setSubject(selected?.draft?.subject ?? '')
    setBody(selected?.draft?.body ?? '')
  }, [selected?.draft?.id, selected?.draft?.subject, selected?.draft?.body])

  const visible = useMemo(() => data?.leads.filter(lead => lead.outreach_status === filter) ?? [], [data, filter])

  const mutate = useCallback(async (key: string, url: string, init: RequestInit) => {
    setBusy(key); setError(null)
    try {
      const response = await request(url, init)
      if (!response.ok) throw new Error('The outreach action could not be completed.')
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The outreach action could not be completed.') }
    finally { setBusy(null) }
  }, [refresh, request])

  const generate = (lead: OutreachLeadDto) => mutate(`generate:${lead.id}`, '/api/admin/outreach/drafts', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leadId: lead.id }),
  })
  const save = (lead: OutreachLeadDto) => lead.draft && mutate(`save:${lead.id}`, `/api/admin/outreach/drafts/${lead.draft.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject, body }),
  })
  const approve = (lead: OutreachLeadDto) => lead.draft && mutate(`approve:${lead.id}`, `/api/admin/outreach/drafts/${lead.draft.id}/approve`, { method: 'POST' })
  const sendApproved = (lead: OutreachLeadDto) => lead.draft && mutate(`send:${lead.id}`, `/api/admin/outreach/drafts/${lead.draft.id}/send`, { method: 'POST' })
  const setStatus = (lead: OutreachLeadDto, status: OutreachStatus) => mutate(`status:${lead.id}`, '/api/admin/outreach/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leadId: lead.id, status }),
  })

  return <div className={styles.page}>
    <header className={styles.heading}><div><span>Manual outreach workflow</span><h1>Outreach</h1><p>Review verified leads, prepare a concise draft, and approve it manually. No email is sent automatically.</p></div><strong>Sender: support@mahshar.xyz</strong></header>
    <div className={styles.notice}>{data?.transport.outbound === 'configured'
      ? <><strong>Manual send only.</strong> Every email requires an Admin to review and click Approve &amp; Send. Inbound reply ingestion is not configured.</>
      : <><strong>Mail transport not configured.</strong> Approved messages stop at Ready to send. Inbound reply ingestion is not configured.</>}</div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    <nav className={styles.tabs} aria-label="Outreach status">
      {outreachStatuses.map(status => <button key={status} type="button" className={filter === status ? styles.activeTab : ''} onClick={() => { setFilter(status); setSelectedId(null) }}>{labels[status]} <small>{data?.counts[status] ?? '—'}</small></button>)}
      <button type="button" className={filter === 'contact_form_only' ? styles.activeTab : ''} onClick={() => { setFilter('contact_form_only'); setSelectedId(null) }}>Contact Form Only <small>{data?.counts.contact_form_only ?? '—'}</small></button>
    </nav>

    <section className={styles.panel}>
      {phase === 'loading' ? <div className={styles.empty}>Loading outreach leads…</div>
        : phase === 'failed' ? <div className={styles.empty} role="alert">Outreach data is temporarily unavailable.</div>
          : filter === 'contact_form_only' ? <div className={styles.tableViewport}><table><thead><tr><th>Provider</th><th>API</th><th>Fit</th><th>Official contact</th></tr></thead><tbody>{data?.contact_form_only.map(lead => <tr key={lead.id}><td>{lead.provider}</td><td>{lead.product}</td><td>{lead.fit_score}</td><td>{lead.official_contact_url ? <a href={lead.official_contact_url} target="_blank" rel="noopener noreferrer">Open form</a> : '—'}</td></tr>)}</tbody></table>{data?.contact_form_only.length === 0 && <div className={styles.empty}>No contact-form-only leads.</div>}</div>
            : <div className={styles.tableViewport}><table><thead><tr><th>Provider</th><th>API</th><th>Fit</th><th>Email</th><th>Official contact</th><th>Status</th><th>Last outreach / reply</th><th>Actions</th></tr></thead><tbody>{visible.map(lead => <Fragment key={lead.id}><tr><td>{lead.provider}</td><td>{lead.product}</td><td>{lead.fit_score}</td><td>{lead.preferred_email}</td><td>{lead.official_contact_url ? <a href={lead.official_contact_url} target="_blank" rel="noopener noreferrer">Open</a> : '—'}</td><td><select aria-label={`Outreach status for ${lead.provider}`} value={lead.outreach_status} disabled={busy !== null || manualTransitions[lead.outreach_status].length === 0} onChange={event => void setStatus(lead, event.target.value as OutreachStatus)}><option value={lead.outreach_status}>{labels[lead.outreach_status]}</option>{manualTransitions[lead.outreach_status].map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></td><td>{timeLabel(lead.last_reply_at ?? lead.last_outreach_at)}</td><td><div className={styles.actions}><button type="button" onClick={() => setSelectedId(selectedId === lead.id ? null : lead.id)}>{selectedId === lead.id ? 'Close' : 'Review'}</button>{lead.outreach_status === 'contact_ready' && <button type="button" disabled={busy !== null} onClick={() => void generate(lead)}>Generate Draft</button>}<button type="button" className={styles.danger} disabled={busy !== null} onClick={() => void setStatus(lead, 'do_not_contact')}>DNC</button></div></td></tr>{selectedId === lead.id && <tr className={styles.detailRow}><td colSpan={8}><LeadDetails lead={lead}/>{lead.draft && <div className={styles.editor}><label>Subject<input value={subject} maxLength={200} disabled={lead.draft.status !== 'draft'} onChange={event => setSubject(event.target.value)}/></label><label>Body<textarea value={body} maxLength={5000} rows={12} disabled={lead.draft.status !== 'draft'} onChange={event => setBody(event.target.value)}/></label><div className={styles.editorActions}>{lead.draft.status === 'draft' ? <><button type="button" disabled={busy !== null || !subject.trim() || !body.trim()} onClick={() => void save(lead)}>Save edits</button><button type="button" disabled={busy !== null || !subject.trim() || !body.trim()} onClick={() => void approve(lead)}>{data?.transport.outbound === 'configured' ? 'Approve & Send' : 'Approve — Ready to send'}</button></> : data?.transport.outbound === 'configured' ? <button type="button" disabled={busy !== null} onClick={() => void sendApproved(lead)}>Send approved email</button> : <strong>Approved and ready to send · transport required</strong>}<button type="button" className={styles.danger} disabled={busy !== null} onClick={() => void setStatus(lead, 'do_not_contact')}>Do Not Contact</button><button type="button" disabled={busy !== null} onClick={() => void setStatus(lead, 'closed')}>Close</button></div></div>}</td></tr>}</Fragment>)}</tbody></table>{visible.length === 0 && <div className={styles.empty}>No leads in this state.</div>}</div>}
    </section>
  </div>
}
