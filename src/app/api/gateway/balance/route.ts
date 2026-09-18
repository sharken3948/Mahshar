import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { ARC, ARC_MAINNET } from '@/lib/arc'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const walletRaw = request.nextUrl.searchParams.get('wallet')
  if (!walletRaw) return NextResponse.json({ error: 'wallet is required' }, { status: 400 })
  if (!isValidWalletAddress(walletRaw)) return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
  const wallet = walletRaw.toLowerCase()

  let gatewayAvailable = '0'
  try {
    // Arc Mainnet on Gateway API is behind X-ARC-PRIVATE-MAINNET-ENABLED until Circle's public GA.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ARC.chainId === ARC_MAINNET.chainId) {
      headers['X-ARC-PRIVATE-MAINNET-ENABLED'] = 'true'
    }
    const res = await fetch(`${ARC.gatewayApi}/balances`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: 'USDC',
        sources: [{ depositor: wallet, domain: ARC.gatewayDomain }],
      }),
    })
    if (res.ok) {
      const data = await res.json() as { balances?: Array<{ balance: string }> }
      gatewayAvailable = data.balances?.[0]?.balance ?? '0'
    }
  } catch {
    // return 0 on error
  }

  const supabase = createServiceClient()
  let callData: { id: string }[] | null = null
  let purchaseData: { api_id: string; amount_usdc: number }[] | null = null
  try {
    const [callRes, purchaseRes] = await Promise.all([
      supabase.from('api_calls').select('id').eq('buyer_wallet', wallet),
      supabase.from('purchases').select('api_id, amount_usdc').eq('buyer_wallet', wallet),
    ])
    if (callRes.error) return NextResponse.json({ error: callRes.error.message }, { status: 500 })
    if (purchaseRes.error) return NextResponse.json({ error: purchaseRes.error.message }, { status: 500 })
    callData = callRes.data
    purchaseData = purchaseRes.data
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Failed to fetch balances: ${message}` }, { status: 500 })
  }

  const totalCalls = callData?.length ?? 0
  const totalSpent = purchaseData?.reduce((sum, p) => sum + Number(p.amount_usdc), 0) ?? 0

  const purchasesByApiId: Record<string, number> = {}
  purchaseData?.forEach(p => {
    purchasesByApiId[p.api_id] = (purchasesByApiId[p.api_id] ?? 0) + Number(p.amount_usdc)
  })

  return NextResponse.json({ gatewayAvailable, totalCalls, totalSpent, purchasesByApiId })
}
