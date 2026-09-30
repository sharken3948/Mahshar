import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getInfrastructureStatus } from '@/lib/admin/infrastructure-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getInfrastructureStatus()) }
  catch { return NextResponse.json({ error: 'infrastructure_unavailable' }, { status: 503 }) }
})
