import { NextResponse } from 'next/server'
import { start } from 'workflow/api'
import { withAdmin } from '@/lib/admin-auth'
import { readBoundedJson } from '@/lib/request-body'
import { OWNER } from '@/lib/free-api-worker/model'
import { databaseStore } from '@/lib/free-api-worker/runtime'
import { freeApiWorkflow } from '@/workflows/free-api-worker'

export const runtime = 'nodejs'
export const POST = withAdmin(async (request, principal) => {
  if (principal.wallet !== OWNER) return NextResponse.json({ error: 'owner_wallet_required' }, { status: 403 })
  const body = await readBoundedJson<{ action?: unknown }>(request, 1024)
  const action = body?.action
  if (action !== 'start' && action !== 'stop' && action !== 'resume') return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
  try {
    const store = await databaseStore(), state = await store.control(action)
    if (action !== 'stop') {
      try { await start(freeApiWorkflow, [state.generation]) }
      catch { await store.finish(state.generation, {}, 'Workflow could not start; progress retained.'); throw new Error('workflow_unavailable') }
    }
    return NextResponse.json(state, { status: 202 })
  } catch (error) {
    const conflict = error instanceof Error && ['already_running', 'work_in_flight'].includes(error.message)
    return NextResponse.json({ error: conflict ? (error as Error).message : 'worker_unavailable' }, { status: conflict ? 409 : 503 })
  }
})
