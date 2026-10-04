import { NextRequest, NextResponse } from 'next/server'
import { withWalletSession } from '@/lib/marketplace/server'
import { getWalletTransactions, transactionQuery } from '@/lib/dashboard-transactions'

export const runtime = 'nodejs'

export const GET = withWalletSession(async (request: NextRequest, authenticatedWallet: string) => {
  const query = transactionQuery(new URL(request.url).searchParams)
  const history = await getWalletTransactions(authenticatedWallet, query)
  return NextResponse.json(history)
})
