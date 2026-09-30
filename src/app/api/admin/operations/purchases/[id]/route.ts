import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getPurchaseDetail, validPurchaseId } from '@/lib/admin/purchases-data'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

export const GET = withAdmin(async (_request: NextRequest, _principal, context: Context) => {
  const { id } = await context.params
  if (!validPurchaseId(id)) return NextResponse.json({ error: 'invalid_purchase_id' }, { status: 400 })
  try {
    const detail = await getPurchaseDetail(id)
    return detail ? NextResponse.json(detail) : NextResponse.json({ error: 'purchase_not_found' }, { status: 404 })
  } catch { return NextResponse.json({ error: 'purchase_detail_unavailable' }, { status: 503 }) }
})
