import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { markOutreachSent, markOutreachUncertain } from '@/lib/admin-outreach/repository'
import { OutreachTransportError, sendOutreachEmail, type OutreachDelivery } from '@/lib/admin-outreach/transport'
import { brevoAcquisitionEnabled } from './acquisition-delivery-config'
import type { AcquisitionOutcome } from './acquisition'

/** Separate from immutable draft preparation and the canary's simulated adapter. */
export async function deliverPreparedAcquisition(runId: string, epoch: string, limit: number): Promise<AcquisitionOutcome[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('acquisition_batch_limit_invalid')
  const outcomes: AcquisitionOutcome[] = []
  for (let index = 0; index < limit && brevoAcquisitionEnabled(); index++) {
    const claim = await createServiceClient().rpc('mahshar_acquisition_reserve_brevo', { p_run_id: runId, p_epoch: epoch })
    // A lost claim response may have committed a reservation. Never repeat that message.
    if (claim.error) break
    if (!claim.data) break
    const value = claim.data as Record<string, unknown>
    if (!['id', 'recipient', 'subject', 'body'].every(key => typeof value[key] === 'string' && value[key])) break
    const message: OutreachDelivery = { id: value.id as string, recipient: value.recipient as string,
      subject: value.subject as string, body: value.body as string }
    try {
      const receipt = await sendOutreachEmail(message)
      // Retry only persistence of the same receipt; never retry the Brevo request.
      try { await markOutreachSent(message.id, receipt.providerMessageId) }
      catch { await markOutreachSent(message.id, receipt.providerMessageId) }
      outcomes.push('sent')
    } catch (error) {
      if (error instanceof OutreachTransportError && error.kind !== 'ambiguous') {
        const code = error.kind === 'blocked' ? 'dispatch_blocked' : error.code
        const saved = await createServiceClient().rpc('mahshar_acquisition_reject_brevo', { p_message_id: message.id, p_code: code })
        // Keep the permanent reservation even if the failure checkpoint is unavailable.
        if (saved.error) break
        outcomes.push('provider_failed')
      } else {
        try { await markOutreachUncertain(message.id) }
        catch { /* Reservation and dispatch marker remain permanent reconciliation barriers. */ }
        outcomes.push('ambiguous_delivery')
      }
    }
  }
  return outcomes
}
