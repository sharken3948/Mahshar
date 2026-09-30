import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getOperationsListings, parseListingsQuery } from '@/lib/admin/operations-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (request: NextRequest) => {
  const input = parseListingsQuery(new URL(request.url))
  if (!input) return NextResponse.json({ error: 'invalid_pagination_or_filter' }, { status: 400 })
  try { return NextResponse.json(await getOperationsListings(input)) }
  catch { return NextResponse.json({ error: 'listings_unavailable' }, { status: 503 }) }
})
