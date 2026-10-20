import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { commissionTreasuryContext } from '@/lib/admin/commission-withdrawal-server'

export const runtime = 'nodejs'

export const POST = withAdmin(async (request: NextRequest) => {
  const body = await request.json().catch(() => ({})) as { amount_usdc?: unknown }
  try {
    const { quote } = await commissionTreasuryContext(body.amount_usdc)
    return NextResponse.json(quote)
  } catch {
    return NextResponse.json({ error: 'Commission withdrawal quote unavailable or policy checks failed' }, { status: 409 })
  }
})
