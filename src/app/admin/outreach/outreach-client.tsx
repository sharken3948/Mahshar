'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import { type OutreachClassification, type OutreachDashboardDto, type OutreachInboxItemDto, type OutreachLeadDto, type OutreachStatus } from '@/lib/admin-outreach/types'
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

const classificationLabels: Record<OutreachClassification, string> = {
  interested: 'Interested', payment_question: 'Payment question', technical_question: 'Technical question',
  not_interested: 'Not interested', do_not_contact: 'Do not contact', other: 'Other',
}

type OutreachView = 'inbox' | OutreachStatus | 'contact_form_only'

const viewOrder: OutreachView[] = [
  'inbox', 'needs_reply', 'contact_ready', 'draft', 'sent', 'interested', 'rejected', 'do_not_contact', 'closed', 'contact_form_only',
]

function viewLabel(view: OutreachView) {
  if (view === 'inbox') return 'Inbox'
  if (view === 'contact_form_only') return 'Contact Form Only'
  return labels[view]
}

function timeLabel(value: string | null) {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time) : '—'
}

function LeadDetails({ lead }: { lead: OutreachLeadDto }) {
  const sentMessage = lead.history.find(message => message.status === 'sent' && message.provider_message_id)
  const history = [...lead.history].sort((left, right) => {
    const leftTime = Date.parse(left.received_at ?? left.sent_at ?? left.created_at)
    const rightTime = Date.parse(right.received_at ?? right.sent_at ?? right.created_at)
    return leftTime - rightTime || left.id.localeCompare(right.id)
  })
  const latestInbound = [...history].reverse().find(message => message.direction === 'inbound')
  return <>
    <div className={styles.details}>
      <section><h3>Why it fits</h3><p>{lead.summary}</p><small>{lead.reason_codes.join(' · ') || 'No additional qualification codes.'}</small></section>
      <section><h3>Contact evidence</h3><p>{lead.preferred_email}</p>{lead.contact_evidence.map(item => <a key={`${item.type}:${item.value}`} href={item.source_url} target="_blank" rel="noopener noreferrer">{item.purpose} · {item.source_type}</a>)}</section>
      <section><h3>API information</h3>{lead.official_site && <a href={lead.official_site} target="_blank" rel="noopener noreferrer">Official site</a>}{lead.docs_url && <a href={lead.docs_url} target="_blank" rel="noopener noreferrer">Official docs</a>}{lead.github_url && <a href={lead.github_url} target="_blank" rel="noopener noreferrer">GitHub</a>}<p>{lead.traction_summary ?? 'No bounded activity summary available.'}</p></section>
      <ProviderMessageId value={sentMessage?.provider_message_id ?? null} className={styles.deliveryMetadata}/>
      {latestInbound && <section><h3>Latest inbound reply</h3><strong className={styles.classification}>{latestInbound.classification ? classificationLabels[latestInbound.classification] : 'Processing'}</strong><p>{latestInbound.body}</p>{latestInbound.classification_reason && <small>{latestInbound.classification_reason}</small>}</section>}
    </div>
    {history.length > 0 && <section className={styles.conversation}><h3>Conversation history</h3>{history.map(message => <article key={message.id} className={message.direction === 'inbound' ? styles.incoming : styles.outgoing}><header><strong>{message.direction === 'inbound' ? 'Incoming · Provider' : 'Outgoing · Mahshar'}</strong><span>{timeLabel(message.received_at ?? message.sent_at ?? message.created_at)}</span>{message.classification && <small>{classificationLabels[message.classification]}</small>}</header><h4>{message.subject}</h4><p>{message.body}</p><ProviderMessageId value={message.provider_message_id} className={styles.messageId}/></article>)}</section>}
  </>
}

function InboxMessageDetails({ item }: { item: OutreachInboxItemDto }) {
  return <section className={styles.inboxDetails}>
    <header><div><span className={styles.incomingLabel}>Incoming</span><h3>{item.message.subject}</h3></div><span>{timeLabel(item.message.received_at ?? item.message.created_at)}</span></header>
    <dl><div><dt>From</dt><dd>{item.message.sender_email}</dd></div><div><dt>To</dt><dd>{item.message.recipient_email}</dd></div><div><dt>Match</dt><dd>{item.match_state === 'matched' ? 'Matched' : 'Unmatched'}</dd></div>{item.message.classification && <div><dt>Classification</dt><dd>{classificationLabels[item.message.classification]}</dd></div>}</dl>
    <p>{item.message.body}</p>
    {item.match_state === 'unmatched' && <div className={styles.readOnlyNotice}><strong>Unmatched · read-only</strong><span>This message is not attached to an Outreach thread. Reply and send actions are unavailable.</span></div>}
  </section>
}

export function OutreachClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<OutreachDashboardDto | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [filter, setFilter] = useState<OutreachView>('inbox')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null)
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

  const openInboxItem = (item: OutreachInboxItemDto) => {
    if (selectedInboxId === item.message.id) {
      setSelectedInboxId(null); setSelectedId(null); return
    }
    setSelectedInboxId(item.message.id)
    setSelectedId(item.lead_id && data?.leads.some(lead => lead.id === item.lead_id) ? item.lead_id : null)
  }

  const draftEditor = (lead: OutreachLeadDto) => {
    const reply = Boolean(lead.draft?.reply_to_message_id)
    const threadAllowsDraft = reply
      ? lead.outreach_status === 'needs_reply' || lead.outreach_status === 'interested'
      : lead.outreach_status === 'draft'
    if (!lead.draft || !threadAllowsDraft) return null
    return <div className={styles.editor}><h3>{reply ? 'Suggested reply draft' : 'Outreach draft'}</h3><label>Subject<input value={subject} maxLength={200} disabled={lead.draft.status !== 'draft'} onChange={event => setSubject(event.target.value)}/></label><label>Body<textarea value={body} maxLength={5000} rows={12} disabled={lead.draft.status !== 'draft'} onChange={event => setBody(event.target.value)}/></label><div className={styles.editorActions}>{lead.draft.status === 'draft' ? <><button type="button" disabled={busy !== null || !subject.trim() || !body.trim()} onClick={() => void save(lead)}>Save edits</button><button type="button" disabled={busy !== null || !subject.trim() || !body.trim()} onClick={() => void approve(lead)}>{data?.transport.outbound === 'configured' ? 'Approve & Send' : 'Approve — Ready to send'}</button></> : data?.transport.outbound === 'configured' ? <button type="button" disabled={busy !== null} onClick={() => void sendApproved(lead)}>Send approved email</button> : <strong>Approved and ready to send · transport required</strong>}<button type="button" className={styles.danger} disabled={busy !== null} onClick={() => void setStatus(lead, 'do_not_contact')}>Do Not Contact</button><button type="button" disabled={busy !== null} onClick={() => void setStatus(lead, 'closed')}>Close</button></div></div>
  }

  return <div className={styles.page}>
    <header className={styles.heading}><div><span>Manual outreach workflow</span><h1>Outreach</h1><p>Review verified leads, prepare a concise draft, and approve it manually. No email is sent automatically.</p></div><strong>Sender: support@mahshar.xyz</strong></header>
    <div className={styles.notice}>{data?.transport.outbound === 'configured'
      ? <><strong>Manual send only.</strong> Every initial email and reply requires Admin review and Approve &amp; Send. {data?.replies.inbound === 'mailbox_bridge_configured' ? 'The authenticated mailbox bridge is configured.' : 'Inbound mailbox bridging is not configured.'}</>
      : <><strong>Mail transport not configured.</strong> Approved messages stop at Ready to send. {data?.replies.inbound === 'mailbox_bridge_configured' ? 'The authenticated mailbox bridge is configured.' : 'Inbound mailbox bridging is not configured.'}</>}</div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    <nav className={styles.tabs} aria-label="Outreach views">
      {viewOrder.map(view => <button key={view} type="button" className={filter === view ? styles.activeTab : ''} onClick={() => { setFilter(view); setSelectedId(null); setSelectedInboxId(null) }}>{viewLabel(view)} <small>{data?.counts[view] ?? '—'}</small>{view === 'inbox' && Boolean(data?.counts.unmatched_inbound) && <span className={styles.unmatchedCount}>{data?.counts.unmatched_inbound} unmatched</span>}</button>)}
    </nav>

    <section className={styles.panel}>
      {phase === 'loading' ? <div className={styles.empty}>Loading outreach leads…</div>
        : phase === 'failed' ? <div className={styles.empty} role="alert">Outreach data is temporarily unavailable.</div>
          : filter === 'inbox' ? <div className={styles.tableViewport}><table className={styles.inboxTable}><thead><tr><th>Sender</th><th>Subject</th><th>Provider / API</th><th>Received</th><th>Match</th><th>Classification</th><th>Thread status</th><th>Actions</th></tr></thead><tbody>{data?.inbox.map(item => { const matchedLead = item.lead_id ? data.leads.find(lead => lead.id === item.lead_id) ?? null : null; return <Fragment key={item.message.id}><tr><td>{item.message.sender_email}</td><td>{item.message.subject}</td><td>{item.provider && item.product ? <>{item.provider}<small className={styles.secondary}>{item.product}</small></> : '—'}</td><td>{timeLabel(item.message.received_at ?? item.message.created_at)}</td><td><span className={item.match_state === 'matched' ? styles.matchedChip : styles.unmatchedChip}>{item.match_state === 'matched' ? 'Matched' : 'Unmatched'}</span></td><td>{item.message.classification ? <span className={styles.classificationChip}>{classificationLabels[item.message.classification]}</span> : '—'}</td><td>{item.thread_status ? <span className={styles.statusChip}>{labels[item.thread_status]}</span> : '—'}</td><td><button type="button" onClick={() => openInboxItem(item)}>{selectedInboxId === item.message.id ? 'Close' : item.match_state === 'matched' ? 'Open conversation' : 'Review'}</button></td></tr>{selectedInboxId === item.message.id && <tr className={styles.detailRow}><td colSpan={8}><InboxMessageDetails item={item}/>{matchedLead && <><LeadDetails lead={matchedLead}/>{draftEditor(matchedLead)}</>}</td></tr>}</Fragment>})}</tbody></table>{data?.inbox.length === 0 && <div className={styles.empty}>No inbound messages.</div>}</div>
          : filter === 'contact_form_only' ? <div className={styles.tableViewport}><table><thead><tr><th>Provider</th><th>API</th><th>Fit</th><th>Official contact</th></tr></thead><tbody>{data?.contact_form_only.map(lead => <tr key={lead.id}><td>{lead.provider}</td><td>{lead.product}</td><td>{lead.fit_score}</td><td>{lead.official_contact_url ? <a href={lead.official_contact_url} target="_blank" rel="noopener noreferrer">Open form</a> : '—'}</td></tr>)}</tbody></table>{data?.contact_form_only.length === 0 && <div className={styles.empty}>No contact-form-only leads.</div>}</div>
            : <div className={styles.tableViewport}><table><thead><tr><th>Provider</th><th>API</th><th>Fit</th><th>Email</th><th>Official contact</th><th>Status</th><th>Last outreach / reply</th><th>Actions</th></tr></thead><tbody>{visible.map(lead => { const hasInbound = lead.history.some(message => message.direction === 'inbound'); return <Fragment key={lead.id}><tr><td>{lead.provider}</td><td>{lead.product}</td><td>{lead.fit_score}</td><td>{lead.preferred_email}</td><td>{lead.official_contact_url ? <a href={lead.official_contact_url} target="_blank" rel="noopener noreferrer">Open</a> : '—'}</td><td><select aria-label={`Outreach status for ${lead.provider}`} value={lead.outreach_status} disabled={busy !== null || manualTransitions[lead.outreach_status].length === 0} onChange={event => void setStatus(lead, event.target.value as OutreachStatus)}><option value={lead.outreach_status}>{labels[lead.outreach_status]}</option>{manualTransitions[lead.outreach_status].map(status => <option key={status} value={status}>{labels[status]}</option>)}</select>{hasInbound && <span className={styles.replyIndicator}>Inbound reply</span>}</td><td>{timeLabel(lead.last_reply_at ?? lead.last_outreach_at)}</td><td><div className={styles.actions}><button type="button" onClick={() => setSelectedId(selectedId === lead.id ? null : lead.id)}>{selectedId === lead.id ? 'Close' : 'Review'}</button>{lead.outreach_status === 'contact_ready' && <button type="button" disabled={busy !== null} onClick={() => void generate(lead)}>Generate Draft</button>}<button type="button" className={styles.danger} disabled={busy !== null} onClick={() => void setStatus(lead, 'do_not_contact')}>DNC</button></div></td></tr>{selectedId === lead.id && <tr className={styles.detailRow}><td colSpan={8}><LeadDetails lead={lead}/>{draftEditor(lead)}</td></tr>}</Fragment>})}</tbody></table>{visible.length === 0 && <div className={styles.empty}>No leads in this state.</div>}</div>}
    </section>
  </div>
}
