import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isValidWalletAddress } from '@/lib/wallet-validation';
import type { CreditBalance } from '@/types';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet');
  if (!wallet) return NextResponse.json({ error: 'wallet is required' }, { status: 400 });
  if (!isValidWalletAddress(wallet)) return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });

  const normalizedWallet = wallet.toLowerCase();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('credit_balances')
    .select('*')
    .eq('buyer_wallet', normalizedWallet)
    .single<CreditBalance>();

  if (error && error.code === 'PGRST116') {
    return NextResponse.json({ balance_usdc: 0, buyer_wallet: normalizedWallet });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-internal-secret');
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json() as {
    action: 'topup' | 'deduct';
    buyer_wallet: string;
    amount_usdc: number;
    api_id?: string;
    tx_hash?: string;
  };

  const { action, buyer_wallet, amount_usdc, api_id, tx_hash } = body;

  if (!action || !buyer_wallet || !amount_usdc) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (!isValidWalletAddress(buyer_wallet)) {
    return NextResponse.json({ error: 'Invalid buyer_wallet address' }, { status: 400 });
  }
  if (typeof amount_usdc !== 'number' || !isFinite(amount_usdc) || amount_usdc <= 0) {
    return NextResponse.json({ error: 'amount_usdc must be a positive number' }, { status: 400 });
  }

  const normalizedWallet = buyer_wallet.toLowerCase();
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('credit_balances')
    .select('id, balance_usdc')
    .eq('buyer_wallet', normalizedWallet)
    .single<CreditBalance>();

  const currentBalance = existing?.balance_usdc ?? 0;

  if (action === 'deduct') {
    if (currentBalance < amount_usdc) {
      return NextResponse.json({ error: 'Insufficient credits', balance_usdc: currentBalance }, { status: 402 });
    }

    const newBalance = currentBalance - amount_usdc;
    const { error: upsertError } = await supabase.from('credit_balances').upsert({
      buyer_wallet: normalizedWallet,
      balance_usdc: newBalance,
      updated_at: new Date().toISOString(),
    });
    if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

    if (api_id) {
      const { error: insertError } = await supabase.from('purchases').insert({
        buyer_wallet: normalizedWallet,
        api_id,
        amount_usdc,
        tx_hash: tx_hash ?? `credit-${Date.now()}`,
      });
      if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ balance_usdc: newBalance });
  }

  // topup
  const newBalance = currentBalance + amount_usdc;
  const { error: topupError } = await supabase.from('credit_balances').upsert({
    buyer_wallet: normalizedWallet,
    balance_usdc: newBalance,
    updated_at: new Date().toISOString(),
  });
  if (topupError) return NextResponse.json({ error: topupError.message }, { status: 500 });

  return NextResponse.json({ balance_usdc: newBalance });
}
