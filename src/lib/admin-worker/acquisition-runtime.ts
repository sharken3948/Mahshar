import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { AcquisitionBudgetPause, AcquisitionPreparationSkip, mockCanaryAcquisitionDraft, processAcquisitionBatch, validAcquisitionDraft, type AcquisitionCandidate, type AcquisitionDraft, type AcquisitionPort } from './acquisition'
import type { DraftEvidenceContext } from './acquisition-evidence'
import { renderInvitationTemplate, type InvitationVariables } from './invitation-template'
type TemplateContext = DraftEvidenceContext & { templateVariables: InvitationVariables }

type Row = Record<string, unknown>
function dataRow(value: unknown): Row | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === 'object' ? row as Row : null
}
async function rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
  const result = await createServiceClient().rpc(name, params)
  if (result.error) {
    if (result.error.message?.includes('acquisition_daily_send_limit')) throw new AcquisitionBudgetPause()
    throw new Error(`${name}_unavailable`)
  }
  return result.data
}

export async function acquisitionState(): Promise<{ running: boolean; epoch: string; canaryUsed: boolean }> {
  const result = await createServiceClient().from('admin_acquisition_control').select('desired_state,epoch,canary_used_at').eq('id', 1).single()
  if (result.error) throw new Error('acquisition_state_unavailable')
  const row = dataRow(result.data)
  if (!row || typeof row.epoch !== 'string') throw new Error('acquisition_state_invalid')
  return { running: row.desired_state === 'running', epoch: row.epoch, canaryUsed: typeof row.canary_used_at === 'string' }
}

export async function setAcquisitionState(running: boolean, canaryRunId: string | null = null): Promise<string> {
  const row = dataRow(await rpc('mahshar_acquisition_set_state', {
    p_running: running, p_canary: running && canaryRunId !== null, p_run_id: canaryRunId,
  }))
  if (!row || typeof row.epoch !== 'string') throw new Error('acquisition_state_invalid')
  return row.epoch
}

export function acquisitionModeEnabled(): boolean {
  return process.env.ADMIN_ACQUISITION_MODE === 'true'
}

export function acquisitionCanaryEnabled(): boolean {
  return process.env.ADMIN_ACQUISITION_CANARY === 'true'
}

export function acquisitionContinuousEnabled(): boolean {
  return process.env.ADMIN_ACQUISITION_CONTINUOUS === 'true' && !acquisitionCanaryEnabled()
}

export function acquisitionPort(runId: string, epoch: string, canary = false): AcquisitionPort {
  const db = createServiceClient()
  const port: AcquisitionPort = {
    draftOnly: !canary,
    running: async () => {
      const [control, run, worker] = await Promise.all([
        db.from('admin_acquisition_control').select('desired_state,epoch').eq('id', 1).single(),
        db.from('worker_runs').select('status').eq('id', runId).single(),
        db.from('worker_control').select('desired_state').eq('id', 1).single(),
      ])
      if (control.error || run.error || worker.error) throw new Error('acquisition_state_unavailable')
      return acquisitionModeEnabled() && (canary ? acquisitionCanaryEnabled() : acquisitionContinuousEnabled())
        && dataRow(control.data)?.desired_state === 'running' && dataRow(control.data)?.epoch === epoch
        && dataRow(run.data)?.status === 'running' && dataRow(worker.data)?.desired_state === 'running'
    },
    next: async () => {
      const row = dataRow(await rpc(canary ? 'mahshar_acquisition_claim_next' : 'mahshar_acquisition_claim_draft', { p_run_id: runId, p_epoch: epoch }))
      if (!row) return null
      if (typeof row.attemptId !== 'string' || typeof row.providerId !== 'string' || typeof row.leadId !== 'string'
        || typeof row.provider !== 'string' || typeof row.product !== 'string') throw new Error('acquisition_candidate_invalid')
      const email = typeof row.email === 'string' ? row.email : null
      const context = !canary ? dataRow(row.context) as TemplateContext | null : null
      if (!canary && (!context || typeof context.key !== 'string' || typeof context.domain !== 'string'
        || !Array.isArray(context.facts) || !Array.isArray(context.docsUrls) || typeof row.claimToken !== 'string')) {
        throw new Error('acquisition_draft_context_invalid')
      }
      return { attemptId: row.attemptId, providerId: row.providerId, leadId: row.leadId,
        provider: row.provider, product: row.product, email,
        emailObserved: Boolean(email), emailValid: Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
        evidenceVerified: row.verified === true && row.emailReady === true,
        recipientEligible: row.approved === true, channelApproved: row.approved === true,
        evidence: [row.docsUrl, row.docsSummary].filter((value): value is string => typeof value === 'string'
          && value.length > 0).map(value => value.slice(0, 500)),
        ...(context ? { draftContext: context, claimToken: row.claimToken as string, templateVariables: context.templateVariables } : {}),
        ...(typeof row.subject === 'string' && typeof row.body === 'string'
          ? { savedDraft: { subject: row.subject, body: row.body } } : {}),
      }
    },
    priorOutreach: async providerId => {
      const result = await db.from('admin_outreach_threads').select('id', { count: 'exact', head: true }).eq('provider_id', providerId)
      if (result.error) throw new Error('acquisition_history_unavailable')
      return Boolean(result.count)
    },
    draft: async candidate => {
      if (canary) return mockCanaryAcquisitionDraft(candidate)
      const context = dataRow(await rpc('mahshar_acquisition_template_context', { p_lead_id: candidate.leadId })) as TemplateContext | null
      if (!context?.allowed) throw new AcquisitionPreparationSkip('provider_suppressed')
      if (!context.identityVerified) throw new AcquisitionPreparationSkip('provider_identity_unverified')
      if (!context.contactVerified) throw new AcquisitionPreparationSkip('unverified_contact')
      if (!candidate.attemptId || !candidate.claimToken) throw new Error('acquisition_draft_claim_missing')
      const variables = context.templateVariables ?? { company: null, product: null, companyVerified: false, productVerified: false }
      const rendered = renderInvitationTemplate(variables)
      if (!rendered.ok) throw new AcquisitionPreparationSkip(rendered.reason)
      candidate.templateVariables = variables
      const draft = rendered.draft
      if (!await port.running()) throw new AcquisitionBudgetPause()
      if (!validAcquisitionDraft(candidate, draft)) throw new Error('acquisition_template_invalid')
      let saved: unknown
      try { saved = await rpc('mahshar_acquisition_save_template_draft', { p_attempt_id: candidate.attemptId, p_epoch: epoch,
        p_claim_token: candidate.claimToken, p_evidence_key: context.key,
        p_subject: draft.subject, p_body: draft.body, p_template_version: draft.templateVersion }) }
      catch { throw new AcquisitionBudgetPause() }
      if (saved !== true) throw new AcquisitionBudgetPause()
      return draft
    },
    reserve: async (candidate, draft) => {
      if (!canary) throw new Error('acquisition_draft_only')
      if (!candidate.attemptId || !candidate.email) return null
      const value = await rpc('mahshar_acquisition_reserve', { p_attempt_id: candidate.attemptId,
        p_epoch: epoch, p_email: candidate.email, p_subject: draft.subject, p_body: draft.body })
      return typeof value === 'string' ? value : null
    },
    // Deliberately simulated. This adapter never calls Brevo or any external transport.
    dispatch: async reservationId => {
      if (!canary) throw new Error('acquisition_draft_only')
      return `simulated:${reservationId}`
    },
    delivered: async (id, providerMessageId) => {
      if (!canary) throw new Error('acquisition_draft_only')
      await rpc('mahshar_acquisition_finish', {
      p_attempt_id: id, p_provider_message_id: providerMessageId, p_uncertain: false,
    }) },
    ambiguous: async id => {
      if (!canary) throw new Error('acquisition_draft_only')
      await rpc('mahshar_acquisition_finish', {
      p_attempt_id: id, p_provider_message_id: null, p_uncertain: true,
    }) },
    record: async (candidate, outcome) => {
      if (!candidate.attemptId || ['prepared','sent','ambiguous_delivery','reserved','stopped'].includes(outcome)) return
      if (!canary) {
        if (!candidate.claimToken) throw new Error('acquisition_draft_claim_missing')
        const recorded = await rpc('mahshar_acquisition_record_draft', { p_attempt_id: candidate.attemptId, p_epoch: epoch,
          p_claim_token: candidate.claimToken, p_reason: outcome })
        if (recorded !== true) throw new AcquisitionBudgetPause()
        return
      }
      await rpc('mahshar_acquisition_record', { p_attempt_id: candidate.attemptId,
        p_status: outcome === 'provider_failed' ? 'failed' : 'skipped', p_reason: outcome })
    },
  }
  return port
}

export async function processAcquisitionStep(runId: string, epoch: string, canary = false): Promise<string[]> {
  'use step'
  if (!acquisitionModeEnabled()) return []
  return processAcquisitionBatch(acquisitionPort(runId, epoch, canary), canary ? 1 : 10)
}

export async function finishAcquisitionCanaryStep(runId: string, epoch: string): Promise<void> {
  'use step'
  await rpc('mahshar_acquisition_finish_canary', { p_run_id: runId, p_epoch: epoch })
}

export async function acquisitionStillRunningStep(epoch: string): Promise<boolean> {
  'use step'
  const state = await acquisitionState()
  return acquisitionModeEnabled() && acquisitionContinuousEnabled() && state.running && state.epoch === epoch
}

export async function acquisitionWorkAllowed(runId: string, epoch: string): Promise<boolean> {
  return acquisitionPort(runId, epoch).running()
}

export async function createNextAcquisitionRunStep(epoch: string, parentRunId: string): Promise<string | null> {
  'use step'
  const row = dataRow(await rpc('mahshar_acquisition_create_next_run', { p_epoch: epoch, p_parent_run_id: parentRunId }))
  return typeof row?.id === 'string' ? row.id : null
}

export async function stopAcquisitionEpoch(epoch: string): Promise<void> {
  await rpc('mahshar_acquisition_stop_epoch', { p_epoch: epoch })
}

export async function failAcquisitionStep(epoch: string): Promise<void> {
  'use step'
  await stopAcquisitionEpoch(epoch)
}
