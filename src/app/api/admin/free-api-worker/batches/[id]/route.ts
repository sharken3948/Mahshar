import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { OPERATION_AUTH_HEADER, MarketplaceError } from '@/lib/marketplace/operation-authorization'
import { OWNER } from '@/lib/free-api-worker/model'
import { bulkRpc, processNext, publicBatch, readBatch, type BulkBatch } from '@/lib/free-api-worker/bulk'

export const runtime = 'nodejs'
// One API per request. Its recovery lease exceeds this maximum execution time.
export const maxDuration = 300
const validId = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
export const GET = withAdmin(async (_request, principal, context: { params: Promise<{ id: string }> }) => {
  if (principal.wallet !== OWNER) throw new MarketplaceError('owner_wallet_required', 403)
  const { id } = await context.params
  if (!validId(id)) throw new MarketplaceError('Invalid batch ID', 400)
  const batch = await readBatch(id)
  if (!batch) throw new MarketplaceError('batch_not_found', 404)
  return NextResponse.json({ batch: publicBatch(batch) })
})
export const POST = withAdmin(async (request, principal, context: { params: Promise<{ id: string }> }) => {
  if (principal.wallet !== OWNER) throw new MarketplaceError('owner_wallet_required', 403)
  if (request.headers.has(OPERATION_AUTH_HEADER)) throw new MarketplaceError('Use the Seller session for this action.', 400)
  const { id } = await context.params
  if (!validId(id)) throw new MarketplaceError('Invalid batch ID', 400)
  const body = await readBoundedJson<{ action?: unknown }>(request, 1024).catch(error => { throw new MarketplaceError('Invalid request body', error instanceof RequestBodyError && error.code === 'body_too_large' ? 413 : 400) })
  if (body?.action === 'retry_failed') {
    return NextResponse.json({ batch: publicBatch(await bulkRpc<BulkBatch>('retry', { p_id: id, p_owner: OWNER })) })
  }
  if (body?.action !== 'next') throw new MarketplaceError('Invalid batch action', 400)
  return NextResponse.json({ batch: await processNext(request, id) })
})
