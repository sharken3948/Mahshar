import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { checkMaintenanceUpdates, maintenanceInventoryDashboard } from '@/lib/admin-maintenance/checks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAdmin(async (_request: NextRequest) => NextResponse.json(maintenanceInventoryDashboard()))

export const POST = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await checkMaintenanceUpdates()) }
  catch { return NextResponse.json({ error: 'maintenance_check_unavailable' }, { status: 503 }) }
})
