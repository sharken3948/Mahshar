'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import { RequestParameterEditor } from '@/components/RequestParameterEditor'
import type { AuthType, PaymentModel } from '@/types'
import type { DeclaredParameter } from '@/lib/marketplace/proxy-target'
import styles from './onboarding-form.module.css'

const CATEGORIES = ['AI', 'Data', 'Finance', 'Weather', 'Geo', 'Social', 'Media', 'Utility', 'Other']
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE']
const CREDENTIAL_QUERY_NAMES = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|auth[_-]?token|appid)$/i

interface FormState {
  name: string
  endpoint_url: string
  method: string
  description: string
  price_per_call: string
  payment_model: PaymentModel
  category: string
  seller_wallet: string
  auth_type: AuthType
  auth_key: string
  auth_param_name: string
  example_request: string
  example_response: string
  body_required: boolean
  dynamic_path_supported: boolean
  path_parameters: DeclaredParameter[]
  query_parameters: DeclaredParameter[]
}

interface SetupSuggestions {
  name: string | null
  description: string | null
  category: string | null
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | null
  auth_type: AuthType | null
  auth_param_name: string | null
  example_request: string | null
  example_response: string | null
  body_required: boolean | null
  path_parameters: DeclaredParameter[]
  query_parameters: DeclaredParameter[]
}

interface AnalysisResult {
  score: number | null
  suggested_price: number | null
  ai_available: boolean
  inconclusive: boolean
  summary: string
  endpoint_verified: boolean
  endpoint_test_note: string
  blocking_issue: string | null
  warnings: string[]
  positives: string[]
  critical_issues: string[]
  field_errors: Array<{ field: string; message: string }>
  suggestions: SetupSuggestions
  analysis?: {
    method: string
    status: number | null
    status_text: string
    latency_ms: number | null
    content_type: string | null
    json_response: boolean
    authentication_likely: boolean
    detected_parameter_count: number
  }
}

const initialState: FormState = {
  name: '',
  endpoint_url: '',
  method: 'GET',
  description: '',
  price_per_call: '0.001',
  payment_model: 'pay-per-call',
  category: 'AI',
  seller_wallet: '',
  auth_type: 'public',
  auth_key: '',
  auth_param_name: '',
  example_request: '',
  example_response: '',
  body_required: false,
  dynamic_path_supported: false,
  path_parameters: [],
  query_parameters: [],
}

const ANALYSIS_FIELDS = new Set<keyof FormState>([
  'endpoint_url', 'method', 'auth_type', 'auth_key', 'auth_param_name', 'example_request', 'body_required',
  'dynamic_path_supported', 'path_parameters', 'query_parameters',
])

export function OnboardingForm({ sellerWallet }: { sellerWallet?: string }) {
  const [form, setForm] = useState<FormState>({ ...initialState, seller_wallet: sellerWallet ?? '' })
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [apiId, setApiId] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const credentialRef = useRef<HTMLInputElement>(null)
  const persistedSensitive = useRef<ReturnType<typeof sensitiveSnapshot> | null>(null)
  const router = useRouter()
  const { request: marketplaceFetch, sensitiveRequest } = useMarketplaceSession()

  useEffect(() => {
    setForm({ ...initialState, seller_wallet: sellerWallet ?? '' })
    setAnalysis(null)
    setApiId(null)
    setError(null)
    setNotice(null)
    setFieldErrors({})
    persistedSensitive.current = null
  }, [sellerWallet])

  const authComplete = form.auth_type === 'public' || Boolean(form.auth_key.trim() &&
    (form.auth_type !== 'queryparam' || form.auth_param_name.trim()))
  const price = Number(form.price_per_call)
  const priceValid = Number.isFinite(price) && price > 0
  const metadataComplete = Boolean(form.name.trim() && form.description.trim() && form.category)
  const endpointVerified = analysis?.endpoint_verified === true
  const requestValid = endpointVerified && analysis.field_errors.length === 0
  const exampleTested = endpointVerified
  const readiness = [endpointVerified, requestValid, authComplete, exampleTested, priceValid]
  const readyCount = readiness.filter(Boolean).length
  const publishReady = metadataComplete && endpointVerified && requestValid && authComplete && priceValid
  const isBodyMethod = form.method !== 'GET'
  const allParameters = [...form.path_parameters.map(parameter => ({ ...parameter, location: 'path' as const })),
    ...form.query_parameters.map(parameter => ({ ...parameter, location: 'query' as const }))]
  const suggestionCount = useMemo(() => analysis ? countSuggestions(analysis) : 0, [analysis])

  function update<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm(previous => {
      if (field === 'method' && value === 'GET') {
        return { ...previous, method: String(value), body_required: false, example_request: '' }
      }
      return { ...previous, [field]: value }
    })
    if (ANALYSIS_FIELDS.has(field)) setAnalysis(null)
    if (fieldErrors[field]) setFieldErrors(previous => {
      const next = { ...previous }
      delete next[field]
      return next
    })
    setError(null)
    setNotice(null)
  }

  function analysisPayload(extra: Record<string, unknown> = {}) {
    return {
      ...form,
      auth_key: form.auth_key || undefined,
      auth_param_name: form.auth_param_name || undefined,
      path_parameters: form.dynamic_path_supported ? form.path_parameters : [],
      query_parameters: form.query_parameters,
      ...extra,
    }
  }

  async function analyzeEndpoint() {
    if (!form.endpoint_url.trim()) {
      setFieldErrors({ endpoint_url: 'Paste the public HTTPS endpoint you want to list.' })
      return
    }
    setAnalyzing(true)
    setError(null)
    setNotice(null)
    setFieldErrors({})
    try {
      const response = await marketplaceFetch('/api/ai/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analysisPayload()),
      })
      const result = await response.json().catch(() => null) as (Partial<AnalysisResult> & { error?: string }) | null
      if (!result || typeof result.endpoint_verified !== 'boolean') {
        setError(result?.error ?? 'Endpoint analysis is temporarily unavailable. Try again.')
        return
      }
      const completed = result as AnalysisResult & { error?: string }
      setAnalysis(completed)
      setFieldErrors(Object.fromEntries((completed.field_errors ?? []).map(item => [item.field, item.message])))
      if (!response.ok && !completed.blocking_issue) setError(completed.error ?? 'Endpoint analysis could not be completed.')
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Endpoint analysis is temporarily unavailable.')
    } finally {
      setAnalyzing(false)
    }
  }

  function applySuggestions() {
    if (!analysis) return
    const suggested = analysis.suggestions
    setForm(previous => {
      const next = { ...previous }
      if (suggested.name) next.name = suggested.name
      if (suggested.description) next.description = suggested.description
      if (suggested.category) next.category = suggested.category
      if (suggested.method) next.method = suggested.method
      if (suggested.auth_type) next.auth_type = suggested.auth_type
      if (suggested.auth_param_name) next.auth_param_name = suggested.auth_param_name
      if (suggested.example_request && suggested.method !== 'GET') next.example_request = suggested.example_request
      if (suggested.example_response) next.example_response = suggested.example_response
      if (suggested.body_required !== null && next.method !== 'GET') next.body_required = suggested.body_required
      if (suggested.path_parameters.length) {
        next.dynamic_path_supported = true
        next.path_parameters = suggested.path_parameters
      }

      let endpoint: URL | null = null
      try { endpoint = new URL(next.endpoint_url) } catch { endpoint = null }
      const inferredQuery = suggested.query_parameters.map(parameter => {
        const raw = endpoint?.searchParams.get(parameter.name)
        return raw === null || raw === undefined ? parameter : { ...parameter, example: inferredExample(raw, parameter.type) }
      })
      if (inferredQuery.length) next.query_parameters = inferredQuery

      if (endpoint) {
        for (const parameter of inferredQuery) endpoint.searchParams.delete(parameter.name)
        const credentialName = suggested.auth_param_name ?? [...endpoint.searchParams.keys()]
          .find(name => CREDENTIAL_QUERY_NAMES.test(name))
        if (credentialName) {
          const credential = endpoint.searchParams.get(credentialName)
          if (credential) next.auth_key = credential
          endpoint.searchParams.delete(credentialName)
          next.auth_type = 'queryparam'
          next.auth_param_name = credentialName
        }
        next.endpoint_url = endpoint.toString()
      }
      if (next.method === 'GET') {
        next.body_required = false
        next.example_request = ''
      }
      return next
    })
    setAnalysis(null)
    setFieldErrors({})
    setNotice('Suggestions applied. Review the setup, then analyze once more to verify the updated request.')
  }

  function addToken() {
    const suggestedAuth = analysis?.suggestions.auth_type
    if (form.auth_type === 'public') update('auth_type', suggestedAuth && suggestedAuth !== 'public' ? suggestedAuth : 'bearer')
    window.setTimeout(() => credentialRef.current?.focus(), 0)
  }

  async function saveDraft() {
    const payload = {
      ...form,
      price_per_call: price,
      auth_key: form.auth_key || undefined,
      auth_param_name: form.auth_param_name || undefined,
      example_request: isBodyMethod ? form.example_request : '',
      body_required: isBodyMethod ? form.body_required : false,
      dynamic_path_supported: form.dynamic_path_supported,
      path_parameters: form.dynamic_path_supported ? form.path_parameters : [],
      query_parameters: form.query_parameters,
    }
    if (!apiId) {
      const response = await marketplaceFetch('/api/apis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const result = await response.json().catch(() => ({})) as { id?: string; error?: string; field?: string }
      if (!response.ok || !result.id) throw new Error(result.error ?? 'The listing could not be created.')
      setApiId(result.id)
      persistedSensitive.current = sensitiveSnapshot(form)
      return result.id
    }

    const previous = persistedSensitive.current
    const next = sensitiveSnapshot(form)
    const sensitiveChanged = !previous || JSON.stringify(previous) !== JSON.stringify(next)
    const patch: Record<string, unknown> = { ...payload }
    if (previous?.auth_key === form.auth_key) delete patch.auth_key
    const response = await (sensitiveChanged ? sensitiveRequest : marketplaceFetch)(`/api/apis/${apiId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(result.error ?? 'The listing could not be updated.')
    persistedSensitive.current = next
    return apiId
  }

  async function publish(event: FormEvent) {
    event.preventDefault()
    if (!publishReady) {
      setError('Complete the required details and verify the endpoint before publishing.')
      return
    }
    setPublishing(true)
    setError(null)
    setNotice(null)
    try {
      const id = await saveDraft()
      const reviewResponse = await marketplaceFetch('/api/ai/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analysisPayload({ api_id: id })),
      })
      const review = await reviewResponse.json().catch(() => null) as (AnalysisResult & { error?: string }) | null
      if (!reviewResponse.ok || !review?.endpoint_verified) {
        if (review) {
          setAnalysis(review)
          setFieldErrors(Object.fromEntries((review.field_errors ?? []).map(item => [item.field, item.message])))
        }
        throw new Error(review?.blocking_issue ?? review?.error ?? 'The stored endpoint could not be verified.')
      }
      setAnalysis(review)
      const activateResponse = await marketplaceFetch(`/api/apis/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: form.seller_wallet, price_per_call: price, is_active: true }),
      })
      const activation = await activateResponse.json().catch(() => ({})) as { error?: string }
      if (!activateResponse.ok) throw new Error(activation.error ?? 'The listing could not be published.')
      router.push('/buyer')
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'The listing could not be published.')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <form onSubmit={publish} className={styles.form}>
      {error && <div className={styles.alert} role="status">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      <div className={styles.workspace}>
        <div className={styles.mainColumn}>
          <Card title="API Setup" eyebrow="Start with your endpoint">
            <div className={styles.endpointRow}>
              <Field label="Endpoint URL" error={fieldErrors.endpoint_url} className={styles.endpointField}>
                <div className={styles.endpointInputWrap}>
                  <span className={styles.lockIcon} aria-hidden="true">⌁</span>
                  <input type="url" required value={form.endpoint_url}
                    onChange={event => update('endpoint_url', event.target.value)}
                    placeholder="https://api.example.com/v1/weather" className={inputClass(fieldErrors.endpoint_url)} />
                </div>
              </Field>
              <button type="button" onClick={() => void analyzeEndpoint()} disabled={analyzing}
                className={styles.analyzeButton}>{analyzing ? <><Spinner /> Checking</> : 'Analyze'}</button>
            </div>
            <EndpointStatus analysis={analysis} analyzing={analyzing} />

            <div className={styles.setupGrid}>
              <Field label="API Name" required error={fieldErrors.name}>
                <input required maxLength={120} value={form.name} onChange={event => update('name', event.target.value)}
                  placeholder="Weather Forecast API" className={inputClass(fieldErrors.name)} />
              </Field>
              <Field label="Category" required>
                <select value={form.category} onChange={event => update('category', event.target.value)} className={inputClass()}>
                  {CATEGORIES.map(category => <option key={category}>{category}</option>)}
                </select>
              </Field>
              <Field label="HTTP Method" required error={fieldErrors.method}>
                <select value={form.method} onChange={event => update('method', event.target.value)}
                  className={inputClass(fieldErrors.method)}>
                  {HTTP_METHODS.map(method => <option key={method}>{method}</option>)}
                </select>
              </Field>
              <Field label="Authentication" required>
                <select value={form.auth_type} onChange={event => update('auth_type', event.target.value as AuthType)}
                  className={inputClass()}>
                  <option value="public">Public</option>
                  <option value="apikey">API Key · x-api-key</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="queryparam">Query Parameter</option>
                </select>
              </Field>
            </div>
            <Field label="Description" required error={fieldErrors.description}>
              <textarea required rows={2} maxLength={300} value={form.description}
                onChange={event => update('description', event.target.value)}
                placeholder="A concise explanation of what this API does and when to use it."
                className={inputClass(fieldErrors.description)} />
            </Field>
            {form.auth_type !== 'public' && <div className={styles.credentialGrid}>
              {form.auth_type === 'queryparam' && <Field label="Credential parameter" error={fieldErrors.auth_param_name}>
                <input value={form.auth_param_name} onChange={event => update('auth_param_name', event.target.value)}
                  placeholder="api_key" className={inputClass(fieldErrors.auth_param_name)} />
              </Field>}
              <Field label={form.auth_type === 'bearer' ? 'Bearer token' : 'API credential'} error={fieldErrors.auth_key}
                className={form.auth_type === 'queryparam' ? undefined : styles.fullField}>
                <input ref={credentialRef} type="password" autoComplete="off" value={form.auth_key}
                  onChange={event => update('auth_key', event.target.value)} placeholder="Stored encrypted"
                  className={inputClass(fieldErrors.auth_key)} />
              </Field>
            </div>}
          </Card>

          <Card title="Request & Response" eyebrow="Review what buyers can send">
            <div className={styles.exampleGrid}>
              <Field label={isBodyMethod ? 'Example Request' : 'Request inputs'} error={fieldErrors.example_request}>
                {isBodyMethod ? <>
                  <textarea rows={3} value={form.example_request} onChange={event => update('example_request', event.target.value)}
                    placeholder={'{"city":"Istanbul"}'} className={`${inputClass(fieldErrors.example_request)} ${styles.codeInput}`} />
                  <label className={styles.inlineCheck}><input type="checkbox" checked={form.body_required}
                    onChange={event => update('body_required', event.target.checked)} />JSON body required</label>
                </> : <div className={styles.emptyRequest}>GET bodies are not forwarded. Add path or query inputs below.</div>}
              </Field>
              <Field label="Example Response">
                <textarea rows={3} value={form.example_response} onChange={event => update('example_response', event.target.value)}
                  placeholder={'{"ok":true}'} className={`${inputClass()} ${styles.codeInput}`} />
              </Field>
            </div>

            <div className={styles.parameterSummary}>
              <div>
                <span className={styles.summaryLabel}>Detected input parameters</span>
                <div className={styles.parameterPills}>
                  {allParameters.length ? allParameters.map((parameter, index) => <span key={`${parameter.location}-${parameter.name}-${index}`}>
                    {parameter.name || 'unnamed'} <i>·</i> {parameter.type ?? 'string'} <i>·</i> {parameter.required ? 'required' : 'optional'}
                  </span>) : <em>No buyer-controlled inputs detected</em>}
                </div>
              </div>
              <details className={styles.parameterEditor}>
                <summary>Edit parameters</summary>
                <div className={styles.parameterEditorBody}>
                  <label className={styles.inlineCheck}><input type="checkbox" checked={form.dynamic_path_supported}
                    onChange={event => update('dynamic_path_supported', event.target.checked)} />Variable path segments</label>
                  {form.dynamic_path_supported && <RequestParameterEditor location="path" value={form.path_parameters}
                    onChange={value => update('path_parameters', value)} />}
                  <RequestParameterEditor location="query" value={form.query_parameters}
                    onChange={value => update('query_parameters', value)} />
                </div>
              </details>
            </div>
          </Card>

          <Card title="Pricing & Publish" eyebrow="Set your price and go live">
            <div className={styles.publishRow}>
              <Field label="Price per Call" required error={fieldErrors.price_per_call} className={styles.priceField}>
                <div className={styles.priceInputWrap}>
                  <input required type="number" min="0.000001" step="0.000001" value={form.price_per_call}
                    onChange={event => update('price_per_call', event.target.value)} className={inputClass(fieldErrors.price_per_call)} />
                  <span>USDC</span>
                </div>
              </Field>
              <div className={styles.miniPreview}>
                <div><span>{form.method}</span><strong>{form.name || 'Your API'}</strong></div>
                <p>{form.description || 'Your marketplace description will appear here.'}</p>
                <b>{priceValid ? `${form.price_per_call} USDC` : 'Set a price'} <small>/ call</small></b>
              </div>
              <button type="button" className={styles.previewButton} onClick={() => setShowPreview(true)}>Preview</button>
              <button type="submit" className={styles.publishButton} disabled={!publishReady || publishing}>
                {publishing ? <><Spinner /> Publishing</> : 'Publish API'}
              </button>
            </div>
          </Card>
        </div>

        <Assistant analysis={analysis} analyzing={analyzing} suggestionCount={suggestionCount}
          readyCount={readyCount} readiness={readiness} onApply={applySuggestions} onAddToken={addToken}
          onAnalyze={() => void analyzeEndpoint()} />
      </div>

      {showPreview && <PreviewModal form={form} onClose={() => setShowPreview(false)} />}
    </form>
  )
}

function Assistant({ analysis, analyzing, suggestionCount, readyCount, readiness, onApply, onAddToken, onAnalyze }: {
  analysis: AnalysisResult | null
  analyzing: boolean
  suggestionCount: number
  readyCount: number
  readiness: boolean[]
  onApply: () => void
  onAddToken: () => void
  onAnalyze: () => void
}) {
  const checks = ['Endpoint verified', 'Request structure valid', 'Authentication configured', 'Example tested', 'Price set']
  const authenticationProblem = Boolean(analysis?.analysis?.authentication_likely ||
    analysis?.field_errors.some(item => item.field === 'auth_key' || item.field === 'auth_param_name'))
  return <aside className={styles.assistant} aria-label="Mahshar Assistant">
    <header className={styles.assistantHeader}>
      <span className={styles.assistantMark}>M</span>
      <div><h2>Mahshar Assistant</h2><p>Endpoint-aware setup guidance</p></div>
    </header>

    <section className={styles.assistantSection}>
      <div className={styles.assistantTitle}><span>Endpoint analysis</span>{analyzing && <Spinner />}</div>
      {!analysis && !analyzing && <div className={styles.assistantEmpty}>
        <span>⌁</span><p>Paste an endpoint and select Analyze. Mahshar will test the request safely and suggest the setup.</p>
      </div>}
      {analyzing && <div className={styles.analysisLoading}><span /><span /><span /></div>}
      {analysis && <ul className={styles.factList}>
        <li className={analysis.endpoint_verified ? styles.factGood : styles.factBad}>
          <i>{analysis.endpoint_verified ? '✓' : '!'}</i><span>{analysis.endpoint_verified ? 'Endpoint is reachable' : analysis.blocking_issue ?? 'Endpoint needs attention'}
            <small>{analysis.endpoint_test_note}</small></span>
        </li>
        {analysis.analysis?.json_response && <li className={styles.factGood}><i>✓</i><span>JSON response detected<small>{analysis.analysis.content_type}</small></span></li>}
        {analysis.analysis?.method && <li><i>↗</i><span>{analysis.analysis.method} request tested
          {analysis.analysis.latency_ms !== null && <small>{analysis.analysis.latency_ms}ms response time</small>}</span></li>}
        {analysis.analysis && analysis.analysis.detected_parameter_count > 0 && <li><i>•</i><span>{analysis.analysis.detected_parameter_count} input parameter{analysis.analysis.detected_parameter_count === 1 ? '' : 's'} detected</span></li>}
      </ul>}
      {analysis?.summary && <p className={styles.assistantSummary}>{analysis.summary}</p>}
      {analysis && analysis.warnings.slice(0, 2).map(warning => <p key={warning} className={styles.assistantWarning}>{warning}</p>)}
    </section>

    {analysis && suggestionCount > 0 && <section className={styles.assistantSection}>
      <div className={styles.assistantTitle}><span>Suggested setup</span><b>{suggestionCount}</b></div>
      <div className={styles.suggestionList}>
        {analysis.suggestions.name && <Suggestion label="API Name" value={analysis.suggestions.name} />}
        {analysis.suggestions.category && <Suggestion label="Category" value={analysis.suggestions.category} />}
        {analysis.suggestions.method && <Suggestion label="Method" value={analysis.suggestions.method} />}
        {analysis.suggestions.auth_type && <Suggestion label="Authentication" value={authLabel(analysis.suggestions.auth_type)} />}
        {analysis.suggestions.description && <Suggestion label="Description" value={analysis.suggestions.description} />}
        {(analysis.suggestions.path_parameters.length + analysis.suggestions.query_parameters.length) > 0 &&
          <Suggestion label="Parameters" value={`${analysis.suggestions.path_parameters.length + analysis.suggestions.query_parameters.length} detected`} />}
      </div>
      <button type="button" onClick={onApply} className={styles.applyButton}>Apply suggestions</button>
    </section>}

    {analysis?.blocking_issue && <section className={`${styles.assistantSection} ${styles.problemSection}`}>
      <div className={styles.assistantTitle}><span>Action needed</span></div>
      <strong>{authenticationProblem ? 'Authentication required' : 'Fix endpoint setup'}</strong>
      <p>{analysis.blocking_issue}</p>
      {authenticationProblem
        ? <button type="button" onClick={onAddToken}>Add token</button>
        : <button type="button" onClick={onAnalyze}>Try again</button>}
    </section>}

    {analysis && !analysis.ai_available && <p className={styles.aiNotice}>AI suggestions are unavailable right now. Deterministic endpoint checks still work.</p>}

    <section className={`${styles.assistantSection} ${styles.readinessSection}`}>
      <div className={styles.readinessTop}><div><span>Ready to publish</span><p>{readyCount === 5 ? 'Everything looks good.' : 'Complete the remaining checks.'}</p></div><strong>{readyCount} / 5</strong></div>
      <ul>{checks.map((check, index) => <li key={check} className={readiness[index] ? styles.ready : ''}><i>{readiness[index] ? '✓' : '○'}</i>{check}</li>)}</ul>
    </section>
  </aside>
}

function EndpointStatus({ analysis, analyzing }: { analysis: AnalysisResult | null; analyzing: boolean }) {
  if (analyzing) return <div className={`${styles.endpointStatus} ${styles.statusChecking}`}><Spinner />Checking endpoint security and response…</div>
  if (!analysis) return <div className={styles.endpointStatus}><i />Ready to analyze</div>
  return <div className={`${styles.endpointStatus} ${analysis.endpoint_verified ? styles.statusSuccess : styles.statusError}`}>
    <i>{analysis.endpoint_verified ? '✓' : '!'}</i>{analysis.endpoint_verified ? 'Endpoint reachable' : analysis.blocking_issue}
    <span>{analysis.endpoint_test_note}</span>
  </div>
}

function Card({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return <section className={styles.card}><header><div><span>{eyebrow}</span><h2>{title}</h2></div></header><div className={styles.cardBody}>{children}</div></section>
}

function Field({ label, required, error, className, children }: { label: string; required?: boolean; error?: string; className?: string; children: ReactNode }) {
  return <label className={`${styles.field} ${className ?? ''}`}><span className={styles.label}>{label}{required && <b>*</b>}</span>{children}{error && <small className={styles.fieldError}>{error}</small>}</label>
}

function Suggestion({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><p>{value}</p></div>
}

function PreviewModal({ form, onClose }: { form: FormState; onClose: () => void }) {
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose()
  }}><section className={styles.previewModal} role="dialog" aria-modal="true" aria-label="Marketplace preview">
    <header><div><span>Marketplace preview</span><h2>{form.name || 'Your API'}</h2></div><button type="button" onClick={onClose} aria-label="Close preview">×</button></header>
    <div className={styles.previewModalBody}>
      <div className={styles.previewBadges}><span>{form.category}</span><span>{form.method}</span><span>{authLabel(form.auth_type)}</span></div>
      <p>{form.description || 'Add a description to help buyers understand this API.'}</p>
      <div><small>Price per call</small><strong>{form.price_per_call || '—'} USDC</strong></div>
      <footer><span>Seller</span><code>{form.seller_wallet ? `${form.seller_wallet.slice(0, 6)}…${form.seller_wallet.slice(-4)}` : 'Not connected'}</code></footer>
    </div>
  </section></div>
}

function Spinner() { return <span className={styles.spinner} aria-hidden="true" /> }

function inputClass(error?: string) { return `${styles.input} ${error ? styles.inputError : ''}` }

function sensitiveSnapshot(form: FormState) {
  return {
    endpoint_url: form.endpoint_url,
    method: form.method,
    auth_type: form.auth_type,
    auth_key: form.auth_key,
    auth_param_name: form.auth_param_name,
    body_required: form.body_required,
    dynamic_path_supported: form.dynamic_path_supported,
    path_parameters: form.path_parameters,
    query_parameters: form.query_parameters,
  }
}

function inferredExample(value: string, type?: DeclaredParameter['type']) {
  if (type === 'integer' && /^-?\d+$/.test(value)) return Number(value)
  if (type === 'number' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  return value
}

function countSuggestions(analysis: AnalysisResult) {
  const suggestion = analysis.suggestions
  return [suggestion.name, suggestion.description, suggestion.category, suggestion.method, suggestion.auth_type,
    suggestion.auth_param_name, suggestion.example_request, suggestion.example_response,
    ...suggestion.path_parameters, ...suggestion.query_parameters].filter(Boolean).length
}

function authLabel(auth: AuthType) {
  return auth === 'public' ? 'Public' : auth === 'apikey' ? 'API Key' : auth === 'bearer' ? 'Bearer Token' : 'Query Parameter'
}
