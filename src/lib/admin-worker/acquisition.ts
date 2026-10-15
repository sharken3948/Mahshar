import { renderInvitationTemplate, INVITATION_TEMPLATE_VERSION, type InvitationVariables, type TemplateSkipReason } from './invitation-template'

/** Bounded, sequential acquisition coordinator. The production adapter must persist each operation. */
export type AcquisitionCandidate = {
  attemptId?: string
  providerId: string
  leadId: string
  provider: string
  product: string
  email: string | null
  emailObserved: boolean
  emailValid: boolean
  evidenceVerified: boolean
  recipientEligible: boolean
  channelApproved: boolean
  evidence: string[]
  savedDraft?: AcquisitionDraft
  draftContext?: import('./acquisition-evidence').DraftEvidenceContext
  claimToken?: string
  templateVariables?: InvitationVariables
}

export type AcquisitionDraft = { subject: string; body: string; generator?: 'template'; templateVersion?: string }
export type AcquisitionOutcome = 'no_email' | 'invalid_email' | 'unverified_contact' |
  'recipient_ineligible' | 'channel_not_approved' | 'prior_outreach' | 'draft_invalid' |
  'stopped' | 'reserved' | 'sent' | 'ambiguous_delivery' | 'provider_failed' |
  'prepared' | 'provider_identity_unverified' | 'api_documentation_missing' | 'provider_suppressed' | TemplateSkipReason

export class AcquisitionBudgetPause extends Error {
  constructor() { super('acquisition_budget_pause') }
}

export class AcquisitionPreparationSkip extends Error {
  constructor(public readonly outcome: 'provider_identity_unverified' | 'api_documentation_missing' | 'unverified_contact' | 'provider_suppressed' | TemplateSkipReason) {
    super(outcome)
  }
}

export type AcquisitionPort = {
  draftOnly?: boolean
  deliverPrepared?(limit: number): Promise<AcquisitionOutcome[]>
  next(): Promise<AcquisitionCandidate | null>
  running(): Promise<boolean>
  priorOutreach(providerId: string): Promise<boolean>
  draft(candidate: AcquisitionCandidate): Promise<AcquisitionDraft>
  reserve(candidate: AcquisitionCandidate, draft: AcquisitionDraft): Promise<string | null>
  dispatch(reservationId: string, candidate: AcquisitionCandidate, draft: AcquisitionDraft): Promise<string>
  record(candidate: AcquisitionCandidate, outcome: AcquisitionOutcome, detail?: string): Promise<void>
  delivered(reservationId: string, providerMessageId: string): Promise<void>
  ambiguous(reservationId: string): Promise<void>
}

const REQUIRED = ['Mahshar', 'API marketplace', 'AI agents', 'developers', 'individual users',
  'pay-per-call', 'USDC', 'Arc', 'choose', 'Seller onboarding']

export function validAcquisitionDraft(candidate: AcquisitionCandidate, draft: AcquisitionDraft): boolean {
  if (draft.generator === 'template') {
    if (!candidate.templateVariables || draft.templateVersion !== INVITATION_TEMPLATE_VERSION) return false
    const rendered = renderInvitationTemplate(candidate.templateVariables)
    return rendered.ok && draft.subject === rendered.draft.subject && draft.body === rendered.draft.body
  }
  if (!draft.subject.trim() || draft.subject.length > 200 || !draft.body.trim() || draft.body.length > 5000) return false
  if (!candidate.evidence.length || !candidate.product.trim()) return false
  const body = draft.body.toLowerCase()
  return body.includes(candidate.product.toLowerCase()) && REQUIRED.every(term => body.includes(term.toLowerCase()))
    && !/guarantee(?:d)? revenue|existing partnership|we are partners/i.test(draft.body)
}

export function mockCanaryAcquisitionDraft(candidate: AcquisitionCandidate): AcquisitionDraft {
  const product = candidate.product.trim().slice(0, 160)
  return {
    subject: `[Simulation] ${product} on Mahshar`.slice(0, 200),
    body: `Simulation only. The documented ${product} could be considered for Mahshar, an API marketplace for AI agents, developers and individual users. Mahshar supports pay-per-call USDC payments on Arc. You choose which API to list through Seller onboarding.`,
  }
}

export async function processAcquisitionBatch(port: AcquisitionPort, limit: number): Promise<AcquisitionOutcome[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('acquisition_batch_limit_invalid')
  const results: AcquisitionOutcome[] = []
  for (let index = 0; index < limit; index += 1) {
    if (!await port.running()) break
    const candidate = await port.next()
    if (!candidate) break
    let outcome: AcquisitionOutcome
    try {
      if (!candidate.email || !candidate.emailObserved) outcome = 'no_email'
      else if (!candidate.emailValid) outcome = 'invalid_email'
      else if (!candidate.evidenceVerified) outcome = 'unverified_contact'
      else if (!port.draftOnly && !candidate.recipientEligible) outcome = 'recipient_ineligible'
      else if (!port.draftOnly && !candidate.channelApproved) outcome = 'channel_not_approved'
      else if (await port.priorOutreach(candidate.providerId)) outcome = 'prior_outreach'
      else {
        const draft = await port.draft(candidate)
        if (!validAcquisitionDraft(candidate, draft)) outcome = 'draft_invalid'
        else if (!await port.running()) outcome = 'stopped'
        else if (port.draftOnly) outcome = 'prepared'
        else {
          // The adapter's atomic reservation must recheck provider history, suppression,
          // eligibility, run status and quotas. A reservation is never retried.
          const reservationId = await port.reserve(candidate, draft)
          if (!reservationId) outcome = 'prior_outreach'
          else if (!await port.running()) outcome = 'reserved'
          else {
            try {
              const providerMessageId = await port.dispatch(reservationId, candidate, draft)
              await port.delivered(reservationId, providerMessageId)
              outcome = 'sent'
            } catch {
              await port.ambiguous(reservationId)
              outcome = 'ambiguous_delivery'
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof AcquisitionBudgetPause) break
      outcome = error instanceof AcquisitionPreparationSkip ? error.outcome : 'provider_failed'
    }
    try { await port.record(candidate, outcome) }
    catch (error) {
      if (error instanceof AcquisitionBudgetPause) break
      throw error
    }
    results.push(outcome)
  }
  if (port.deliverPrepared) results.push(...await port.deliverPrepared(limit))
  return results
}

