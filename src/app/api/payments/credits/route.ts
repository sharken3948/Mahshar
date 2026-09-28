import { withWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isValidWalletAddress } from '@/lib/wallet-validation';
import type { CreditBalance } from '@/types';
import { readBoundedJson, RequestBodyError } from '@/lib/request-body';

export const runtime = 'nodejs';

export const GET = withWalletSession(async (request: NextRequest, wallet: string) => {
  const { searchParams } = new URL(request.url);
  assertWalletClaim(searchParams.get('wallet'), wallet)
  const walletKey = wallet.toLowerCase();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('credit_balances')
    .select('*')
    .eq('buyer_wallet', walletKey)
    .single<CreditBalance>();

  if (error && error.code === 'PGRST116') {
    return NextResponse.json({ balance_usdc: 0, buyer_wallet: walletKey });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
})

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-internal-secret');
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    action: 'topup' | 'deduct';
    buyer_wallet: string;
    amount_usdc: number;
    api_id?: string;
    tx_hash?: string;
  };
  try { body = await readBoundedJson<typeof body>(request, 16 * 1024) }
  catch (error) {
    const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
    return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' }, { status: tooLarge ? 413 : 400 })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { action, buyer_wallet, amount_usdc, api_id, tx_hash } = body;

  if (!action || !buyer_wallet || !amount_usdc) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (action !== 'topup' && action !== 'deduct') {
    return NextResponse.json({ error: 'Unknown credits action' }, { status: 400 });
  }
  if (!isValidWalletAddress(buyer_wallet)) {
    return NextResponse.json({ error: 'Invalid buyer_wallet address' }, { status: 400 });
  }
  if (typeof amount_usdc !== 'number' || !isFinite(amount_usdc) || amount_usdc <= 0) {
    return NextResponse.json({ error: 'amount_usdc must be a positive number' }, { status: 400 });
  }

  const normalizedBuyerWallet = buyer_wallet.toLowerCase();
  const supabase = createServiceClient();

  if (action === 'deduct') {
    if (!api_id || !tx_hash) return NextResponse.json({ error: 'api_id and tx_hash are required for deductions' }, { status: 400 })
    const { data: rpcResult, error: rpcError } = await supabase.rpc('deduct_credits_and_record_purchase', {
      p_wallet: normalizedBuyerWallet,
      p_amount: amount_usdc,
      p_api_id: api_id,
      p_tx_hash: tx_hash,
    });
    if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

    const result = rpcResult as { ok: boolean; balance_usdc: number };
    if (!result.ok) {
      return NextResponse.json({ error: 'Insufficient credits', balance_usdc: result.balance_usdc }, { status: 402 });
    }

    return NextResponse.json({ balance_usdc: result.balance_usdc });
  }

  const { data: topupResult, error: topupError } = await supabase.rpc('topup_credits_atomic', {
    p_wallet: normalizedBuyerWallet,
    p_amount: amount_usdc,
  });
  if (topupError) return NextResponse.json({ error: topupError.message }, { status: 500 });
  const result = topupResult as { ok: boolean; balance_usdc: number }
  if (!result?.ok) return NextResponse.json({ error: 'Credit topup failed' }, { status: 500 })
  return NextResponse.json({ balance_usdc: result.balance_usdc });
}
