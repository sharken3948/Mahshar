import 'server-only'
import { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { MarketplaceError } from '@/lib/marketplace/operation-authorization'
import { POST as analyzeListing } from '@/app/api/ai/score/route'
import { redactSecrets } from '@/lib/groq-neutral'
import { OWNER, usable, type Lead, type Result } from './model'
import { evaluate } from './pipeline'
import { Network } from './network'
import { savedWorkerReview } from './review'

type FailedCandidate = {
  id: string; lead: Lead; result: Result | null; failure_reason: string; recheck_token: string;
  manual_failed_at: string | null; recheck_result: { validation?: Result } | null
}
export async function failedRpc<T>(action: 'move' | 'begin' | 'finish', args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createServiceClient().rpc('free_worker_failed_' + action, { ...args, p_owner: OWNER })
  if (error) {
    const code = ['work_in_flight', 'candidate_not_available', 'candidate_not_failed', 'invalid_selection', 'explicit_owner_confirmation_required'].find(code => error.message?.includes(code))
    throw new MarketplaceError(code ?? 'Failed APIs storage unavailable; saved state is retained.', code ? 409 : 503)
  }
  return data as T
}

/** Explicitly selected candidate only: no discovery, draft creation or activation. */
export async function recheckFailed(request: NextRequest, id: string) {
  const candidate = await failedRpc<FailedCandidate>('begin', { p_id: id })
  const db = createServiceClient()
  let validation: Result | null = null, recovered = false, reason = 'Recheck interrupted; select Recheck Failed to try again.'
  let review: Record<string, unknown> | null = null
  const previousReason = candidate.failure_reason
  // Provider backoff is respected, but never schedules another recheck.
  const previousRetry = candidate.recheck_result?.validation?.retryAt
  const network = new Network(undefined, {}, undefined, undefined, async () => {
    const { data, error } = await db.from('free_worker_apis').select('recheck_token,recheck_until,removed_at,manual_failed_at').eq('id', id).single()
    return !error && data?.recheck_token === candidate.recheck_token && !!data.manual_failed_at && !data.removed_at
      && Date.parse(data.recheck_until) > Date.now()
  })
  try {
    if (previousRetry && Date.parse(previousRetry) > Date.now()) {
      validation = candidate.recheck_result!.validation!
      reason = `Provider retry window has not elapsed (${previousRetry}). Recheck manually afterwards.`
    } else {
      const { data: state, error: stateError } = await db.from('free_worker_state').select('cooldowns').eq('id', 1).single()
      if (stateError) throw new MarketplaceError('Provider cooldown state unavailable.', 503)
      Object.assign(network.pauses, state?.cooldowns ?? {})
      // Explicit recheck must refresh evidence; evaluate's normal cached-success shortcut is intentionally not used.
      // The same documentation resolver, transport, four qualification criteria and permission checks still apply.
      validation = await evaluate({ ...candidate.lead, endpoints: [...new Set([...(candidate.lead.endpoints ?? []), ...(candidate.result?.endpoint ? [candidate.result.endpoint] : [])])] }, network)
      recovered = usable(validation)
      reason = recovered ? 'Validation recovered; returned to Ready to List without publication.' : validation.reason
      if (validation.freeAccess === 'CREDENTIALS_REQUIRED') reason = 'Authentication is required. Credentials were not obtained or bypassed; candidate remains in Failed APIs.'
      else if (validation.permission === 'PROHIBITED') reason = 'Existing commercial filtering prohibits this API; candidate remains in Failed APIs.'
      if (recovered) {
        const { data: draft, error } = await db.from('api_listings').select('*').eq('free_worker_candidate_id', id).maybeSingle()
        if (error) throw new MarketplaceError('Saved draft unavailable; recovery was not confirmed.', 503)
        if (draft?.is_active || draft && draft.seller_wallet !== OWNER) {
          recovered = false; reason = 'The saved listing is already published or has a different owner; recovery was not applied.'
        } else if (draft && draft.endpoint_url !== validation!.endpoint) {
          // Recover the candidate, not the old authorized draft contract. Seller editing still requires its existing signature and rights checks.
          reason = 'Validation recovered. The saved draft is unchanged; review its new endpoint in Seller before Bulk List.'
        } else if (draft) {
          // Valid approved reviews survive transport/activation failures. Rejected/incomplete reviews may be re-evaluated explicitly.
          const saved = savedWorkerReview(draft)
          if (saved?.approved) review = { ...saved, reused: true }
          else {
            const headers = new Headers(request.headers)
            headers.set('content-type', 'application/json'); headers.delete('content-length')
            const response = await analyzeListing(new NextRequest(new URL('/api/ai/score', request.url), {
              method: 'POST', headers, body: JSON.stringify({ api_id: draft.id, seller_wallet: OWNER, require_category: true }),
            }))
            const result = await response.json()
            recovered = response.ok && result.endpoint_verified === true && result.ai_available === true
              && result.inconclusive !== true && result.approved === true && !result.critical_issues?.length
              && typeof result.suggestions?.category === 'string' && Number.isInteger(result.score) && result.score >= 1 && result.score <= 10
            reason = recovered ? 'Validation and Seller/Groq review recovered; draft retained and no publication performed.'
              : result.analysis_failure_reason ?? result.error ?? result.critical_issues?.[0] ?? 'Seller/Groq review did not approve recovery.'
            review = { approved: recovered, category: result.suggestions?.category ?? null, score: result.score ?? null }
          }
        }
      }
    }
  } catch (error) {
    recovered = false
    reason = error instanceof MarketplaceError ? error.message : 'Recheck could not complete; existing evidence and draft are retained.'
  } finally { network.clearDocuments() }
  reason = redactSecrets(reason).slice(0, 1200)
  const evidence = { validation, review, previousReason, checkedAt: new Date().toISOString() }
  if (!await failedRpc<boolean>('finish', { p_id: id, p_token: candidate.recheck_token, p_result: evidence, p_recovered: recovered, p_reason: reason })) {
    throw new MarketplaceError('Recheck was interrupted or the candidate changed. Reload saved state before a manual retry.', 409)
  }
  // Database duplicate/changed-draft checks can veto recovery. Return the committed outcome.
  const { data, error } = await db.from('free_worker_apis').select('manual_failed_at,failure_reason').eq('id', id).single()
  if (error || !data) throw new MarketplaceError('Reload Failed APIs to confirm the saved result.', 503)
  return { id, recovered: !data.manual_failed_at, reason: data.failure_reason }
}
