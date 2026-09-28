'use client';
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { MahsharFlowMotif } from '@/components/MahsharFlowMotif';
import type { AuthType, PaymentModel } from '@/types';
import type { DeclaredParameter } from '@/lib/marketplace/proxy-target';
import { RequestParameterEditor } from '@/components/RequestParameterEditor';
import styles from './onboarding-form.module.css';

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
  expected_status_codes: string;
  body_required: boolean;
  dynamic_path_supported: boolean;
  path_parameters: DeclaredParameter[];
  query_parameters: DeclaredParameter[];
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
  score: number | null;
  suggested_price: number | null;
  approved: boolean;
  critical_issues: string[];
  warnings: string[];
  positives: string[];
  summary: string;
  inconclusive?: boolean;
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
  expected_status_codes: '',
  body_required: false,
  dynamic_path_supported: false,
  path_parameters: [],
  query_parameters: [],
};

// Parse the comma-separated field into a validated integer array (300-599).
// Returns { ok: true, codes } — codes is undefined when the field is blank.
// Returns { ok: false, error } for any malformed entry.
function parseExpectedStatusCodesInput(
  raw: string,
): { ok: true; codes: number[] | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, codes: undefined };
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: true, codes: undefined };
  if (parts.length > 20) return { ok: false, error: 'Enter at most 20 status codes' };
  const codes: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { ok: false, error: `"${part}" is not a valid HTTP status code` };
    const n = Number(part);
    if (n < 300 || n > 599) return { ok: false, error: `Codes must be between 300 and 599 — got ${n}` };
    if (!codes.includes(n)) codes.push(n);
  }
  return { ok: true, codes };
}

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
  const persistedSensitive = useRef<Pick<FormState, 'endpoint_url' | 'method' | 'auth_type' | 'auth_key' | 'auth_param_name' |
    'body_required' | 'dynamic_path_supported' | 'path_parameters' | 'query_parameters'> | null>(null)
  const { request: marketplaceFetch, sensitiveRequest } = useMarketplaceSession()
  useEffect(() => {
    setForm({ ...initialState, seller_wallet: sellerWallet ?? '' });
    setApiId(null);
    setScoreResult(null);
    setError(null);
    persistedSensitive.current = null;
  }, [sellerWallet]);

  const isBodyMethod = form.method !== 'GET';
  const authComplete = form.auth_type === 'public' || Boolean(form.auth_key.trim() && (form.auth_type !== 'queryparam' || form.auth_param_name.trim()));
  const requestComplete = !form.body_required || needsRequestBody(form.example_request);
  const readyForReview = Boolean(form.name && form.description && form.example_response && form.endpoint_url && form.seller_wallet && authComplete && requestComplete);

  function update<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => {
      if (field === 'method') {
        const method = String(value)
        return { ...prev, method, body_required: method === 'POST' || method === 'PUT',
          ...(method === 'GET' ? { example_request: '' } : {}) }
      }
      return { ...prev, [field]: value }
    });
    // Clear field error as soon as the seller edits that field
    if (fieldErrors[field]) {
      setFieldErrors(prev => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
    // Re-run score on method/example_request/expected-codes change so stale results don't persist
    if (field === 'method' || field === 'example_request' || field === 'expected_status_codes') {
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
    if (form.body_required && !needsRequestBody(form.example_request)) {
      setFieldErrors({ example_request: `${form.method} APIs must include a non-empty example_request so buyers know what parameters to send.` });
      setError(null);
      return;
    }
    const expectedParsed = parseExpectedStatusCodesInput(form.expected_status_codes);
    if (!expectedParsed.ok) {
      setFieldErrors({ expected_status_codes: expectedParsed.error });
      setError(null);
      return;
    }
    const expectedCodes = expectedParsed.codes;
    setScoring(true);
    setError(null);
    setFieldErrors({});
    try {
      let currentApiId = apiId;

      if (!currentApiId) {
        const createRes = await marketplaceFetch('/api/apis', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...form,
            price_per_call: parseFloat(form.price_per_call) || 0.001,
            auth_key: form.auth_key || undefined,
            auth_param_name: form.auth_param_name || undefined,
            expected_status_codes: expectedCodes,
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
        persistedSensitive.current = sensitiveSnapshot(form);
      }

      else {
        const previous = persistedSensitive.current;
        const next = sensitiveSnapshot(form);
        const sensitiveChanged = !previous || JSON.stringify(previous) !== JSON.stringify(next);
        const saveBody: Record<string, unknown> = { ...form, price_per_call: parseFloat(form.price_per_call) || 0.001,
          expected_status_codes: expectedCodes ?? [] };
        if (previous?.auth_key === form.auth_key) delete saveBody.auth_key;
        const save = await (sensitiveChanged ? sensitiveRequest : marketplaceFetch)(`/api/apis/${currentApiId}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(saveBody),
        });
        if (!save.ok) { setError((await save.json()).error ?? 'Failed to save listing'); return; }
        persistedSensitive.current = next;
      }

      const scoreRes = await marketplaceFetch('/api/ai/score', {
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
          expected_status_codes: expectedCodes,
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
      if (!data.inconclusive && typeof data.suggested_price === 'number' && data.suggested_price > 0) {
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
      const res = await marketplaceFetch(`/api/apis/${apiId}`, {
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
    <form onSubmit={handleSubmit} className={styles.form}>
      {error && <div className={styles.alert}>{error}</div>}
      <div className={styles.workspace}>
        <div className={styles.mainColumn}>
          <PublishingSection number="01" title="API Details" helper="Tell buyers what your service does and who it helps." tone="blue">
            <div className={styles.stack}>
              <div className={styles.twoColumns}>
                <Field label="API Name" required><input required value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Weather Forecast API" className={inputCls()} /></Field>
                <Field label="Category" required><select value={form.category} onChange={(e) => update('category', e.target.value)} className={inputCls()}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Description<span className={styles.required}>*</span><button type="button" onClick={() => setShowDescHelp(true)} className={styles.helpButton} aria-label="Description writing guidance">i</button></label>
                <textarea required rows={3} maxLength={300} value={form.description} onChange={(e) => update('description', e.target.value)} placeholder="What does your API do? Who is it for?" className={inputCls()} />
                <div className={styles.descriptionMeta}><p>More detail helps agents understand your API&apos;s inputs, outputs, and use cases.</p><span>{form.description.length}/300 characters</span></div>
              </div>
            </div>
          </PublishingSection>

          <PublishingSection number="02" title="Endpoint & Access" helper="Configure how Mahshar reaches your existing API." tone="purple">
            <div className={styles.stack}>
              <div className={styles.endpointGrid}>
                <Field label="HTTP Method" required><select value={form.method} onChange={(e) => update('method', e.target.value)} className={inputCls(fieldErrors.method)}>{HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}</select>{fieldErrors.method && <p className={styles.fieldError}>{fieldErrors.method}</p>}</Field>
                <Field label="Endpoint URL" required><input required type="url" value={form.endpoint_url} onChange={(e) => update('endpoint_url', e.target.value)} placeholder="https://api.example.com/v1" className={inputCls(fieldErrors.endpoint_url)} />{fieldErrors.endpoint_url && <p className={styles.fieldError}>{fieldErrors.endpoint_url}</p>}</Field>
              </div>
              <div className={styles.twoColumns}>
                <Field label="Auth Type" required>
                  <select value={form.auth_type} onChange={(e) => update('auth_type', e.target.value as AuthType)} className={inputCls()}><option value="public">Public (no auth)</option><option value="apikey">API Key header (x-api-key)</option><option value="bearer">Bearer Token (Authorization header)</option><option value="queryparam">Query Parameter (e.g. ?appid=KEY)</option></select>
                </Field>
                {form.auth_type !== 'public' && <Field label="Auth Key / Token"><input type="password" value={form.auth_key} onChange={(e) => update('auth_key', e.target.value)} placeholder="Stored encrypted" className={inputCls(fieldErrors.auth_key)} />{fieldErrors.auth_key ? <p className={styles.fieldError}>{fieldErrors.auth_key}</p> : !form.auth_key && <p className={styles.fieldError}>Auth key is required for this auth type. Without it, buyers will receive errors after paying.</p>}</Field>}
              </div>
              {form.auth_type === 'public' && <div className={styles.warning}><span className={styles.warningIcon}>!</span><div><strong>Public endpoint</strong>Public endpoints can be called directly outside Mahshar. For stronger monetization protection, use API Key or Bearer Token authentication.</div></div>}
              {form.auth_type === 'queryparam' && <Field label="Query Parameter Name"><input value={form.auth_param_name} onChange={(e) => update('auth_param_name', e.target.value)} placeholder="e.g. appid, api_key, token" className={inputCls(fieldErrors.auth_param_name)} />{fieldErrors.auth_param_name ? <p className={styles.fieldError}>{fieldErrors.auth_param_name}</p> : <p className={styles.fieldHint}>The parameter name your API expects — your key will be appended as ?{form.auth_param_name || 'param'}=KEY</p>}</Field>}
              <Field label="Expected non-2xx status codes (optional)"><input value={form.expected_status_codes} onChange={(e) => update('expected_status_codes', e.target.value)} placeholder="e.g. 401, 409" className={inputCls(fieldErrors.expected_status_codes)} />{fieldErrors.expected_status_codes ? <p className={styles.fieldError}>{fieldErrors.expected_status_codes}</p> : <p className={styles.fieldHint}>If your API intentionally returns specific error codes in some cases (e.g. 401 for unauthenticated probes, 409 for conflicting writes), list them comma-separated so AI review doesn&apos;t auto-reject those responses. Transient codes (429, 502, 503, 504) and timeouts cannot be declared expected — they always signal infrastructure issues.</p>}</Field>
              <details className="rounded-xl border border-[#D8E3F2] bg-white p-4">
                <summary className="cursor-pointer text-sm font-semibold text-[#172033]">Path and query inputs</summary>
                <p className="mt-2 text-xs text-[#5B6B82]">Add only inputs buyers may control. Mahshar keeps authentication credentials separate and private.</p>
                <div className="mt-4 space-y-4">
                  <label className="flex items-center gap-2 text-sm font-medium text-[#33445D]"><input type="checkbox" checked={form.dynamic_path_supported} onChange={event => setForm(previous => ({ ...previous, dynamic_path_supported: event.target.checked, ...(!event.target.checked ? { path_parameters: [] } : {}) }))} />This endpoint accepts variable path segments</label>
                  {form.dynamic_path_supported && <RequestParameterEditor location="path" value={form.path_parameters} onChange={value => update('path_parameters', value)} />}
                  <RequestParameterEditor location="query" value={form.query_parameters} onChange={value => update('query_parameters', value)} />
                </div>
              </details>
            </div>
          </PublishingSection>

          <PublishingSection number="03" title="Pricing" helper="Mahshar handles pay-per-call payment requirements for buyers." tone="green">
            <div className={styles.stack}>
              <div className={styles.paymentModel}><div><strong>Payment model</strong><span>Pay-per-call (x402)</span></div><div className={styles.chips}><span className={styles.chip}>x402</span><span className={styles.chip}>USDC</span><span className={styles.chip}>Arc Mainnet</span></div></div>
              {scoreResult && !scoreResult.inconclusive && typeof scoreResult.suggested_price === 'number' && <div className={styles.pricePanel}><Field label="Price per call (USDC)" required><p className={styles.priceNote}>AI suggested: ${scoreResult.suggested_price} (you can adjust this)</p><input required type="number" step="0.0001" min="0.0001" value={form.price_per_call} onChange={(e) => update('price_per_call', e.target.value)} className={inputCls()} /></Field></div>}
            </div>
          </PublishingSection>

          <PublishingSection number="04" title="Example Request & Response" helper="Give buyers a clear template for calling your API." tone="pink">
            <div className={styles.stack}>
              <div className={styles.codeGrid}>
                <Field label={isBodyMethod ? `Example JSON Body${form.body_required ? ' *' : ''}` : 'Request inputs'}>{isBodyMethod ? <><label className="mb-2 flex items-center gap-2 text-xs text-[#40516A]"><input type="checkbox" checked={form.body_required} onChange={event => update('body_required', event.target.checked)} />A JSON body is required</label><textarea rows={5} required={form.body_required} value={form.example_request} onChange={(e) => update('example_request', e.target.value)} placeholder={'{"city": "London"}'} className={`${inputCls(fieldErrors.example_request)} ${styles.codeInput}`} />{fieldErrors.example_request ? <p className={styles.fieldError}>{fieldErrors.example_request}</p> : <p className={`${styles.fieldHint} ${styles.fieldHintBlue}`}>This is the body buyers can review and edit. Path and query examples come from the declared inputs above.</p>}</> : <p className={`${styles.fieldHint} ${styles.fieldHintBlue}`}>GET requests do not forward JSON bodies. Add path and query inputs in Endpoint &amp; Access, including an example for each required input.</p>}</Field>
                <Field label="Example Response (JSON)" required><textarea rows={5} value={form.example_response} onChange={(e) => update('example_response', e.target.value)} placeholder={'{"temp": 18, "condition": "Cloudy"}'} className={`${inputCls()} ${styles.codeInput}`} /></Field>
              </div>
            </div>
          </PublishingSection>
        </div>

        <aside className={styles.previewRail} aria-label="Listing preview and readiness">
          <MarketplacePreview form={form} />
          <Readiness form={form} requestComplete={requestComplete} authComplete={authComplete} readyForReview={readyForReview} />
        </aside>
        <div className={styles.actionColumn}>
          <div className={styles.reviewAction}><Button type="button" variant="primary" size="lg" onClick={handleScore} disabled={scoring || (form.auth_type !== 'public' && !form.auth_key) || (form.auth_type === 'queryparam' && !form.auth_param_name)} className={styles.reviewButton}>{scoring ? 'AI is analyzing your API...' : 'Continue to AI Review'}</Button><p className={styles.reviewHelp}>Your API will not be published yet.</p></div>
          {scoreResult && <ReviewReport result={scoreResult} />}
          {scoreResult && <div className={styles.publishBlock}><Button type="submit" variant="accent" size="lg" disabled={!scoreResult.approved || loading} className={styles.publishButton}>{loading ? 'Listing API...' : 'List My API'}</Button>{!scoreResult.approved && (scoreResult.inconclusive ? <p className={styles.publishWarning}>Review inconclusive. Click &quot;Continue to AI Review&quot; to try again.</p> : <p className={styles.publishWarning}>Fix the critical issues above before listing.</p>)}</div>}
        </div>
      </div>

      {showDescHelp && <div className={styles.modalOverlay}><div className={styles.modalBackdrop} onClick={() => setShowDescHelp(false)} /><div className={styles.modal}><div className={styles.modalHeader}><span>Writing a Great Description</span><button type="button" onClick={() => setShowDescHelp(false)} className={styles.modalClose}>&times;</button></div><div className={styles.modalBody}><div className={styles.modalExample}>✅ Good: &apos;Returns real-time weather data (temperature, humidity, wind speed) for any city worldwide. Accepts a city name or lat/lng coordinates. Response time under 200ms. Useful for travel apps, agriculture tools, or any service needing current conditions.&apos;</div><div className={`${styles.modalExample} ${styles.modalPoor}`}>❌ Too vague: &apos;Weather API&apos;</div><p>AI agents and buyers read this description to decide if your API fits their needs. The more specific you are about inputs, outputs, and use cases, the more your API will be discovered and used.</p></div><div className={styles.modalFooter}><button type="button" onClick={() => setShowDescHelp(false)} className={styles.modalButton}>Close</button></div></div></div>}
    </form>
  );
}

function sensitiveSnapshot(form: FormState) {
  return { endpoint_url: form.endpoint_url, method: form.method, auth_type: form.auth_type,
    auth_key: form.auth_key, auth_param_name: form.auth_param_name, body_required: form.body_required,
    dynamic_path_supported: form.dynamic_path_supported, path_parameters: form.path_parameters,
    query_parameters: form.query_parameters };
}

function PublishingSection({ number, title, helper, tone, children }: { number: string; title: string; helper: string; tone: 'blue' | 'purple' | 'green' | 'pink'; children: React.ReactNode }) {
  const toneClass = {
    blue: styles.sectionHeaderBlue,
    purple: styles.sectionHeaderPurple,
    green: styles.sectionHeaderGreen,
    pink: styles.sectionHeaderPink,
  }[tone];

  return <section className={styles.section}><header className={`${styles.sectionHeader} ${toneClass}`}><MahsharFlowMotif variant="card" tone={tone} className={styles.sectionFlow} /><span className={styles.sectionNumber}>{number}</span><div className={styles.sectionTitle}><h2>{title}</h2><p>{helper}</p></div></header><div className={styles.sectionBody}>{children}</div></section>;
}

function MarketplacePreview({ form }: { form: FormState }) {
  const wallet = form.seller_wallet ? `${form.seller_wallet.slice(0, 6)}...${form.seller_wallet.slice(-4)}` : 'Wallet not connected';
  const hasPrice = Boolean(form.price_per_call);

  return <section className={`${styles.railCard} ${styles.previewCard}`}><header className={styles.railHeader}><span>Marketplace Preview</span><span className={styles.liveIndicator}><i />Live preview</span></header><div className={styles.preview}><div className={styles.previewTop}><div><p className={`${styles.previewName} ${!form.name.trim() ? styles.placeholder : ''}`}>{form.name.trim() || 'Your API name'}</p><div className={styles.previewSubline}><span className={styles.categoryPill}>{form.category || 'Category'}</span><span>{form.auth_type === 'public' ? 'Public access' : form.auth_type}</span></div></div></div><p className={`${styles.previewDescription} ${!form.description.trim() ? styles.placeholder : ''}`}>{form.description.trim() || 'A clear description of your API will appear here for agents and applications.'}</p><div className={styles.previewMeta}><span className={styles.methodPill}>{form.method || 'Method'}</span><span className={styles.chip}>x402</span><span className={styles.chip}>Arc Mainnet</span></div><div className={styles.previewPriceRow}><div><span className={styles.previewPriceLabel}>Price per call</span><p className={`${styles.previewPrice} ${!hasPrice ? styles.placeholder : ''}`}>{hasPrice ? `$${form.price_per_call}` : 'Set after review'}{hasPrice && <small>USDC / call</small>}</p></div></div><div className={styles.previewFooter}><span className={styles.sellerLabel}>Seller wallet</span><p className={styles.wallet}>{wallet}</p></div></div></section>;
}

function Readiness({ form, requestComplete, authComplete, readyForReview }: { form: FormState; requestComplete: boolean; authComplete: boolean; readyForReview: boolean }) {
  const basicInformation = Boolean(form.seller_wallet && form.name.trim() && form.category && form.description.trim() && form.description.length <= 300);
  const endpointConfigured = Boolean(form.endpoint_url.trim() && form.method);
  const examplesProvided = Boolean(form.example_response.trim() && requestComplete);
  const accessState = form.auth_type === 'public' ? 'attention' : authComplete ? 'ready' : 'pending';
  const checks = [
    ['Basic information', basicInformation, 'ready'],
    ['Endpoint configured', endpointConfigured, 'ready'],
    ['Access configured', accessState !== 'pending', accessState],
    ['Examples provided', examplesProvided, 'ready'],
    ['Payment model · x402', form.payment_model === 'pay-per-call', 'ready'],
    ['Ready for AI review', readyForReview, 'final'],
  ] as const;

  return <section className={`${styles.railCard} ${styles.readinessCard}`}><header className={styles.railHeader}>Listing Readiness</header><div className={styles.readiness}>{checks.map(([label, complete, state]) => <div key={label} className={`${styles.readinessRow} ${complete ? styles.ready : ''} ${state === 'attention' ? styles.attention : ''} ${state === 'final' ? styles.readinessFinal : ''}`}><span className={styles.check}>{state === 'attention' ? '!' : complete ? '✓' : '·'}</span><span>{label}{state === 'attention' && <small>Public access</small>}</span></div>)}</div></section>;
}

function ReviewReport({ result }: { result: AiReport }) {
  if (result.inconclusive) {
    return <section className={styles.report}><div className={styles.reportHeader}><div><p className={styles.reportTitle}>Review inconclusive</p><p className={styles.reportSummary}>{result.summary || 'The automated reviewer could not complete a full check. Please try again in a moment.'}</p></div></div>{result.endpoint_test_diagnostic && <EndpointDiagnostic diagnostic={result.endpoint_test_diagnostic} />}</section>;
  }
  return <section className={styles.report}><div className={`${styles.reportHeader} ${result.approved ? styles.reportPassed : styles.reportFailed}`}><div><p className={styles.reportTitle}>{result.approved ? '✓ AI Review Passed' : '✗ AI Review Failed'}</p><p className={styles.reportSummary}>{result.summary}</p></div><p className={styles.score}>{result.score}<small>/10</small></p></div>{result.endpoint_test_diagnostic && <EndpointDiagnostic diagnostic={result.endpoint_test_diagnostic} />}{result.critical_issues?.length > 0 && <ReportList className={styles.issues} title="Critical Issues: Listing Blocked" items={result.critical_issues} />}{result.warnings?.length > 0 && <ReportList className={styles.warnings} title="Warnings: Please Fix" items={result.warnings} />}{result.positives?.length > 0 && <ReportList className={styles.positives} title="Looks Good" items={result.positives} />}{result.approved && typeof result.suggested_price === 'number' && <div className={styles.reportBlock}><p className={styles.reportSummary}>AI suggested price: <strong>${result.suggested_price} USDC/call</strong></p></div>}</section>;
}

function EndpointDiagnostic({ diagnostic }: { diagnostic: EndpointTestDiagnostic }) {
  const isSuccess = diagnostic.status != null && diagnostic.status >= 200 && diagnostic.status < 300;
  const statusText = diagnostic.status != null ? (HTTP_STATUS_LABELS[diagnostic.status] ?? '') : '';
  const statusLine = diagnostic.status != null ? `→ ${diagnostic.status}${statusText ? ` ${statusText}` : ''}` : '→ No response (timeout or network error)';
  const body = diagnostic.body_sent && diagnostic.body_sent.length > 120 ? `${diagnostic.body_sent.slice(0, 120)}…` : diagnostic.body_sent;
  return <div className={styles.reportBlock}><p className={styles.reportBlockLabel}>Live endpoint test</p><div className={styles.diagnostic}><p className={styles.diagnosticMuted}>{diagnostic.method} {diagnostic.url}</p>{body && <p className={styles.diagnosticMuted}>Body: {body}</p>}<p className={isSuccess ? styles.diagnosticSuccess : styles.diagnosticFailure}>{statusLine}</p>{diagnostic.response_snippet && <p>{diagnostic.response_snippet}</p>}</div></div>;
}

function ReportList({ title, items, className }: { title: string; items: string[]; className: string }) {
  return <div className={`${styles.reportBlock} ${className}`}><strong>{title}</strong><ul className={styles.reportList}>{items.map((item, index) => <li key={index}>• {item}</li>)}</ul></div>;
}

function needsRequestBody(exampleRequest: string): boolean {
  if (!exampleRequest) return false;
  try {
    const parsed = JSON.parse(exampleRequest);
    return parsed !== null;
  } catch {
    return false;
  }
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>
        {label}{required && <span className={styles.required}>*</span>}
      </label>
      {children}
    </div>
  );
}

function inputCls(error?: string): string {
  return error ? `${styles.input} ${styles.inputError}` : styles.input;
}
