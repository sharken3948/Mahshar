import { NextRequest } from 'next/server'
import { handleArcBalanceRequest } from '@/lib/arc-balance-route'

export const runtime = 'nodejs'

export function GET(request: NextRequest) {
  return handleArcBalanceRequest(request)
}
