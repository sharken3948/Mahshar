import { NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { readBoundedJson } from '@/lib/request-body'
import { OWNER, usableCandidates } from '@/lib/free-api-worker/model'
import { databaseStore } from '@/lib/free-api-worker/runtime'

export const runtime = 'nodejs'
export const POST = withAdmin(async (request, principal) => {
  if (principal.wallet !== OWNER) return NextResponse.json({ error: 'owner_wallet_required' }, { status: 403 })
  const body = await readBoundedJson<{ ids?: unknown; confirmed?: unknown }>(request, 400_000)
  if (body?.confirmed !== true || !Array.isArray(body.ids) || !body.ids.length
    || !body.ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) {
    return NextResponse.json({ error: 'confirmed_candidate_ids_required' }, { status: 400 })
  }
  try {
    const store = await databaseStore()
    const ready = new Set(usableCandidates(await store.candidates()).map(row => row.lead.id))
    const ids = [...new Set(body.ids as string[])].filter(id => ready.has(id))
    const removed = ids.length ? await store.remove(ids, principal.wallet) : 0
    return NextResponse.json({ removed })
  } catch { return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 }) }
})
