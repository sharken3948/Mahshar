import 'server-only'
import { configuredAdminWallets } from '@/lib/admin-auth'
import { MarketplaceError } from '@/lib/marketplace/operation-authorization'
import { createServiceClient } from '@/lib/supabase/server'
import { OWNER, usable, type Candidate } from './model'

export function listingPrice(mode: unknown, value: unknown): number {
  if (mode === 'FREE') return 0
  if (mode !== 'PAID' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    || value >= 10000 || Math.abs(value * 1e6 - Math.round(value * 1e6)) > 1e-6) {
    throw new MarketplaceError('Enter a positive USDC price with at most 6 decimal places (below 10000).', 400)
  }
  return value
}

export async function workerListingInput(id: unknown, wallet: string, price: number, ownerRightsConfirmed?: unknown) {
  if (wallet !== OWNER || !configuredAdminWallets().has(wallet)) throw new MarketplaceError('owner_wallet_required', 403)
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new MarketplaceError('Invalid candidate', 400)
  const { data, error } = await createServiceClient().from('free_worker_apis').select('*').eq('id', id).single()
  if (error || !data) throw new MarketplaceError('Candidate unavailable', 404)
  const row = data as { lead: Candidate['lead']; result: Candidate['result']; removed_at?: string; published_at?: string; manual_failed_at?: string }
  if (row.removed_at || row.manual_failed_at || row.lead.duplicateOf || !usable(row.result)) throw new MarketplaceError('Candidate is not Ready to List', 409)
  if (price > 0 && ownerRightsConfirmed !== true) {
    throw new MarketplaceError('Explicit owner confirmation of established paid proxy/resale rights is required.', 409)
  }
  return {
    owner_rights_confirmed: price > 0 && ownerRightsConfirmed === true,
    // An authenticated owner declaration, never a provider grant or Worker verification.
    owner_rights_confirmation: price > 0 ? {
      version: 'paid-api-access-v1', confirmed: true, owner: wallet, candidateId: id,
      endpoint: row.result!.endpoint, confirmedAt: new Date().toISOString(),
    } : null,
    free_worker_candidate_id: id, seller_wallet: OWNER, name: row.lead.name, description: row.lead.description,
    category: 'Other', endpoint_url: row.result!.endpoint, method: 'GET', auth_type: 'public',
    payment_model: 'pay-per-call', price_per_call: price, example_request: '{}',
    body_required: false, request_schema: null, dynamic_path_supported: false, path_parameters: [], query_parameters: [],
  }
}

/** Retry only the exact prepared contract; never silently edit an existing product. */
export function matchesWorkerListing(row: Record<string, unknown>, input: Awaited<ReturnType<typeof workerListingInput>>) {
  return row.seller_wallet === OWNER && row.free_worker_candidate_id === input.free_worker_candidate_id
    && row.endpoint_url === input.endpoint_url && row.name === input.name && row.description === input.description
    && Number(row.price_per_call) === input.price_per_call && row.method === 'GET' && row.auth_type === 'public'
    && !row.encrypted_key && !row.body_required && !row.dynamic_path_supported
    && JSON.stringify(row.path_parameters ?? []) === '[]' && JSON.stringify(row.query_parameters ?? []) === '[]'
}
