import 'server-only'
import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { MarketplaceError } from '@/lib/marketplace/operation-authorization'
import { OWNER } from './model'
import { workerListingInput } from './listing'
import { GroqRateLimitPause, PublicationFailure, publishWorkerListing, type PublicationInput } from './publication'
import { runBulkAttempt, BULK_TIMEOUT_ERROR } from './bulk-attempt'

export async function bulkRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createServiceClient().rpc(`free_worker_bulk_${name}`, args)
  if (error) {
    const known = ['unfinished_batch', 'authorization_changed', 'work_in_flight', 'batch_not_found', 'groq_pause_not_elapsed', 'groq_pause_changed'].find(code => error.message?.includes(code))
    throw new MarketplaceError(known ?? 'Bulk progress storage unavailable. Saved progress is retained.', known ? 409 : 503)
  }
  return data as T
}
export type BulkItem = {
  candidate_id: string; ordinal: number; input: PublicationInput; status: 'pending' | 'processing' | 'failed' | 'published';
  stage: string; listing_id: string | null; attempts: number; last_error: string | null;
  lease_until: string | null; lease_token?: string; updated_at: string; events: unknown[]
}
export type BulkBatch = { id: string; mode: 'FREE' | 'PAID'; price: number | string; rights_confirmed: boolean; authorized_at: string; retry_at: string | null; pause_reason?: 'groq_rate_limit' | null; items: BulkItem[] }
export async function readBatch(id?: string) { return bulkRpc<BulkBatch | null>('read', { p_owner: OWNER, p_id: id ?? null }) }
export function publicBatch(batch: BulkBatch | null) {
  if (!batch) return null
  return { ...batch, items: batch.items.map(({ input, lease_token: _token, ...item }) => ({ ...item, name: input.name })) }
}
export async function processNext(request: NextRequest, id: string) {
  const item = await bulkRpc<BulkItem | null>('claim', { p_id: id, p_owner: OWNER })
  if (!item) return publicBatch(await readBatch(id))
  const identity = { p_id: id, p_owner: OWNER, p_candidate: item.candidate_id, p_token: item.lease_token }
  const checkpoint = async (stage: 'prepare' | 'analysis' | 'activation', listingId?: string) => {
    if (!await bulkRpc<boolean>('checkpoint', { ...identity, p_stage: stage, p_listing: listingId ?? null })) {
      throw new MarketplaceError('Request lease expired. Resume after the current request finishes.', 409)
    }
  }
  try {
    await runBulkAttempt({ batch: id, candidate: item.candidate_id, token: item.lease_token!, deadline: Date.parse(item.lease_until!) }, async () => {
      // Revalidate current eligibility; never silently expand/change the saved authorization.
      const current = await workerListingInput(item.candidate_id, OWNER, Number(item.input.price_per_call), item.input.owner_rights_confirmed)
      for (const key of Object.keys(item.input) as (keyof PublicationInput)[]) {
        if (key !== 'owner_rights_confirmation' && JSON.stringify(current[key]) !== JSON.stringify(item.input[key])) {
          throw new PublicationFailure('Candidate changed since authorization. Review it and authorize a new selection.')
        }
      }
      await publishWorkerListing(request, item.input, checkpoint)
    })
    if (!await bulkRpc<boolean>('finish', { ...identity, p_status: 'published' })) throw new Error('checkpoint_failed')
  } catch (error) {
    const retry = error instanceof PublicationFailure ? error.retryAfter : undefined
    const reason = Date.now() >= Date.parse(item.lease_until!) || error instanceof Error && error.message === BULK_TIMEOUT_ERROR ? BULK_TIMEOUT_ERROR
      : error instanceof PublicationFailure || error instanceof MarketplaceError ? error.message
      : 'Publication interrupted. Saved listing and analysis will be reconciled on Resume.'
    const saved = error instanceof GroqRateLimitPause && reason !== BULK_TIMEOUT_ERROR
      ? await bulkRpc<boolean>('pause', { ...identity, p_retry: error.seconds })
      : await bulkRpc<boolean>('finish', { ...identity, p_status: retry && reason !== BULK_TIMEOUT_ERROR ? 'pending' : 'failed', p_error: reason, p_retry: reason === BULK_TIMEOUT_ERROR ? null : retry ?? null })
    if (!saved) {
      throw new MarketplaceError('Progress could not be confirmed. Resume reconciles the saved listing after its lease expires.', 503)
    }
  }
  return publicBatch(await readBatch(id))
}
