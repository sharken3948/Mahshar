import 'server-only'
import { createHash } from 'node:crypto'
import { VERIFICATION_CONFIGURATION } from '@/lib/marketplace/listing-security'

// Bind a persisted Seller review to the exact listing configuration, including its
// selected price. Category/score are checked separately because analysis assigns them.
export function reviewFingerprint(listing: Record<string, unknown>) {
  const keys = ['id', 'free_worker_candidate_id', 'seller_wallet', 'name', 'description',
    'payment_model', 'example_response', ...VERIFICATION_CONFIGURATION]
  const snapshot = Object.fromEntries(keys.map(key => [key, listing[key] ?? null]))
  snapshot.price_per_call = Number(listing.price_per_call)
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export function savedWorkerReview(listing: Record<string, unknown>) {
  const review = listing.free_worker_review as {
    fingerprint?: string; approved?: boolean; category?: string; score?: number; reason?: string
  } | null
  return review && listing.verified_at && review.fingerprint === reviewFingerprint(listing)
    && review.category === listing.category && review.score === Number(listing.score) ? review : null
}
