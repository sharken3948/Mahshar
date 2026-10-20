import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { commissionTreasuryContext, findCommissionWithdrawalByKey,
  submitCommissionWithdrawal } from '@/lib/admin/commission-withdrawal-server'
import { usdcMicros } from '@/lib/admin/gateway-treasury-calculation'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const POST = withAdmin(async (request: NextRequest) => {
  const body = await request.json().catch(() => ({})) as {
    amount_usdc?: unknown; idempotency_key?: unknown; confirm?: unknown;
    quoted_source_fee_cap_usdc?: unknown; quoted_destination_gas_estimate_usdc?: unknown
  }
  if (body.confirm !== true || typeof body.idempotency_key !== 'string' || !UUID.test(body.idempotency_key)) {
    return NextResponse.json({ error: 'Explicit confirmation and idempotency key required' }, { status: 400 })
  }
  try {
    const prior = await findCommissionWithdrawalByKey(body.idempotency_key)
    if (prior) {
      if (usdcMicros(body.amount_usdc) !== usdcMicros(prior.amount_usdc) ||
        usdcMicros(body.quoted_source_fee_cap_usdc) !== usdcMicros(prior.source_fee_cap_usdc)) {
        return NextResponse.json({ error: 'Idempotency key amount or fee mismatch' }, { status: 409 })
      }
      return NextResponse.json({ withdrawal_id: prior.id, status: prior.status,
        amount_usdc: prior.amount_usdc, mint_value_usdc: prior.mint_value_usdc,
        source_fee_cap_usdc: prior.source_fee_cap_usdc,
        destination_gas_estimate_usdc: prior.destination_gas_estimate_usdc,
        mint_tx_hash: prior.mint_tx_hash ?? null,
      }, { status: prior.status === 'minted' ? 200 : 202 })
    }
    const { quote, gatewayAvailable } = await commissionTreasuryContext(body.amount_usdc)
    if (usdcMicros(body.quoted_source_fee_cap_usdc) < usdcMicros(quote.source_fee_cap_usdc) ||
      usdcMicros(body.quoted_destination_gas_estimate_usdc) < usdcMicros(quote.destination_gas_estimate_usdc)) {
      return NextResponse.json({ error: 'Fees changed; obtain and confirm a new quote' }, { status: 409 })
    }
    const row = await submitCommissionWithdrawal({
      idempotencyKey: body.idempotency_key, quote, gatewayAvailable,
    })
    return NextResponse.json({ withdrawal_id: row.id, status: row.status,
      amount_usdc: quote.amount_usdc, mint_value_usdc: quote.mint_value_usdc,
      source_fee_cap_usdc: quote.source_fee_cap_usdc,
      destination_gas_estimate_usdc: quote.destination_gas_estimate_usdc,
      mint_tx_hash: row.mint_tx_hash ?? null,
    }, { status: row.status === 'minted' ? 200 : row.status === 'expired' || row.status === 'failed' ? 409 : 202 })
  } catch {
    return NextResponse.json({ error: 'Commission withdrawal blocked or unavailable' }, { status: 409 })
  }
})
