import { credentialProxyAllowed } from '@/lib/marketplace/listing-security'
import { createServiceClient } from '@/lib/supabase/server';
import { decryptKey } from '@/lib/crypto';
import type { ApiListing, PaymentModel } from '@/types';
import { buildUpstreamFailureDiagnostic, fetchUpstreamWithoutRedirects, readResponseBytes, ResponseTooLargeError } from '@/lib/proxy-response';
import { buildUpstreamAuthentication } from '@/lib/marketplace/upstream-auth';
import { OutboundPolicyError } from '@/lib/outbound-fetch';

export type DeliveryOutcome = 'succeeded' | 'failed_final' | 'failed_retryable' | 'unknown';

export interface ProxyResult {
  status: number;
  body: unknown;
  latencyMs: number;
  deliveryOutcome: DeliveryOutcome;
  errorCode?: string;
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
    return { status: 404, body: { error: 'API not found' }, latencyMs: 0, deliveryOutcome: 'failed_retryable', errorCode: 'listing_unavailable' };
  }

  if (!credentialProxyAllowed(listing)) return { status: 409, body: { error: 'Endpoint requires verification' }, latencyMs: 0, deliveryOutcome: 'failed_retryable', errorCode: 'listing_verification_required' };

  const baseUrl = listing.endpoint_url.replace(/\/$/, '') + (params.path || '');
  const targetUrl = new URL(baseUrl).toString();

  const start = Date.now();
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetchUpstreamWithoutRedirects(targetUrl, (validatedUrl: URL) => {
      const credential = listing.encrypted_key && ['apikey', 'bearer', 'queryparam'].includes(listing.auth_type)
        ? decryptKey(listing.encrypted_key)
        : undefined;
      const { requestUrl, headers: forwardHeaders } = buildUpstreamAuthentication(
        validatedUrl, listing.auth_type, credential, listing.auth_param_name,
      );
      return { url: requestUrl, outboundInit: {
        method: params.method,
        headers: forwardHeaders,
        body: params.method !== 'GET' && params.body !== undefined ? JSON.stringify(params.body) : undefined,
        signal: AbortSignal.timeout(10000),
      } };
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
    void checkAndAutoDeactivate(supabase, params.apiId);
    const safelyRetryable = err instanceof OutboundPolicyError &&
      ['invalid_url', 'blocked_destination', 'dns_failure', 'blocked_port'].includes(err.classification);
    return {
      status: 502,
      body: { error: 'Upstream unreachable' },
      latencyMs,
      deliveryOutcome: safelyRetryable ? 'failed_retryable' : 'unknown',
      errorCode: safelyRetryable ? 'upstream_not_dispatched' : 'upstream_outcome_unknown',
    };
  }

  const latencyMs = Date.now() - start;

  // Reject oversized responses before reading into memory
  const contentLengthHint = upstreamResponse.headers.get('content-length');
  if (contentLengthHint) {
    const declared = parseInt(contentLengthHint, 10);
    if (isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      try {
        await upstreamResponse.body?.cancel();
      } catch {
        // The declared limit is sufficient to reject this response.
      }
      await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
      void checkAndAutoDeactivate(supabase, params.apiId);
      return { status: 502, body: { error: 'Upstream response exceeds the 5MB size limit' }, latencyMs, deliveryOutcome: 'failed_final', errorCode: 'upstream_response_too_large' };
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(upstreamResponse.body, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
      void checkAndAutoDeactivate(supabase, params.apiId);
      return { status: 502, body: { error: 'Upstream response exceeds the 5MB size limit' }, latencyMs, deliveryOutcome: 'failed_final', errorCode: 'upstream_response_too_large' };
    }
    await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
    void checkAndAutoDeactivate(supabase, params.apiId);
    return { status: 502, body: { error: 'Upstream unreachable' }, latencyMs, deliveryOutcome: 'unknown', errorCode: 'upstream_response_interrupted' };
  }

  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    // Defensive guard; readResponseBytes enforces this while consuming the stream.
    await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success: false, isClientError: false });
    void checkAndAutoDeactivate(supabase, params.apiId);
    return { status: 502, body: { error: 'Upstream response exceeds the 5MB size limit' }, latencyMs, deliveryOutcome: 'failed_final', errorCode: 'upstream_response_too_large' };
  }

  const rawText = new TextDecoder().decode(bytes);
  const ct = upstreamResponse.headers.get('content-type') ?? '';
  let responseBody: unknown;
  if (ct.includes('application/json')) {
    try { responseBody = JSON.parse(rawText); } catch { responseBody = rawText; }
  } else {
    responseBody = rawText;
  }

  const success = upstreamResponse.status >= 200 && upstreamResponse.status < 300;
  const isClientError = classifyStatus(upstreamResponse.status);
  // A status matching listing.expected_status_codes is one the seller has declared as
  // intentional API behaviour. Log it so checkAndAutoDeactivate can exclude it from the
  // seller-health counters (same shape as is_client_error). is_client_error stays
  // unchanged — 401 is still "not client-fault" from the buyer/seller-fault taxonomy.
  const declaredCodes: number[] = listing.expected_status_codes ?? [];
  const isDeclaredExpected = !success && declaredCodes.includes(upstreamResponse.status);
  const loggedResponseBody = success
    ? responseBody
    : buildUpstreamFailureDiagnostic(upstreamResponse.status, ct, rawText);
  await logCall({ supabase, apiId: params.apiId, buyerWallet: params.buyerWallet, paymentType: params.paymentType, latencyMs, success, isClientError, isDeclaredExpected, responseBody: loggedResponseBody });
  void checkAndAutoDeactivate(supabase, params.apiId);

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    return { status: 502, body: { error: 'Upstream redirects are not supported' }, latencyMs, deliveryOutcome: 'failed_final', errorCode: 'upstream_redirect_rejected' };
  }

  return {
    status: upstreamResponse.status,
    body: responseBody,
    latencyMs,
    deliveryOutcome: success ? 'succeeded' : 'failed_final',
    ...(!success ? { errorCode: 'upstream_http_error' } : {}),
  };
}

async function logCall(params: {
  supabase: ReturnType<typeof createServiceClient>;
  apiId: string;
  buyerWallet: string;
  paymentType: PaymentModel;
  latencyMs: number;
  success: boolean;
  isClientError: boolean | null;
  isDeclaredExpected?: boolean;
  responseBody?: unknown;
}) {
  await params.supabase.from('api_calls').insert({
    api_id: params.apiId,
    buyer_wallet: params.buyerWallet.toLowerCase(),
    payment_type: params.paymentType,
    latency_ms: params.latencyMs,
    success: params.success,
    is_client_error: params.isClientError,
    is_declared_expected: params.isDeclaredExpected ?? false,
    ...(params.responseBody !== undefined ? { response_body: params.responseBody } : {}),
  });
}

async function checkAndAutoDeactivate(
  supabase: ReturnType<typeof createServiceClient>,
  apiId: string,
): Promise<void> {
  try {
    const { data: recent } = await supabase
      .from('api_calls')
      .select('success, is_client_error, is_declared_expected, buyer_wallet')
      .eq('api_id', apiId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!recent) return;

    // Exclude client-fault rows — they don't reflect seller health.
    // Also exclude rows whose status was seller-declared as expected (parallel exclusion,
    // same shape as is_client_error): the seller advertised this response as intentional,
    // so it should not count against seller health the same way a genuine failure would.
    const nonClientFault = recent.filter(c => c.is_client_error !== true && c.is_declared_expected !== true);

    // Check 1: 5 consecutive seller-fault failures with >= 2 distinct buyer wallets
    const last5 = nonClientFault.slice(0, 5);
    if (
      last5.length >= 5 &&
      last5.every(c => !c.success && c.is_client_error === false)
    ) {
      const distinctWallets = new Set(last5.map(c => c.buyer_wallet as string)).size;
      if (distinctWallets >= 2) {
        await supabase.from('api_listings').update({ is_active: false }).eq('id', apiId);
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
        }
      }
    }
  } catch {
    // suppress auto-deactivate errors to avoid disrupting the main request
  }
}
