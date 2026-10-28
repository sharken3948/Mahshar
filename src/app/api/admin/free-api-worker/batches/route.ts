import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { OPERATION_AUTH_HEADER, MarketplaceError } from '@/lib/marketplace/operation-authorization'
import { OWNER } from '@/lib/free-api-worker/model'
import { listingPrice, workerListingInput } from '@/lib/free-api-worker/listing'
import { bulkRpc, publicBatch, readBatch, type BulkBatch } from '@/lib/free-api-worker/bulk'

export const runtime = 'nodejs'
export const GET = withAdmin(async (_request, principal) => {
  if (principal.wallet !== OWNER) throw new MarketplaceError('owner_wallet_required', 403)
  return NextResponse.json({ batch: publicBatch(await readBatch()) })
})
export const POST = withAdmin(async (request, principal) => {
  if (principal.wallet !== OWNER) throw new MarketplaceError('owner_wallet_required', 403)
  if (request.headers.has(OPERATION_AUTH_HEADER)) throw new MarketplaceError('Use the Seller session for this action.', 400)
  const body = await readBoundedJson<{ id?: string; ids?: string[]; mode?: unknown; price?: unknown; confirmed?: unknown; owner_rights_confirmed?: unknown }>(request, 8192).catch(error => { throw new MarketplaceError('Invalid request body', error instanceof RequestBodyError && error.code === 'body_too_large' ? 413 : 400) })
  if (!body || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.id ?? '') || body.confirmed !== true || !Array.isArray(body.ids)
    || !body.ids.length || body.ids.length>25 || new Set(body.ids).size!==body.ids.length
    || !body.ids.every(id => typeof id==='string' && /^[a-f0-9]{64}$/.test(id))) {
    throw new MarketplaceError('Explicitly confirm 1–25 selected APIs and a batch ID.', 400)
  }
  const price = listingPrice(body.mode, body.price)
  const rights = body.mode === 'PAID' && body.owner_rights_confirmed === true
  if (price>0 && !rights) throw new MarketplaceError('Explicit paid resale rights confirmation is required.', 409)
  const existing = await readBatch(body.id)
  if (existing) {
    if (existing.mode!==body.mode || Number(existing.price)!==price || existing.rights_confirmed!==rights
      || JSON.stringify(existing.items.map(item=>item.candidate_id))!==JSON.stringify(body.ids)) {
      throw new MarketplaceError('authorization_changed', 409)
    }
    return NextResponse.json({ batch: publicBatch(existing) })
  }
  const inputs = []
  for (const id of body.ids) inputs.push(await workerListingInput(id, OWNER, price, rights))
  const batch = await bulkRpc<BulkBatch>('create', { p_id: body.id, p_owner: OWNER, p_mode: body.mode, p_price: price, p_rights: rights, p_inputs: inputs })
  return NextResponse.json({ batch: publicBatch(batch) }, { status: 201 })
})
