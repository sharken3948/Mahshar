import 'server-only'

import { formatUnits, getAddress, isAddress, type Address } from 'viem'
import { NextRequest, NextResponse } from 'next/server'
import { ARC } from '@/lib/arc'
import { readServerArcWalletUsdc } from '@/lib/arc-balance-server'
import { enforceRateLimit } from '@/lib/rate-limit'

interface ArcBalanceRouteDependencies {
  rateLimit?: typeof enforceRateLimit
  readBalance?: (wallet: Address) => ReturnType<typeof readServerArcWalletUsdc>
}

export async function handleArcBalanceRequest(request: NextRequest, dependencies: ArcBalanceRouteDependencies = {}) {
  const rawWallet = request.nextUrl.searchParams.get('wallet')
  if (!rawWallet || !isAddress(rawWallet, { strict: true })) {
    return NextResponse.json({ error: 'invalid_wallet' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const wallet = getAddress(rawWallet)
  const limited = await (dependencies.rateLimit ?? enforceRateLimit)({
    request,
    scope: 'arc-wallet-balance',
    limit: 60,
    windowSeconds: 60,
    wallet: wallet.toLowerCase(),
    failClosed: true,
  })
  if (limited) return limited

  try {
    const result = await (dependencies.readBalance ?? readServerArcWalletUsdc)(wallet)
    if (result.status !== 'fresh' || result.value === undefined) throw new Error('Arc balance read unavailable')
    return NextResponse.json({
      wallet,
      chain_id: ARC.chainId,
      balance_raw: result.value.toString(),
      balance_usdc: formatUnits(result.value, 6),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'arc_balance_unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' },
    })
  }
}
