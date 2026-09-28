import { withWalletSession, requireListingOwner } from '@/lib/marketplace/server'
import { assertWalletClaim } from '@/lib/marketplace/operation-authorization'
import { matchListingConfiguration, normalizeExpectedStatusCodes } from '@/lib/marketplace/listing-security'
import { decryptKey } from '@/lib/crypto'
import { NextRequest, NextResponse } from 'next/server';
import { scoreApi, type RealTestResult } from '@/lib/groq';
import { createServiceClient } from '@/lib/supabase/server';
import { validateEndpointUrl } from '@/lib/url-validation';
import { OutboundPolicyError, safeOutboundFetch } from '@/lib/outbound-fetch';
import { assessRepresentativeResponseSize, MAX_SAFE_SERIALIZED_RESPONSE_BYTES, readResponseBytes,
  ResponseTooLargeError } from '@/lib/proxy-response';
import type { AuthType } from '@/types';
import { enforceRateLimit } from '@/lib/rate-limit';
import { readBoundedJson, RequestBodyError } from '@/lib/request-body';

export const runtime = 'nodejs';

export interface FieldError {
  field: 'method' | 'example_request' | 'endpoint_url' | 'auth_key';
  message: string;
}

export interface EndpointTestDiagnostic {
  method: string;
  url: string;
  body_sent: string | null;
  status: number | null; // null = network error / timeout (no HTTP response)
  response_snippet: string | null;
}

const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

const STATUS_LABELS: Record<number, string> = {
  301: 'Moved Permanently', 302: 'Found', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function needsRequestBody(exampleRequest: string | undefined): boolean {
  if (!exampleRequest) return false;
  try {
    const parsed = JSON.parse(exampleRequest);
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function isTransientStatus(status: number | null, timedOut: boolean): boolean {
  if (timedOut) return true;
  return status != null && (TRANSIENT_STATUSES.has(status) || status >= 500);
}

function statusLabel(status: number | null): string {
  if (status == null) return 'No response';
  const label = STATUS_LABELS[status];
  return label ? `${status} ${label}` : String(status);
}

function hardBlock(
  criticalIssue: string,
  fieldErrors: FieldError[],
  diagnostic: EndpointTestDiagnostic | null,
  endpointTestNote: string,
) {
  return NextResponse.json({
    score: 0,
    suggested_price: 0,
    approved: false,
    critical_issues: [criticalIssue],
    warnings: [],
    positives: [],
    summary: 'Listing blocked: fix the issue highlighted above, then re-submit for review.',
    endpoint_verified: false,
    endpoint_test_note: endpointTestNote,
    endpoint_test_diagnostic: diagnostic,
    field_errors: fieldErrors,
  });
}

export const POST = withWalletSession(async (request: NextRequest, authenticatedWallet: string) => {
  const limited = await enforceRateLimit({ request, scope: 'ai-score', limit: 10, windowSeconds: 60,
    wallet: authenticatedWallet, failClosed: true })
  if (limited) return limited
  let body: {
    api_id?: string;
    name: string;
    category: string;
    description: string;
    method?: string;
    example_request: string;
    example_response: string;
    endpoint_url: string;
    auth_type?: AuthType;
    auth_key?: string;
    auth_param_name?: string;
    expected_status_codes?: number[];
  };
  try { body = await readBoundedJson<typeof body>(request, 64 * 1024) }
  catch (error) {
    const tooLarge = error instanceof RequestBodyError && error.code === 'body_too_large'
    return NextResponse.json({ error: tooLarge ? 'request_too_large' : 'invalid_request' }, { status: tooLarge ? 413 : 400 })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  assertWalletClaim((body as { seller_wallet?: unknown }).seller_wallet, authenticatedWallet);
  const db = createServiceClient();
  const persistedListing = body.api_id ? await requireListingOwner(db, body.api_id, authenticatedWallet) : null;
  if (persistedListing) {
    // Existing listings are tested with server-stored configuration and credentials.
    body.endpoint_url = persistedListing.endpoint_url;
    body.method = persistedListing.method ?? 'GET';
    body.auth_type = persistedListing.auth_type;
    body.auth_param_name = persistedListing.auth_param_name ?? undefined;
    body.auth_key = persistedListing.encrypted_key ? decryptKey(persistedListing.encrypted_key) : undefined;
    body.example_request = persistedListing.example_request ?? '';
    body.expected_status_codes = (persistedListing.expected_status_codes as number[] | null) ?? undefined;
  }

  const expectedResult = normalizeExpectedStatusCodes(body.expected_status_codes);
  if (!expectedResult.ok) {
    return NextResponse.json({ error: expectedResult.error }, { status: 400 });
  }
  const expectedCodes: number[] = expectedResult.codes ?? [];

  const {
    api_id, name, category, description,
    method: rawMethod, example_request, example_response, endpoint_url,
    auth_type = 'public', auth_key, auth_param_name,
  } = body;

  const method = (rawMethod && ALLOWED_METHODS.has(rawMethod.toUpperCase()))
    ? rawMethod.toUpperCase()
    : 'GET';

  if (!name || !description || !example_response || !endpoint_url) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const isBodyMethod = method === 'POST' || method === 'PUT';

  // Pre-block: body method declared but no example_request (no live test needed to know this is wrong)
  if (isBodyMethod && !needsRequestBody(example_request)) {
    return NextResponse.json({
      score: 0,
      suggested_price: 0,
      approved: false,
      critical_issues: [`${method} APIs require a non-empty example_request so buyers know what parameters to send — without it every call will fail.`],
      warnings: [],
      positives: [],
      summary: 'Listing blocked: add an example_request before re-submitting.',
      endpoint_verified: false,
      endpoint_test_note: `Test skipped — example_request is required before testing a ${method} endpoint.`,
      endpoint_test_diagnostic: null,
      field_errors: [{
        field: 'example_request',
        message: `${method} APIs must include a non-empty example_request. Buyers see this as a template when calling your API.`,
      }] satisfies FieldError[],
    });
  }

  // Pre-block: auth type requires credentials but none provided
  if (auth_type !== 'public' && !auth_key) {
    return NextResponse.json({
      score: 0,
      suggested_price: 0,
      approved: false,
      critical_issues: ['You selected an auth type that requires credentials, but no auth key was provided. We cannot verify your endpoint works without it, and listing an unverifiable API risks failed calls for buyers. Please provide a valid API key or token.'],
      warnings: [],
      positives: [],
      summary: 'Listing blocked: provide an auth key before re-submitting.',
      endpoint_verified: false,
      endpoint_test_note: 'Test skipped — auth key required for non-public endpoints.',
      endpoint_test_diagnostic: null,
      field_errors: [{
        field: 'auth_key',
        message: 'An auth key is required for API Key and Bearer Token auth types.',
      }] satisfies FieldError[],
    });
  }

  // SSRF / private-IP check
  const urlValidation = await validateEndpointUrl(endpoint_url);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: 'Unsafe endpoint URL', reason: urlValidation.error }, { status: 400 });
  }

  const canTest = auth_type === 'public' || Boolean(auth_key);
  const bodySent = isBodyMethod && needsRequestBody(example_request) ? example_request : null;

  // Read current transient count before the live test
  const supabase = createServiceClient();
  let transientCount = 0;
  if (api_id && canTest) {
    const { data: listingData } = await supabase
      .from('api_listings')
      .select('consecutive_transient_count')
      .eq('id', api_id)
      .single();
    transientCount = listingData?.consecutive_transient_count ?? 0;
  }

  let realTestResult: RealTestResult | undefined;
  let diagnostic: EndpointTestDiagnostic | null = null;
  let endpointTestNote: string;
  let responseSizeBytes: number | null = null;
  let responseSizeWarning: string | null = null;
  let responseSizeBlocked = false;
  let rawResponseTooLarge = false;

  if (canTest) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const startTime = Date.now();
    let timedOut = false;

    const testUrl = new URL(endpoint_url).toString();

    try {
      const response = await safeOutboundFetch(testUrl, () => {
        const requestUrl = new URL(testUrl);
        if (auth_type === 'queryparam' && auth_key && auth_param_name) requestUrl.searchParams.set(auth_param_name, auth_key);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (auth_type === 'apikey' && auth_key) headers['x-api-key'] = auth_key;
        else if (auth_type === 'bearer' && auth_key) headers.Authorization = `Bearer ${auth_key}`;
        return { url: requestUrl, outboundInit: {
          method,
          headers,
          body: bodySent ?? undefined,
          redirect: 'manual',
          signal: controller.signal,
        } };
      }, { timeoutMs: 5000 });

      clearTimeout(timeoutId);
      const latency_ms = Date.now() - startTime;

      // Always read body as text first (avoids double-consume of response stream)
      let rawBody = '';
      try { rawBody = new TextDecoder().decode(await readResponseBytes(response.body, MAX_SAFE_SERIALIZED_RESPONSE_BYTES)); }
      catch (error) {
        if (error instanceof ResponseTooLargeError) rawResponseTooLarge = true;
        else throw error;
      }
      if (auth_key) rawBody = rawBody.split(auth_key).join('[redacted]');
      const snippet = rawBody ? (rawBody.length > 200 ? rawBody.slice(0, 200) + '…' : rawBody) : null;

      if (rawResponseTooLarge) {
        realTestResult = { success: false, status: response.status, latency_ms, error: 'Response exceeds Mahshar\'s delivery size limit' };
      } else if (response.status >= 300 && response.status < 400) {
        realTestResult = { success: false, status: response.status, latency_ms, error: `Redirect (${response.status})`, response_snippet: snippet ?? undefined };
      } else if (response.ok) {
        let parsedBody: unknown;
        try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
        const size = assessRepresentativeResponseSize(parsedBody);
        responseSizeBytes = size.serializedBytes;
        responseSizeBlocked = size.exceedsLimit;
        responseSizeWarning = size.warning && !size.exceedsLimit
          ? 'Verification response is near Mahshar\'s delivery size limit; larger responses may fail.' : null;
        realTestResult = size.exceedsLimit
          ? { success: false, status: response.status, latency_ms, error: 'Response exceeds Mahshar\'s delivery size limit' }
          : { success: true, status: response.status, latency_ms, body: parsedBody };
      } else {
        realTestResult = { success: false, status: response.status, latency_ms, error: `HTTP ${response.status}`, response_snippet: snippet ?? undefined };
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const latency_ms = Date.now() - startTime;
      timedOut = (err instanceof OutboundPolicyError && err.classification === 'timeout') || (err instanceof Error && err.name === 'AbortError');
      realTestResult = {
        success: false,
        latency_ms,
        error: timedOut ? 'Request timed out after 5 seconds' : 'Endpoint request failed',
      };
    }

    // Build the diagnostic block — redact the key value from queryparam URLs
    const displayUrl = (auth_type === 'queryparam' && auth_param_name)
      ? (() => { const u = new URL(endpoint_url); u.searchParams.set(auth_param_name, '****'); return u.toString(); })()
      : endpoint_url;

    // Build the diagnostic block (always, for both success and failure)
    diagnostic = {
      method,
      url: displayUrl,
      body_sent: bodySent,
      status: realTestResult.status ?? null,
      response_snippet: realTestResult.success ? null : (realTestResult.response_snippet ?? null),
    };

    if (rawResponseTooLarge || responseSizeBlocked) {
      return NextResponse.json({
        score: 0, suggested_price: 0, approved: false,
        critical_issues: ['The representative endpoint response exceeds Mahshar\'s delivery size limit. Reduce or paginate the response before publishing.'],
        warnings: [], positives: [],
        summary: 'Listing blocked: the verification response is too large to deliver safely.',
        endpoint_verified: false, endpoint_test_note: 'Response exceeds the delivery size limit.',
        endpoint_test_diagnostic: diagnostic, field_errors: [],
        response_size_bytes: responseSizeBytes, response_size_blocked: true,
      }, { status: 422 });
    }

    const testNote = realTestResult.success
      ? `${method} test passed in ${realTestResult.latency_ms}ms`
      : timedOut ? 'Timed out after 5s'
      : `${statusLabel(realTestResult.status ?? null)}`;
    endpointTestNote = testNote;

    // Update consecutive_transient_count in DB
    if (api_id) {
      const isTransient = isTransientStatus(realTestResult.status ?? null, timedOut);
      const newCount = isTransient ? transientCount + 1 : 0;
      await supabase
        .from('api_listings')
        .update({ consecutive_transient_count: newCount })
        .eq('id', api_id).ilike('seller_wallet', authenticatedWallet);
      transientCount = newCount; // use updated count in messages
    }

    // If the seller declared this exact non-2xx status as expected, skip the hard-block
    // and let Groq weigh it qualitatively (see failure-branch prompt in src/lib/groq.ts).
    // Transient statuses (429/502/503/504) and timeouts are never treated as "declared
    // expected" — those signal infrastructure problems that a seller shouldn't be able to opt out of.
    const status = realTestResult.status ?? null;
    const isDeclaredExpectedFailure =
      !realTestResult.success &&
      status != null &&
      !timedOut &&
      !isTransientStatus(status, false) &&
      expectedCodes.includes(status);
    if (isDeclaredExpectedFailure) {
      realTestResult.declared_expected = true;
    }

    // Hard block on any non-2xx — with contextual messaging
    if (!realTestResult.success && !isDeclaredExpectedFailure) {
      const isTransient = isTransientStatus(status, timedOut);
      let criticalIssue: string;
      let fieldErrors: FieldError[] = [];

      if (timedOut || status == null) {
        // Timeout / unreachable
        criticalIssue = transientCount >= 3
          ? `Your endpoint has timed out ${transientCount} times in a row during review. This is unlikely to be temporary — check whether your endpoint has IP whitelisting, a very low rate limit, or geographic restrictions that could be blocking automated requests from our review system.`
          : `Your endpoint did not respond within 5 seconds. This may be a temporary issue — try again in a moment. If it keeps timing out, verify that your endpoint is publicly reachable and not behind a firewall or IP allowlist.`;
      } else if (isTransient) {
        // 429 / 502 / 503 / 504
        criticalIssue = transientCount >= 3
          ? `Your endpoint has returned ${statusLabel(status)} ${transientCount} times in a row. This may not be a temporary issue — check whether your endpoint has IP whitelisting, a very low rate limit, or geographic restrictions blocking automated requests from our review system.`
          : `Your endpoint returned ${statusLabel(status)}. This is often temporary (rate limiting, brief downtime, or cold start). Try again in a moment.`;
      } else if (status === 405) {
        criticalIssue = `Your endpoint returned 405 Method Not Allowed for a ${method} request. Change the HTTP Method field to match what your endpoint actually accepts — the response snippet may show which methods are allowed.`;
        fieldErrors = [{ field: 'method', message: `Endpoint rejected ${method} with 405. Update HTTP Method to match your API.` }];
      } else if (status === 401 || status === 403) {
        criticalIssue = `Your endpoint returned ${statusLabel(status)} — authentication failed. Check that your auth key is correct and has the necessary permissions to call this endpoint.`;
        fieldErrors = [{ field: 'auth_key', message: `Auth rejected with ${status}. Verify the key is correct and active.` }];
      } else if (status === 404) {
        criticalIssue = `Your endpoint returned 404 Not Found. Verify that the URL is correct, the path exists, and the endpoint is publicly accessible.`;
        fieldErrors = [{ field: 'endpoint_url', message: '404 Not Found — verify this URL is correct and publicly reachable.' }];
      } else if (status === 400 || status === 422) {
        if (!needsRequestBody(example_request)) {
          criticalIssue = `Your endpoint returned ${statusLabel(status)} for a ${method} request with no body. If your API requires input parameters, switch HTTP Method to POST and fill in example_request. If it uses query parameters, append them to the endpoint URL directly (e.g. ?city=London).`;
          fieldErrors = [{ field: 'example_request', message: 'Endpoint appears to require input parameters — add an example_request or append query params to the URL.' }];
        } else {
          criticalIssue = `Your endpoint returned ${statusLabel(status)} when called with your example_request body. The response snippet above typically shows which fields are invalid or missing — update your example_request to match exactly what your API expects.`;
          fieldErrors = [{ field: 'example_request', message: `Request rejected with ${status} — update example_request to match your API's expected input.` }];
        }
      } else if (status >= 300 && status < 400) {
        criticalIssue = `Your endpoint returned a redirect (${status}). We don't follow redirects for security reasons. Update the endpoint URL to the final destination.`;
        fieldErrors = [{ field: 'endpoint_url', message: `Endpoint redirects (${status}) — use the final destination URL directly.` }];
      } else {
        // 500, 501, other 5xx
        criticalIssue = `Your endpoint returned a server error (${statusLabel(status)}). Check that your service is running correctly and that the URL points to the right handler.`;
      }

      return hardBlock(criticalIssue, fieldErrors, diagnostic, endpointTestNote);
    }
  } else {
    endpointTestNote = 'Endpoint test skipped — auth key not provided';
  }

  // Reached here: test passed (2xx), was skipped, OR returned a seller-declared expected non-2xx.
  // Run Groq qualitative scoring — for declared expected-failures the failure-branch prompt
  // (with the declared_expected note) fires, letting Groq make the final call.
  let result;
  try {
    result = await scoreApi(
      { name, category, description, endpoint_url, example_request, example_response },
      realTestResult,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (api_id) {
    const updates: Record<string, unknown> = { score: result.score };
    if (result.approved) updates.consecutive_transient_count = 0;
    // Model approval is advisory. Only a successful live endpoint probe can
    // grant the security-relevant verified state.
    if (realTestResult?.success === true) updates.verified_at = new Date().toISOString();
    const { data: saved, error: scoreError } = await matchListingConfiguration(supabase
      .from('api_listings').update(updates).eq('id', api_id).ilike('seller_wallet', authenticatedWallet), persistedListing!).select('id');
    if (!scoreError && !saved?.length) return NextResponse.json({ error: 'Listing changed during review; retry' }, { status: 409 });
    if (scoreError) {
      return NextResponse.json({ error: `Score computed but failed to save: ${scoreError.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ...result,
    warnings: responseSizeWarning && !result.warnings.includes(responseSizeWarning)
      ? [...result.warnings, responseSizeWarning] : result.warnings,
    endpoint_verified: realTestResult?.success === true,
    endpoint_test_note: endpointTestNote,
    endpoint_test_diagnostic: diagnostic,
    field_errors: [] satisfies FieldError[],
    response_size_bytes: responseSizeBytes,
    response_size_warning: responseSizeWarning,
  });
});
