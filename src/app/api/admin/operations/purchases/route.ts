import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { parseOperationsLimit } from '@/lib/admin/operations-data'
import { getPurchases } from '@/lib/admin/purchases-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (request: NextRequest) => {
  const limit = parseOperationsLimit(new URL(request.url))
  if (limit === null) return NextResponse.json({ error: 'invalid_limit' }, { status: 400 })
  try { return NextResponse.json(await getPurchases(limit)) }
  catch { return NextResponse.json({ error: 'purchases_unavailable' }, { status: 503 }) }
})
