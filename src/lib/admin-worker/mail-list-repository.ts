import 'server-only'
import { workerMailRpc } from './mail-list-rpc'
import type { PendingEmails } from './mail-list-types'

export class MailListError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

export async function getPendingEmails(after: string | null): Promise<PendingEmails> {
  const result = await workerMailRpc('mahshar_worker_mail_list', { p_after: after, p_limit: 25 })
  if (result.error || !result.data || !Array.isArray(result.data.items)) throw new MailListError(503, 'pending_emails_unavailable')
  return result.data as PendingEmails
}

export async function markPendingEmailSent(id: string, adminWallet: string) {
  const result = await workerMailRpc('mahshar_worker_mail_mark_sent', { p_id: id, p_admin_wallet: adminWallet })
  if (result.error) {
    const message = result.error.message
    if (message === 'mail_not_found') throw new MailListError(404, 'pending_email_not_found')
    if (message === 'mail_not_pending') throw new MailListError(409, 'pending_email_changed')
    throw new MailListError(503, 'pending_email_update_unavailable')
  }
  if (result.data?.status !== 'manual_sent') throw new MailListError(503, 'pending_email_update_unavailable')
  return result.data as { id: string; status: 'manual_sent'; manualSentAt: string }
}
