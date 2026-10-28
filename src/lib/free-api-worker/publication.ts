import 'server-only'
import { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { POST as createListing } from '@/app/api/apis/route'
import { POST as analyzeListing } from '@/app/api/ai/score/route'
import { PATCH as activateListing } from '@/app/api/apis/[id]/route'
import { apiListingPath } from '@/lib/seo/listing'
import { redactSecrets } from '@/lib/groq-neutral'
import { matchesWorkerListing, workerListingInput } from './listing'
import { savedWorkerReview } from './review'
import { OWNER } from './model'
import { assertBulkAttempt, currentBulkAttempt } from './bulk-attempt'

export type PublicationInput = Awaited<ReturnType<typeof workerListingInput>>
export type PublicationStage = 'prepare' | 'analysis' | 'activation'
export class PublicationFailure extends Error {
  constructor(message: string, readonly retryAfter?: number) { super(redactSecrets(message).slice(0, 1200)) }
}
export class GroqRateLimitPause extends PublicationFailure {
  constructor(readonly seconds: number) { super('Groq HTTP 429: rate limit reached. Resume after the saved retry time.') }
}
export async function publishWorkerListing(request: NextRequest, input: PublicationInput,
  checkpoint: (stage: PublicationStage, listingId?: string) => Promise<void> = async () => {}) {
  const db = createServiceClient()
  const sellerRequest = (path: string, method: string, payload: unknown) => {
    assertBulkAttempt()
    const headers = new Headers(request.headers)
    headers.set('content-type', 'application/json'); headers.delete('content-length')
    return new NextRequest(new URL(path, request.url), { method, headers, body: JSON.stringify(payload), signal: currentBulkAttempt()?.signal ?? request.signal })
  }
  const read = async () => {
    const { data, error } = await db.from('api_listings').select('*').eq('free_worker_candidate_id', input.free_worker_candidate_id).maybeSingle()
    if (error) throw new PublicationFailure('Saved listing could not be read. Resume to reconcile it.')
    if (data && !matchesWorkerListing(data, input)) throw new PublicationFailure('Saved listing differs from the authorized selection. Review it in Seller.')
    return data
  }
  const checkResponse = async (response: Response) => {
    assertBulkAttempt()
    const result = await response.json()
    if (!response.ok) throw new PublicationFailure(result.error ?? 'Seller request failed',
      response.status === 429 ? Math.max(1, Number(response.headers.get('retry-after')) || 60) : undefined)
    return result
  }
  await checkpoint('prepare')
  let saved = await read()
  if (!saved) {
    await checkResponse(await createListing(sellerRequest('/api/apis', 'POST', input)))
    saved = await read()
  }
  if (!saved) throw new PublicationFailure('Draft was not found. Resume to reconcile saved progress.')
  const id = String(saved.id)
  const output = () => ({ id: input.free_worker_candidate_id, listingId: id, success: true as const,
    url: apiListingPath({ id, name: input.name }) })
  // Legacy completed publications predate review checkpoints and must remain untouched.
  if (saved.is_active && saved.verified_at && saved.category && Number(saved.score) >= 1 && Number(saved.score) <= 10) {
    await checkpoint('activation', id)
    return output()
  }
  await checkpoint('analysis', id)
  let review = savedWorkerReview(saved)
  if (!review) {
    const result = await checkResponse(await analyzeListing(sellerRequest('/api/ai/score', 'POST', {
      api_id: id, seller_wallet: OWNER, require_category: true,
    })))
    if (Number.isSafeInteger(result.bulk_groq_retry_after_seconds) && result.bulk_groq_retry_after_seconds > 0) {
      throw new GroqRateLimitPause(result.bulk_groq_retry_after_seconds)
    }
    if (!result.endpoint_verified || !result.ai_available || result.inconclusive || !result.suggestions?.category
      || !Number.isInteger(result.score) || !result.approved || result.critical_issues?.length) {
      throw new PublicationFailure(result.error ?? result.blocking_issue ?? result.analysis_failure_reason
        ?? (result.critical_issues?.length ? result.critical_issues.join('; ') : 'Groq category and API Score could not be confirmed. The draft is saved; retry analysis.'),
      result.retry_after_seconds)
    }
    saved = await read()
    review = saved && savedWorkerReview(saved)
  }
  if (!review?.approved) throw new PublicationFailure(review?.reason || 'Saved Seller review does not approve publication. Review the draft in Seller.')
  await checkpoint('activation', id)
  await checkResponse(await activateListing(sellerRequest(`/api/apis/${id}`, 'PATCH', {
    seller_wallet: OWNER, is_active: true, price_per_call: input.price_per_call,
    owner_rights_confirmed: input.owner_rights_confirmed,
    worker_review_fingerprint: review.fingerprint,
  }), { params: Promise.resolve({ id }) }))
  saved = await read()
  if (!saved?.is_active || !saved.verified_at || !savedWorkerReview(saved)?.approved) {
    throw new PublicationFailure('Publication could not be confirmed. Resume to reconcile the saved listing.')
  }
  return output()
}
