'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import type { AuthType, PaymentModel } from '@/types';

const CATEGORIES = ['AI', 'Data', 'Finance', 'Weather', 'Geo', 'Social', 'Media', 'Utility', 'Other'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

interface FormState {
  name: string;
  endpoint_url: string;
  method: string;
  description: string;
  price_per_call: string;
  payment_model: PaymentModel;
  category: string;
  seller_wallet: string;
  auth_type: AuthType;
  auth_key: string;
  auth_param_name: string;
  example_request: string;
  example_response: string;
}

interface FieldError {
  field: string;
  message: string;
}

interface EndpointTestDiagnostic {
  method: string;
  url: string;
  body_sent: string | null;
  status: number | null;
  response_snippet: string | null;
}

interface AiReport {
  score: number;
  suggested_price: number;
  approved: boolean;
  critical_issues: string[];
  warnings: string[];
  positives: string[];
  summary: string;
  field_errors?: FieldError[];
  endpoint_test_diagnostic?: EndpointTestDiagnostic | null;
}

const HTTP_STATUS_LABELS: Record<number, string> = {
  301: 'Moved Permanently', 302: 'Found', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const initialState: FormState = {
  name: '',
  endpoint_url: '',
  method: 'GET',
  description: '',
  price_per_call: '',
  payment_model: 'pay-per-call',
  category: 'AI',
  seller_wallet: '',
  auth_type: 'public',
  auth_key: '',
  auth_param_name: '',
  example_request: '',
  example_response: '',
};

export function OnboardingForm({ sellerWallet }: { sellerWallet?: string }) {
  const [form, setForm] = useState<FormState>({ ...initialState, seller_wallet: sellerWallet ?? '' });
  const [loading, setLoading] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [scoreResult, setScoreResult] = useState<AiReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiId, setApiId] = useState<string | null>(null);
  const [showDescHelp, setShowDescHelp] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const router = useRouter();

  const isBodyMethod = form.method === 'POST' || form.method === 'PUT';

  function update(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear field error as soon as the seller edits that field
    if (fieldErrors[field]) {
      setFieldErrors(prev => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
    // Re-run score on method/example_request change so stale results don't persist
    if (field === 'method' || field === 'example_request') {
      setScoreResult(null);
    }
  }

  async function handleScore() {
    if (!form.name || !form.description || !form.example_response || !form.endpoint_url || !form.seller_wallet) {
      setError('Fill in name, description, endpoint, example response, and connect your wallet to score.');
      return;
    }
    if (form.auth_type !== 'public' && !form.auth_key.trim()) {
      setFieldErrors({ auth_key: 'You selected an auth type that requires credentials, but no auth key was provided. We cannot verify your endpoint works without it, and listing an unverifiable API risks failed calls for buyers. Please provide a valid API key or token.' });
      setError(null);
      return;
    }
    if (form.auth_type === 'queryparam' && !form.auth_param_name.trim()) {
      setFieldErrors({ auth_param_name: 'Query parameter name is required (e.g. "appid", "api_key", "token").' });
      setError(null);
      return;
    }
    if (isBodyMethod && !needsRequestBody(form.example_request)) {
      setFieldErrors({ example_request: `${form.method} APIs must include a non-empty example_request so buyers know what parameters to send.` });
      setError(null);
      return;
    }
    setScoring(true);
    setError(null);
    setFieldErrors({});
    try {
      let currentApiId = apiId;

      if (!currentApiId) {
        const createRes = await fetch('/api/apis', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...form,
            price_per_call: parseFloat(form.price_per_call) || 0.001,
            auth_key: form.auth_key || undefined,
            auth_param_name: form.auth_param_name || undefined,
          }),
        });
        if (!createRes.ok) {
          const err = await createRes.json() as { error?: string };
          setError(err.error ?? 'Failed to create listing');
          return;
        }
        const created = await createRes.json() as { id: string };
        setApiId(created.id);
        currentApiId = created.id;
      }

      const scoreRes = await fetch('/api/ai/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_id: currentApiId,
          name: form.name,
          description: form.description,
          endpoint_url: form.endpoint_url,
          method: form.method,
          category: form.category,
          example_request: form.example_request,
          example_response: form.example_response,
          auth_type: form.auth_type,
          auth_key: form.auth_key || undefined,
          auth_param_name: form.auth_param_name || undefined,
        }),
      });
      const data = await scoreRes.json() as AiReport & { error?: string };

      if (!scoreRes.ok) {
        // Map field_errors from a 400 response (e.g. missing example_request for POST)
        if (data.field_errors?.length) {
          const map: Record<string, string> = {};
          for (const fe of data.field_errors) map[fe.field] = fe.message;
          setFieldErrors(map);
        } else {
          setError(data.error ?? 'Scoring failed. Please try again.');
        }
        return;
      }

      if (data.field_errors?.length) {
        const map: Record<string, string> = {};
        for (const fe of data.field_errors) map[fe.field] = fe.message;
        setFieldErrors(map);
      }

      setScoreResult(data);
      if (data.suggested_price) {
        setForm(f => ({ ...f, price_per_call: String(data.suggested_price) }));
      }
    } catch {
      setError('Scoring failed. Please try again.');
    } finally {
      setScoring(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/apis/${apiId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seller_wallet: form.seller_wallet,
          price_per_call: parseFloat(form.price_per_call),
          is_active: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Submission failed');
        return;
      }

      router.push('/buyer');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Basic info */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-[#0D0D0D]">Basic Info</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="API Name" required>
            <input
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="Weather Forecast API"
              className={inputCls()}
            />
          </Field>
          <Field label="Category" required>
            <select value={form.category} onChange={(e) => update('category', e.target.value)} className={inputCls()}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <label className="block text-sm font-medium text-[#0D0D0D]">
              Description<span className="text-[#2775CA] ml-0.5">*</span>
            </label>
            <button
              type="button"
              onClick={() => setShowDescHelp(true)}
              className="w-4 h-4 rounded-full border border-[#6B7280] text-[#6B7280] flex items-center justify-center text-[10px] font-bold leading-none hover:border-[#2775CA] hover:text-[#2775CA] transition-colors"
            >i</button>
          </div>
          <textarea
            required
            rows={3}
            maxLength={300}
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
            placeholder="What does your API do? Who is it for?"
            className={inputCls()}
          />
          <div className="flex items-center justify-between mt-1">
            <p className="text-xs text-[#6B7280]">More detail = better AI matching. Describe what your API does, what data it returns, and who it&apos;s for.</p>
            <span className="text-xs text-[#6B7280] flex-shrink-0 ml-2">{form.description.length}/300 characters</span>
          </div>
        </div>
      </section>

      {/* Endpoint */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-[#0D0D0D]">Endpoint</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="HTTP Method" required>
            <select
              value={form.method}
              onChange={(e) => update('method', e.target.value)}
              className={inputCls(fieldErrors.method)}
            >
              {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {fieldErrors.method && (
              <p className="text-xs text-[#DC2626] mt-1">{fieldErrors.method}</p>
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Endpoint URL" required>
              <input
                required
                type="url"
                value={form.endpoint_url}
                onChange={(e) => update('endpoint_url', e.target.value)}
                placeholder="https://api.example.com/v1"
                className={inputCls(fieldErrors.endpoint_url)}
              />
              {fieldErrors.endpoint_url && (
                <p className="text-xs text-[#DC2626] mt-1">{fieldErrors.endpoint_url}</p>
              )}
            </Field>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Auth Type" required>
            <select value={form.auth_type} onChange={(e) => update('auth_type', e.target.value as AuthType)} className={inputCls()}>
              <option value="public">Public (no auth)</option>
              <option value="apikey">API Key header (x-api-key)</option>
              <option value="bearer">Bearer Token (Authorization header)</option>
              <option value="queryparam">Query Parameter (e.g. ?appid=KEY)</option>
            </select>
            {form.auth_type === 'public' && (
              <p className="text-xs text-[#D97706] mt-1">⚠️ Public APIs can be accessed directly by anyone who discovers your endpoint URL, bypassing Mahshar&apos;s payment gate. Use API Key or Bearer Token if you need guaranteed revenue protection.</p>
            )}
          </Field>
          {form.auth_type !== 'public' && (
            <Field label="Auth Key / Token">
              <input
                type="password"
                value={form.auth_key}
                onChange={(e) => update('auth_key', e.target.value)}
                placeholder="Stored encrypted"
                className={inputCls(fieldErrors.auth_key)}
              />
              {fieldErrors.auth_key && (
                <p className="text-xs text-[#DC2626] mt-1">{fieldErrors.auth_key}</p>
              )}
              {!form.auth_key && !fieldErrors.auth_key && (
                <p className="text-xs text-[#DC2626] mt-1">⚠️ Auth key is required for this auth type. Without it, buyers will receive errors after paying.</p>
              )}
            </Field>
          )}
        </div>
        {form.auth_type === 'queryparam' && (
          <Field label="Query Parameter Name">
            <input
              value={form.auth_param_name}
              onChange={(e) => update('auth_param_name', e.target.value)}
              placeholder='e.g. appid, api_key, token'
              className={inputCls(fieldErrors.auth_param_name)}
            />
            {fieldErrors.auth_param_name ? (
              <p className="text-xs text-[#DC2626] mt-1">{fieldErrors.auth_param_name}</p>
            ) : (
              <p className="text-xs text-[#6B7280] mt-1">The parameter name your API expects — your key will be appended as ?{form.auth_param_name || 'param'}=KEY</p>
            )}
          </Field>
        )}
      </section>

      {/* Wallet */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-[#0D0D0D]">Payments</h2>
        <Field label="Payment Model">
          <div className="bg-[#F5F5F0] border border-[#E2E4E9] rounded-lg px-4 py-3 text-sm text-[#0D0D0D]">
            Pay-per-call (x402): buyer pays USDC for each API call
          </div>
        </Field>
      </section>

      {/* Examples + AI scoring */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-[#0D0D0D]">Example Request / Response</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`Example Request (JSON)${isBodyMethod ? ' *' : ''}`}>
            <textarea
              rows={5}
              required={isBodyMethod}
              value={form.example_request}
              onChange={(e) => update('example_request', e.target.value)}
              placeholder='{"city": "London"}'
              className={`${inputCls(fieldErrors.example_request)} font-mono text-xs`}
            />
            {fieldErrors.example_request ? (
              <p className="text-xs text-[#DC2626] mt-1">{fieldErrors.example_request}</p>
            ) : isBodyMethod ? (
              <p className="text-xs text-[#2775CA] mt-1">Required for {form.method} APIs — buyers see this as a template when calling your API.</p>
            ) : null}
          </Field>
          <Field label="Example Response (JSON)" required>
            <textarea
              rows={5}
              value={form.example_response}
              onChange={(e) => update('example_response', e.target.value)}
              placeholder='{"temp": 18, "condition": "Cloudy"}'
              className={`${inputCls()} font-mono text-xs`}
            />
          </Field>
        </div>

        <Button type="button" variant="primary" size="lg" onClick={handleScore} disabled={scoring || (form.auth_type !== 'public' && !form.auth_key) || (form.auth_type === 'queryparam' && !form.auth_param_name)} className="w-full">
          {scoring ? 'AI is analyzing your API...' : 'Send to AI Review'}
        </Button>

        {scoreResult && (
          <div className="mt-6 border border-[#E2E4E9] rounded-xl overflow-hidden">

            <div className={`px-6 py-4 flex items-center justify-between ${scoreResult.approved ? 'bg-[#F0FDF4]' : 'bg-[#FEF2F2]'}`}>
              <div>
                <span className={`text-lg font-bold ${scoreResult.approved ? 'text-[#16A34A]' : 'text-[#DC2626]'}`}>
                  {scoreResult.approved ? '✓ AI Review Passed' : '✗ AI Review Failed'}
                </span>
                <p className="text-sm text-[#6B7280] mt-0.5">{scoreResult.summary}</p>
              </div>
              <span className="text-2xl font-black text-[#2775CA]">{scoreResult.score}<span className="text-sm font-normal text-[#6B7280]">/10</span></span>
            </div>

            {scoreResult.endpoint_test_diagnostic && (() => {
              const d = scoreResult.endpoint_test_diagnostic!;
              const isSuccess = d.status != null && d.status >= 200 && d.status < 300;
              const statusText = d.status != null ? (HTTP_STATUS_LABELS[d.status] ?? '') : '';
              const statusLine = d.status != null
                ? `→ ${d.status}${statusText ? ` ${statusText}` : ''}`
                : '→ No response (timeout or network error)';
              const truncBody = d.body_sent && d.body_sent.length > 120
                ? d.body_sent.slice(0, 120) + '…'
                : d.body_sent;
              return (
                <div className="px-6 py-4 border-t border-[#E2E4E9]">
                  <p className="text-xs text-[#6B7280] font-medium mb-2">Live endpoint test</p>
                  <div className="bg-[#0D0D0D] rounded-xl p-4 font-mono text-xs overflow-x-auto">
                    <p className="text-[#9CA3AF]">{d.method} {d.url}</p>
                    {truncBody && <p className="text-[#9CA3AF] mt-0.5">Body: {truncBody}</p>}
                    <p className={`mt-1 font-bold ${isSuccess ? 'text-[#4ADE80]' : 'text-[#F87171]'}`}>{statusLine}</p>
                    {d.response_snippet && (
                      <p className="text-[#E2E4E9] mt-1 whitespace-pre-wrap break-all">{d.response_snippet}</p>
                    )}
                  </div>
                </div>
              );
            })()}

            {scoreResult.critical_issues && scoreResult.critical_issues.length > 0 && (
              <div className="px-6 py-4 border-t border-[#E2E4E9] bg-[#FEF2F2]">
                <p className="text-sm font-bold text-[#DC2626] mb-2">🚨 Critical Issues: Listing Blocked</p>
                <ul className="space-y-1">
                  {scoreResult.critical_issues.map((issue, i) => (
                    <li key={i} className="text-sm text-[#DC2626] flex gap-2"><span>•</span>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            {scoreResult.warnings && scoreResult.warnings.length > 0 && (
              <div className="px-6 py-4 border-t border-[#E2E4E9]">
                <p className="text-sm font-bold text-[#D97706] mb-2">⚠️ Warnings: Please Fix</p>
                <ul className="space-y-1">
                  {scoreResult.warnings.map((w, i) => (
                    <li key={i} className="text-sm text-[#D97706] flex gap-2"><span>•</span>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {scoreResult.positives && scoreResult.positives.length > 0 && (
              <div className="px-6 py-4 border-t border-[#E2E4E9]">
                <p className="text-sm font-bold text-[#16A34A] mb-2">✓ Looks Good</p>
                <ul className="space-y-1">
                  {scoreResult.positives.map((p, i) => (
                    <li key={i} className="text-sm text-[#16A34A] flex gap-2"><span>•</span>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {scoreResult.approved && (
              <div className="px-6 py-4 border-t border-[#E2E4E9] bg-[#FAFAF8]">
                <p className="text-sm text-[#6B7280]">AI suggested price: <span className="font-bold text-[#0D0D0D]">${scoreResult.suggested_price} USDC/call</span></p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Price — shown only after scoring */}
      {scoreResult && (
        <section className="space-y-4">
          <h2 className="text-base font-semibold text-[#0D0D0D]">Pricing</h2>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-[#0D0D0D]">
              Price per call (USDC)<span className="text-[#2775CA] ml-0.5">*</span>
            </label>
            <p className="text-xs text-[#6B7280] mb-2">AI suggested: ${scoreResult.suggested_price} (you can adjust this)</p>
            <input
              required
              type="number"
              step="0.0001"
              min="0.0001"
              value={form.price_per_call}
              onChange={(e) => update('price_per_call', e.target.value)}
              className={inputCls()}
            />
          </div>
        </section>
      )}

      {/* Submit — shown only after scoring */}
      {scoreResult && (
        <>
          <Button type="submit" variant="accent" size="lg" disabled={!scoreResult || !scoreResult.approved || loading} className="w-full disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-[#6B7280]">
            {loading ? 'Listing API...' : 'List My API'}
          </Button>
          {scoreResult && !scoreResult.approved && (
            <p className="text-sm text-[#DC2626] text-center mt-2">Fix the critical issues above before listing.</p>
          )}
        </>
      )}

      {showDescHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowDescHelp(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-[#E2E4E9] flex items-center justify-between">
              <span className="font-bold text-[#0D0D0D]">Writing a Great Description</span>
              <button type="button" onClick={() => setShowDescHelp(false)} className="text-[#6B7280] hover:text-[#0D0D0D] transition-colors text-xl leading-none">&times;</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-lg p-4">
                <p className="text-sm text-[#16A34A]">✅ Good: &apos;Returns real-time weather data (temperature, humidity, wind speed) for any city worldwide. Accepts a city name or lat/lng coordinates. Response time under 200ms. Useful for travel apps, agriculture tools, or any service needing current conditions.&apos;</p>
              </div>
              <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-lg p-4">
                <p className="text-sm text-[#DC2626]">❌ Too vague: &apos;Weather API&apos;</p>
              </div>
              <p className="text-sm text-[#6B7280]">AI agents and buyers read this description to decide if your API fits their needs. The more specific you are about inputs, outputs, and use cases, the more your API will be discovered and used.</p>
            </div>
            <div className="px-6 py-4 border-t border-[#E2E4E9]">
              <button type="button" onClick={() => setShowDescHelp(false)} className="w-full bg-[#0D0D0D] hover:bg-[#2D2D2D] text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

function needsRequestBody(exampleRequest: string): boolean {
  if (!exampleRequest) return false;
  try {
    const parsed = JSON.parse(exampleRequest);
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-[#0D0D0D]">
        {label}{required && <span className="text-[#2775CA] ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function inputCls(error?: string): string {
  const base = 'w-full rounded-lg border bg-[#FAFAF8] px-3 py-2.5 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:ring-1 transition-colors';
  return error
    ? `${base} border-[#DC2626] ring-[#DC2626] focus:border-[#DC2626]`
    : `${base} border-[#E2E4E9] focus:border-[#2775CA] focus:ring-[#2775CA]`;
}
