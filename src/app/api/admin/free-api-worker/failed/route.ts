import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { readBoundedJson, RequestBodyError } from '@/lib/request-body'
import { MarketplaceError, OPERATION_AUTH_HEADER } from '@/lib/marketplace/operation-authorization'
import { OWNER } from '@/lib/free-api-worker/model'
import { failedRpc, recheckFailed } from '@/lib/free-api-worker/failed'

export const runtime = 'nodejs'
export const maxDuration = 300
export const POST = withAdmin(async (request, principal) => {
  if (principal.wallet !== OWNER) throw new MarketplaceError('owner_wallet_required', 403)
  if (request.headers.has(OPERATION_AUTH_HEADER)) throw new MarketplaceError('Use the Seller session for this action.', 400)
  const body = await readBoundedJson<{ action?: unknown; ids?: unknown; confirmed?: unknown }>(request, 8192).catch(error => {
    throw new MarketplaceError('Invalid request body', error instanceof RequestBodyError && error.code === 'body_too_large' ? 413 : 400)
  })
  if (!body || body.confirmed !== true || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 25
    || new Set(body.ids).size !== body.ids.length || !body.ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) {
    throw new MarketplaceError('Explicitly confirm the selected candidate IDs.', 400)
  }
  if (body.action === 'move') return NextResponse.json({ moved: await failedRpc<number>('move', { p_ids: body.ids, p_confirmed: true }) })
  // One bounded request per explicitly selected API. No background or automatic retries.
  if (body.action === 'recheck' && body.ids.length === 1) return NextResponse.json(await recheckFailed(request, body.ids[0]))
  throw new MarketplaceError('Invalid Failed APIs action.', 400)
})
