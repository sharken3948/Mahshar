import { withWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { ARC, ARC_MAINNET } from '@/lib/arc'
import { enforceRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
const CIRCLE_TIMEOUT_MS = 8_000

function gatewayBalance(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) ? value : null
}

export const GET = withWalletSession(async (request: NextRequest, authorizedWallet: string) => {
  const includeHistory = request.nextUrl.searchParams.get('include_history') === 'true'
  assertWalletClaim(request.nextUrl.searchParams.get('wallet'), authorizedWallet)
  const wallet = authorizedWallet.toLowerCase()
  const limited = await enforceRateLimit({ request, scope: 'gateway-balance', limit: 30, windowSeconds: 60,
    wallet, failClosed: false })
  if (limited) return limited

  let gatewayAvailable: string
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ARC.chainId === ARC_MAINNET.chainId) headers['X-ARC-PRIVATE-MAINNET-ENABLED'] = 'true'
    const response = await fetch(`${ARC.gatewayApi}/balances`, {
      method: 'POST', headers,
      body: JSON.stringify({ token: 'USDC', sources: [{ depositor: wallet, domain: ARC.gatewayDomain }] }),
      signal: AbortSignal.timeout(CIRCLE_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return NextResponse.json({ error: 'gateway_upstream_error' }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
    const data = await response.json().catch(() => null) as { balances?: Array<{ balance?: unknown }> } | null
    const parsed = gatewayBalance(data?.balances?.[0]?.balance)
    if (parsed === null) {
      return NextResponse.json({ error: 'gateway_invalid_response' }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
    gatewayAvailable = parsed
  } catch {
    return NextResponse.json({ error: 'gateway_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  if (!includeHistory) return NextResponse.json({ gatewayAvailable }, { headers: { 'Cache-Control': 'no-store' } })

  const supabase = createServiceClient()
  const [callRes, purchaseRes] = await Promise.all([
    supabase.from('api_calls').select('id').eq('buyer_wallet', wallet),
    supabase.from('purchases').select('api_id, amount_usdc').eq('buyer_wallet', wallet),
  ])
  if (callRes.error || purchaseRes.error) {
    return NextResponse.json({ error: 'buyer_history_unavailable' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
  const totalCalls = callRes.data?.length ?? 0
  const totalSpent = purchaseRes.data?.reduce((sum, purchase) => sum + Number(purchase.amount_usdc), 0) ?? 0
  const purchasesByApiId: Record<string, number> = {}
  purchaseRes.data?.forEach(purchase => {
    purchasesByApiId[purchase.api_id] = (purchasesByApiId[purchase.api_id] ?? 0) + Number(purchase.amount_usdc)
  })
  return NextResponse.json({ gatewayAvailable, totalCalls, totalSpent, purchasesByApiId },
    { headers: { 'Cache-Control': 'no-store' } })
})
