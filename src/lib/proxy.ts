import { createServiceClient } from '@/lib/supabase/server';
import { decryptKey } from '@/lib/crypto';
import type { ApiListing, PaymentModel } from '@/types';

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

export async function proxyRequest(params: {
  apiId: string;
  buyerWallet: string;
  paymentType: PaymentModel;
  method: string;
  path: string;
  incomingHeaders: Record<string, string>;
  body?: unknown;
}): Promise<ProxyResult> {
  const supabase = createServiceClient();

  const { data: listing, error } = await supabase
    .from('api_listings')
    .select('*')
    .eq('id', params.apiId)
    .eq('is_active', true)
    .single<ApiListing>();

  if (error || !listing) {
    return { status: 404, headers: {}, body: { error: 'API not found' }, latencyMs: 0 };
  }

  const targetUrl = listing.endpoint_url.replace(/\/$/, '') + (params.path || '');

  const forwardHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (listing.auth_type === 'apikey' && listing.encrypted_key) {
    const apiKey = decryptKey(listing.encrypted_key);
    forwardHeaders['x-api-key'] = apiKey;
  } else if (listing.auth_type === 'bearer' && listing.encrypted_key) {
    const token = decryptKey(listing.encrypted_key);
    forwardHeaders['authorization'] = `Bearer ${token}`;
  }

  const start = Date.now();
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(targetUrl, {
      method: params.method,
      headers: forwardHeaders,
      body: params.method !== 'GET' && params.body ? JSON.stringify(params.body) : undefined,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false });
    return { status: 502, headers: {}, body: { error: 'Upstream unreachable' }, latencyMs };
  }

  const latencyMs = Date.now() - start;
  const responseHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((v, k) => { responseHeaders[k] = v; });

  let responseBody: unknown;
  const ct = upstreamResponse.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    responseBody = await upstreamResponse.json();
  } else {
    responseBody = await upstreamResponse.text();
  }

  const success = upstreamResponse.status >= 200 && upstreamResponse.status < 300;
  await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success });

  return { status: upstreamResponse.status, headers: responseHeaders, body: responseBody, latencyMs };
}

async function logCall(params: {
  supabase: ReturnType<typeof createServiceClient>;
  apiId: string;
  buyerWallet: string;
  paymentType: PaymentModel;
  latencyMs: number;
  success: boolean;
}) {
  await params.supabase.from('api_calls').insert({
    api_id: params.apiId,
    buyer_wallet: params.buyerWallet,
    payment_type: params.paymentType,
    latency_ms: params.latencyMs,
    success: params.success,
  });
}
