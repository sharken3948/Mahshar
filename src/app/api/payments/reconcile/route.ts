import { NextRequest, NextResponse } from 'next/server'
import { withWalletSession } from '@/lib/marketplace/server'
import { createServiceClient } from '@/lib/supabase/server'
import { settlementStore } from '@/lib/payments/server'
import { recoverSettlement, type Attempt } from '@/lib/payments/settlement'

export const runtime = 'nodejs'
export const POST = withWalletSession(async (request: NextRequest, wallet: string) => {
  const body = await request.json().catch(() => null)
  if (!body || Object.keys(body).length !== 1 || typeof body.attemptId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(body.attemptId)) {
    return NextResponse.json({ error: 'Invalid recovery request' }, { status: 400 })
  }
  const db = createServiceClient()
  const { data, error } = await db.from('x402_settlement_attempts').select('*').eq('id', body.attemptId).eq('binding->>payer', wallet).maybeSingle()
  if (error) return NextResponse.json({ error: 'Payment recovery unavailable' }, { status: 503 })
  if (!data) return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
  const result = await recoverSettlement(settlementStore(db), data as Attempt)
  return NextResponse.json({ ...result, delivery_state: (data as Attempt).delivery_state ?? 'UNKNOWN' }, { status: result.success ? 200 : result.status ?? 409 })
})
