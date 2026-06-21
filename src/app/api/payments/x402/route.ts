import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { handle402, buildPaymentHeader, retryWithPayment } from '@/lib/x402';
import { validateEndpointUrl } from '@/lib/url-validation';
import { isValidWalletAddress } from '@/lib/wallet-validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    api_id: string;
    buyer_wallet: string;
    target_url: string;
    method?: string;
    payload?: unknown;
    signature: string;
    nonce: string;
  };

  const { api_id, buyer_wallet, target_url, method = 'GET', payload, signature, nonce } = body;

  if (!api_id || !buyer_wallet || !target_url || !signature || !nonce) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (!isValidWalletAddress(buyer_wallet)) {
    return NextResponse.json({ error: 'Invalid buyer_wallet address' }, { status: 400 });
  }

  const urlValidation = await validateEndpointUrl(target_url);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: 'Invalid target URL', reason: urlValidation.error }, { status: 400 });
  }

  // Initial request — may return 402
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
    body: method !== 'GET' && payload ? JSON.stringify(payload) : undefined,
  };

  let firstResponse: Response;
  try {
    firstResponse = await fetch(target_url, init);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Upstream unreachable: ${message}` }, { status: 502 });
  }

  const paymentRequired = await handle402(firstResponse);

  if (!paymentRequired) {
    const data = await firstResponse.json().catch(() => ({}));
    return NextResponse.json({ data, status: firstResponse.status });
  }

  // Build and attach x-payment header, then retry
  const paymentHeader = buildPaymentHeader(paymentRequired, buyer_wallet, signature, nonce);
  let retried: Response;
  try {
    retried = await retryWithPayment(target_url, init, paymentHeader);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Upstream unreachable on retry: ${message}` }, { status: 502 });
  }

  if (!retried.ok) {
    return NextResponse.json({ error: 'Payment rejected by upstream' }, { status: retried.status });
  }

  const responseData = await retried.json().catch(() => ({}));

  const amountUsdc = parseFloat(paymentRequired.maxAmountRequired);
  if (!isFinite(amountUsdc)) {
    return NextResponse.json({ error: 'Invalid payment amount in upstream response' }, { status: 502 });
  }

  // Record the purchase
  const supabase = createServiceClient();
  const { error: purchaseError } = await supabase.from('purchases').insert({
    buyer_wallet: buyer_wallet.toLowerCase(),
    api_id,
    amount_usdc: amountUsdc,
    tx_hash: nonce,
  });
  if (purchaseError) {
    return NextResponse.json({ error: `Payment settled but record failed: ${purchaseError.message}` }, { status: 500 });
  }

  return NextResponse.json({ data: responseData, payment_required: paymentRequired });
}
