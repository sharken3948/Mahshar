import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const wallet = searchParams.get('buyer_wallet')
  if (!wallet) return NextResponse.json({ error: 'buyer_wallet required' }, { status: 400 })
  if (!isValidWalletAddress(wallet)) return NextResponse.json({ error: 'Invalid buyer_wallet address' }, { status: 400 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('purchases')
    .select('id, amount_usdc, tx_hash, created_at, api_listings(name, category)')
    .eq('buyer_wallet', wallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ purchases: data })
}
