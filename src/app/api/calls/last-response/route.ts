import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const apiId = searchParams.get('api_id')
  const buyerWallet = searchParams.get('buyer_wallet')

  if (!apiId || !buyerWallet) {
    return NextResponse.json({ error: 'api_id and buyer_wallet required' }, { status: 400 })
  }
  if (!isValidWalletAddress(buyerWallet)) {
    return NextResponse.json({ error: 'Invalid buyer_wallet address' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('api_calls')
    .select('response_body')
    .eq('api_id', apiId)
    .eq('buyer_wallet', buyerWallet.toLowerCase())
    .eq('success', true)
    .not('response_body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    return NextResponse.json({ response_body: null })
  }

  return NextResponse.json({ response_body: (data as { response_body: unknown }).response_body })
}
