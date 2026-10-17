import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'

type MailRpc = 'mahshar_worker_mail_list' | 'mahshar_worker_mail_mark_sent'
  | 'mahshar_worker_mail_recover' | 'mahshar_worker_mail_checkpoint_recovery'
  | 'mahshar_worker_mail_claim_recovery' | 'mahshar_worker_mail_finish_recovery'
const allowed = new Set<MailRpc>(['mahshar_worker_mail_list', 'mahshar_worker_mail_mark_sent',
  'mahshar_worker_mail_recover', 'mahshar_worker_mail_checkpoint_recovery',
  'mahshar_worker_mail_claim_recovery', 'mahshar_worker_mail_finish_recovery'])

/** Retry only database-confirmed aborted transactions for these idempotent RPCs.
 * Network/HTTP failures can have unknown commit outcomes and are returned intact.
 * Transport and dispatch RPCs are deliberately outside this allowlist.
 */
export async function workerMailRpc(name: MailRpc, args: Record<string, unknown>) {
  if (!allowed.has(name)) throw new Error('worker_mail_rpc_not_retryable')
  for (let attempt = 0; ; attempt++) {
    const result = await createServiceClient().rpc(name, args)
    if (attempt >= 2 || !['55P03', '40P01', '40001', '57014'].includes(result.error?.code ?? '')) return result
    await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
  }
}
