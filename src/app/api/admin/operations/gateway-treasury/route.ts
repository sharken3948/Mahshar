import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { getGatewayTreasury } from '@/lib/admin/gateway-treasury-data'

export const runtime = 'nodejs'

export const GET = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await getGatewayTreasury()) }
  catch { return NextResponse.json({ error: 'gateway_treasury_unavailable' }, { status: 503 }) }
})
