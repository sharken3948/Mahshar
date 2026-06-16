import { NextRequest, NextResponse } from 'next/server';
import { proxyRequest } from '@/lib/proxy';
import type { PaymentModel } from '@/types';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    api_id: string;
    buyer_wallet: string;
    payment_type: PaymentModel;
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };

  const { api_id, buyer_wallet, payment_type, method = 'GET', path = '', headers = {}, body: requestBody } = body;

  if (!api_id || !buyer_wallet || !payment_type) {
    return NextResponse.json({ error: 'api_id, buyer_wallet, and payment_type are required' }, { status: 400 });
  }

  const result = await proxyRequest({
    apiId: api_id,
    buyerWallet: buyer_wallet,
    paymentType: payment_type,
    method,
    path,
    incomingHeaders: headers,
    body: requestBody,
  });

  return NextResponse.json(
    { data: result.body, latency_ms: result.latencyMs },
    {
      status: result.status,
      headers: { 'x-latency-ms': String(result.latencyMs) },
    }
  );
}
