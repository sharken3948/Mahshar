import { createServiceClient } from '@/lib/supabase/server';
import { decryptKey } from '@/lib/crypto';
import type { ApiListing, PaymentModel } from '@/types';

export interface ProxyResult {
  status: number;
  body: unknown;
  latencyMs: number;
}

// 4xx codes that indicate a bad request from the buyer, not a broken seller API
const CLIENT_FAULT_CODES = new Set([400, 404, 405, 408, 422]);

// 5MB cap — keeps us well inside Vercel's 4.5MB response limit and prevents memory abuse
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// null = success, true = client-fault, false = seller-fault
function classifyStatus(status: number): boolean | null {
  if (status >= 200 && status < 400) return null;
  if (CLIENT_FAULT_CODES.has(status)) return true;
  return false; // 401, 403, 5xx → seller's responsibility
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
    return { status: 404, body: { error: 'API not found' }, latencyMs: 0 };
  }

  const baseUrl = listing.endpoint_url.replace(/\/$/, '') + (params.path || '');
  const urlObj = new URL(baseUrl);

  const forwardHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (listing.auth_type === 'apikey' && listing.encrypted_key) {
    try {
      forwardHeaders['x-api-key'] = decryptKey(listing.encrypted_key);
    } catch {
      return { status: 500, body: { error: 'Failed to decrypt API credentials' }, latencyMs: 0 };
    }
  } else if (listing.auth_type === 'bearer' && listing.encrypted_key) {
    try {
      forwardHeaders['authorization'] = `Bearer ${decryptKey(listing.encrypted_key)}`;
    } catch {
      return { status: 500, body: { error: 'Failed to decrypt API credentials' }, latencyMs: 0 };
    }
  } else if (listing.auth_type === 'queryparam' && listing.encrypted_key && listing.auth_param_name) {
    try {
      urlObj.searchParams.set(listing.auth_param_name, decryptKey(listing.encrypted_key));
    } catch {
      return { status: 500, body: { error: 'Failed to decrypt API credentials' }, latencyMs: 0 };
    }
  }

  const targetUrl = urlObj.toString();

  const start = Date.now();
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(targetUrl, {
      method: params.method,
      headers: forwardHeaders,
      body: params.method !== 'GET' && params.body ? JSON.stringify(params.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
    void checkAndAutoDeactivate(supabase, params.apiId);
    return { status: 502, body: { error: 'Upstream unreachable' }, latencyMs };
  }

  const latencyMs = Date.now() - start;

  // Reject oversized responses before reading into memory
  const contentLengthHint = upstreamResponse.headers.get('content-length');
  if (contentLengthHint) {
    const declared = parseInt(contentLengthHint, 10);
    if (isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
      void checkAndAutoDeactivate(supabase, params.apiId);
      return { status: 502, body: { error: 'Upstream response exceeds the 5MB size limit' }, latencyMs };
    }
  }

  // Read body as buffer so we can enforce the size limit on the actual bytes
  const buffer = await upstreamResponse.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
    void checkAndAutoDeactivate(supabase, params.apiId);
    return { status: 502, body: { error: 'Upstream response exceeds the 5MB size limit' }, latencyMs };
  }

  const rawText = new TextDecoder().decode(buffer);
  const ct = upstreamResponse.headers.get('content-type') ?? '';
  let responseBody: unknown;
  if (ct.includes('application/json')) {
    try { responseBody = JSON.parse(rawText); } catch { responseBody = rawText; }
  } else {
    responseBody = rawText;
  }

  const success = upstreamResponse.status >= 200 && upstreamResponse.status < 300;
  const isClientError = classifyStatus(upstreamResponse.status);
  await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success, isClientError });
  void checkAndAutoDeactivate(supabase, params.apiId);

  return { status: upstreamResponse.status, body: responseBody, latencyMs };
}

async function logCall(params: {
  supabase: ReturnType<typeof createServiceClient>;
  apiId: string;
  buyerWallet: string;
  paymentType: PaymentModel;
  latencyMs: number;
  success: boolean;
  isClientError: boolean | null;
}) {
  await params.supabase.from('api_calls').insert({
    api_id: params.apiId,
    buyer_wallet: params.buyerWallet.toLowerCase(),
    payment_type: params.paymentType,
    latency_ms: params.latencyMs,
    success: params.success,
    is_client_error: params.isClientError,
  });
}

async function checkAndAutoDeactivate(
  supabase: ReturnType<typeof createServiceClient>,
  apiId: string,
): Promise<void> {
  try {
    const { data: recent } = await supabase
      .from('api_calls')
      .select('success, is_client_error, buyer_wallet')
      .eq('api_id', apiId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!recent) return;

    // Exclude client-fault rows — they don't reflect seller health
    const nonClientFault = recent.filter(c => c.is_client_error !== true);

    // Check 1: 5 consecutive seller-fault failures with >= 2 distinct buyer wallets
    const last5 = nonClientFault.slice(0, 5);
    if (
      last5.length >= 5 &&
      last5.every(c => !c.success && c.is_client_error === false)
    ) {
      const distinctWallets = new Set(last5.map(c => c.buyer_wallet as string)).size;
      if (distinctWallets >= 2) {
        await supabase.from('api_listings').update({ is_active: false }).eq('id', apiId);
        console.log(`[auto-deactivate] api_id=${apiId} reason=consecutive_failures`);
        return;
      }
    }

    // Check 2: success rate below 80% over last 20 non-client-fault calls, >= 2 distinct wallets
    const last20 = nonClientFault.slice(0, 20);
    if (last20.length >= 20) {
      const successRate = last20.filter(c => c.success).length / 20;
      if (successRate < 0.80) {
        const distinctWallets = new Set(last20.map(c => c.buyer_wallet as string)).size;
        if (distinctWallets >= 2) {
          await supabase.from('api_listings').update({ is_active: false }).eq('id', apiId);
          console.log(`[auto-deactivate] api_id=${apiId} reason=low_success_rate`);
        }
      }
    }
  } catch (err) {
    console.error('[auto-deactivate] check failed:', err);
  }
}
