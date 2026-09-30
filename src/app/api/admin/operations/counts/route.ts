import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getListingCounts } from '@/lib/admin/operations-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getListingCounts()) }
  catch { return NextResponse.json({ error: 'listing_counts_unavailable' }, { status: 503 }) }
})
