import { NextRequest, NextResponse } from 'next/server';
import { scoreApi, type RealTestResult } from '@/lib/groq';
import { createServiceClient } from '@/lib/supabase/server';
import { validateEndpointUrl } from '@/lib/url-validation';
import type { AuthType } from '@/types';

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

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
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
  return status != null && TRANSIENT_STATUSES.has(status);
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

export async function POST(request: NextRequest) {
  const body = await request.json() as {
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
  };

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

  if (canTest) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const startTime = Date.now();
    let timedOut = false;

    const testUrlObj = new URL(endpoint_url);
    if (auth_type === 'queryparam' && auth_key && auth_param_name) {
      testUrlObj.searchParams.set(auth_param_name, auth_key);
    }
    const testUrl = testUrlObj.toString();

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth_type === 'apikey' && auth_key) headers['x-api-key'] = auth_key;
      else if (auth_type === 'bearer' && auth_key) headers['Authorization'] = `Bearer ${auth_key}`;

      const response = await fetch(testUrl, {
        method,
        headers,
        body: bodySent ?? undefined,
        redirect: 'manual',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const latency_ms = Date.now() - startTime;

      // Always read body as text first (avoids double-consume of response stream)
      let rawBody = '';
      try { rawBody = await response.text(); } catch { /* ignore */ }
      const snippet = rawBody ? (rawBody.length > 200 ? rawBody.slice(0, 200) + '…' : rawBody) : null;

      if (response.status >= 300 && response.status < 400) {
        realTestResult = { success: false, status: response.status, latency_ms, error: `Redirect (${response.status})`, response_snippet: snippet ?? undefined };
      } else if (response.ok) {
        let parsedBody: unknown;
        try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
        realTestResult = { success: true, status: response.status, latency_ms, body: parsedBody };
      } else {
        realTestResult = { success: false, status: response.status, latency_ms, error: `HTTP ${response.status}`, response_snippet: snippet ?? undefined };
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const latency_ms = Date.now() - startTime;
      timedOut = err instanceof Error && err.name === 'AbortError';
      realTestResult = {
        success: false,
        latency_ms,
        error: timedOut ? 'Request timed out after 5 seconds' : (err instanceof Error ? err.message : 'Network error'),
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
        .eq('id', api_id);
      transientCount = newCount; // use updated count in messages
    }

    // Hard block on any non-2xx — with contextual messaging
    if (!realTestResult.success) {
      const status = realTestResult.status ?? null;
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

  // Reached here: test passed (2xx) or was skipped — run Groq qualitative scoring
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
    const { error: scoreError } = await supabase
      .from('api_listings')
      .update(updates)
      .eq('id', api_id);
    if (scoreError) {
      return NextResponse.json({ error: `Score computed but failed to save: ${scoreError.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ...result,
    endpoint_verified: realTestResult?.success === true,
    endpoint_test_note: endpointTestNote,
    endpoint_test_diagnostic: diagnostic,
    field_errors: [] satisfies FieldError[],
  });
}
