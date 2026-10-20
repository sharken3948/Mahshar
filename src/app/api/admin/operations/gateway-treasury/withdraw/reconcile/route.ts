import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { recoverCommissionWithdrawal } from '@/lib/admin/commission-withdrawal-server'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const POST = withAdmin(async (request: NextRequest) => {
  const body = await request.json().catch(() => ({})) as { withdrawal_id?: unknown; confirm?: unknown }
  if (body.confirm !== true || typeof body.withdrawal_id !== 'string' || !UUID.test(body.withdrawal_id)) {
    return NextResponse.json({ error: 'Explicit confirmation and withdrawal ID required' }, { status: 400 })
  }
  try {
    const row = await recoverCommissionWithdrawal(body.withdrawal_id)
    if (!row) return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
    return NextResponse.json({ withdrawal_id: row.id, status: row.status, mint_tx_hash: row.mint_tx_hash ?? null,
      manual_review_required: ['preparing','submission_unknown','mint_unknown','failed'].includes(row.status),
    })
  } catch {
    return NextResponse.json({ error: 'Commission withdrawal reconciliation unavailable' }, { status: 503 })
  }
})
