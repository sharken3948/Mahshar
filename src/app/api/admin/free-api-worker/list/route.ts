import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { createServiceClient } from '@/lib/supabase/server'
import { apiListingPath } from '@/lib/seo/listing'
import { OWNER } from '@/lib/free-api-worker/model'
import { listingPrice, matchesWorkerListing, workerListingInput } from '@/lib/free-api-worker/listing'
import { OPERATION_AUTH_HEADER } from '@/lib/marketplace/operation-authorization'
import { POST as createListing } from '@/app/api/apis/route'
import { POST as analyzeListing } from '@/app/api/ai/score/route'
import { PATCH as activateListing } from '@/app/api/apis/[id]/route'

export const runtime = 'nodejs'
export const maxDuration = 300
export const POST = withAdmin(async (request, principal) => {
  if (principal.wallet !== OWNER) return NextResponse.json({ error: 'owner_wallet_required' }, { status: 403 })
  // An operation proof is bound to its original path/body. Never replay it on Seller routes.
  if (request.headers.has(OPERATION_AUTH_HEADER)) return NextResponse.json({ error: 'Use the Seller session for this action.' }, { status: 400 })
  let body: { ids?: unknown; confirmed?: unknown; mode?: unknown; price?: unknown; owner_rights_confirmed?: unknown }
  try { body = await readBoundedJson(request, 8192) }
  catch (error) { if (error instanceof RequestBodyError) return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); throw error }
  if (!body || body.confirmed !== true || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 5
    || !body.ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) {
    return NextResponse.json({ error: 'Confirm between 1 and 5 candidate IDs per processing batch.' }, { status: 400 })
  }
  const price = listingPrice(body.mode, body.price)
  const db = createServiceClient()
  const results: { id: string; listingId?: string; url?: string; success: boolean; error?: string; retryAfter?: number }[] = []
  const sellerRequest = (path: string, method: string, payload: unknown) => {
    const headers = new Headers(request.headers)
    headers.set('content-type', 'application/json'); headers.delete('content-length')
    return new NextRequest(new URL(path, request.url), { method, headers, body: JSON.stringify(payload) })
  }
  for (const id of [...new Set(body.ids as string[])]) {
    let listingId: string | undefined
    try {
      const input = await workerListingInput(id, principal.wallet, price, body.owner_rights_confirmed)
      let response = await createListing(sellerRequest('/api/apis', 'POST', input))
      let result = await response.json()
      if (!response.ok) {
        results.push({ id, success: false, error: result.error ?? 'Listing creation failed',
          ...(response.status === 429 ? { retryAfter: Math.max(1, Number(response.headers.get('retry-after')) || 60) } : {}) })
        continue
      }
      listingId = result.id
      const context = { params: Promise.resolve({ id: listingId! }) }
      const { data: saved, error: savedError } = await db.from('api_listings').select('*').eq('id', listingId).single()
      if (savedError || !saved || !matchesWorkerListing(saved, input)) throw new Error('Saved listing changed; review it in Seller.')
      // An already completed publication is reconciled without another endpoint or Groq request.
      if (!(saved.is_active && saved.verified_at && saved.score != null && Number.isFinite(Number(saved.score))
        && Number(saved.score) >= 1 && Number(saved.score) <= 10 && saved.category)) {
        response = await analyzeListing(sellerRequest('/api/ai/score', 'POST', {
          api_id: listingId, seller_wallet: OWNER, require_category: true,
        }))
        result = await response.json()
        if (!response.ok || !result.endpoint_verified || !result.ai_available || result.inconclusive
          || !result.suggestions?.category || !Number.isInteger(result.score) || !result.approved
          || result.critical_issues?.length) {
          results.push({ id, listingId, success: false,
            error: result.error ?? result.blocking_issue ?? 'Groq category and API Score could not be confirmed. The listing was not published; retry analysis.',
            ...(response.status === 429 ? { retryAfter: Math.max(1, Number(response.headers.get('retry-after')) || 60) } : {}) })
          continue
        }
      }
      response = await activateListing(sellerRequest(`/api/apis/${listingId}`, 'PATCH', { seller_wallet: OWNER, is_active: true,
        price_per_call: price, owner_rights_confirmed: body.owner_rights_confirmed }), context)
      result = await response.json()
      if (!response.ok) { results.push({ id, listingId, success: false, error: result.error ?? 'Seller activation failed' }); continue }
      const { data: listing, error } = await db.from('api_listings').select('*').eq('id', listingId).single()
      if (error || !listing?.is_active || !listing.verified_at || listing.score == null || !listing.category
        || !matchesWorkerListing(listing, input)) throw new Error('Publication could not be confirmed. Retry to reconcile the saved listing.')
      results.push({ id, listingId, success: true, url: apiListingPath({ id: listingId!, name: input.name }) })
    } catch (error) {
      results.push({ id, listingId, success: false, error: error instanceof Error ? error.message : 'Publication unavailable' })
    }
  }
  return NextResponse.json({ results, published: results.filter(row => row.success).length })
})
