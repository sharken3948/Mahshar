'use client'

import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useAccount } from 'wagmi'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import { RequestParameterEditor } from '@/components/RequestParameterEditor'
import { ProviderPriceBreakdown } from '@/components/ProviderPriceBreakdown'
import type { DeclaredParameter } from '@/lib/marketplace/proxy-target'
import type { ApiListing, AuthType } from '@/types'
import styles from './onboarding-form.module.css'

const CATEGORIES = ['AI', 'Data', 'Finance', 'Weather', 'Geo', 'Social', 'Media', 'Utility', 'Other']
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE']
const CREDENTIAL_QUERY_NAMES = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|auth[_-]?token|appid)$/i

interface EditState {
  name: string
  endpoint_url: string
  method: string | null
  description: string
  price_per_call: string
  category: string
  auth_type: AuthType
  auth_param_name: string | null
  example_request: string | null
  example_response: string | null
  body_required: boolean | null
  dynamic_path_supported: boolean | null
  path_parameters: DeclaredParameter[] | null
  query_parameters: DeclaredParameter[] | null
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

const EXECUTABLE_FIELDS = new Set<keyof EditState>([
  'endpoint_url', 'method', 'auth_type', 'auth_param_name', 'example_request', 'body_required',
  'dynamic_path_supported', 'path_parameters', 'query_parameters',
])
const FRESH_AUTHORIZATION_FIELDS = new Set<keyof EditState>([
  'endpoint_url', 'method', 'auth_type', 'auth_param_name', 'body_required',
  'dynamic_path_supported', 'path_parameters', 'query_parameters',
])
const ANALYSIS_FIELDS = new Set<keyof EditState>(EXECUTABLE_FIELDS)

export function EditListingForm({ listing, onClose, onListingChange }: {
  listing: ApiListing
  onClose: () => void
  onListingChange: (listing: ApiListing) => void
}) {
  const { address } = useAccount()
  const { request: marketplaceFetch, sensitiveRequest } = useMarketplaceSession()
  const [baseline, setBaseline] = useState(listing)
  const [form, setForm] = useState<EditState>(() => stateFromListing(listing))
  const [credentialReplacement, setCredentialReplacement] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [changingActivation, setChangingActivation] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [showPreview, setShowPreview] = useState(false)
  const credentialRef = useRef<HTMLInputElement>(null)

  const patch = useMemo(() => buildPatch(form, baseline, credentialReplacement), [form, baseline, credentialReplacement])
  const dirty = Object.keys(patch).length > 1
  const replacingCredential = form.auth_type !== 'public' && credentialReplacement.length > 0
  const executableChanged = replacingCredential || Object.keys(patch).some(key => EXECUTABLE_FIELDS.has(key as keyof EditState))
  const requiresFreshAuthorization = replacingCredential || Object.keys(patch).some(key => FRESH_AUTHORIZATION_FIELDS.has(key as keyof EditState))
  const credentialConfigured = form.auth_type === 'public' || Boolean(credentialReplacement.trim() || baseline.credential_configured)
  const storedCredentialMatchesDraft = form.endpoint_url.trim() === baseline.endpoint_url
    && form.auth_type === baseline.auth_type
    && (form.auth_param_name ?? null) === (baseline.auth_param_name ?? null)
  const price = Number(form.price_per_call)
  const priceValid = Number.isFinite(price) && price > 0
  const metadataComplete = Boolean(form.name.trim() && form.description.trim() && form.category && form.method)
  const draftAnalyzed = analysis?.endpoint_verified === true
  const storedVerified = Boolean(baseline.verified_at) && !executableChanged
  const contractValid = executableChanged
    ? Boolean(analysis?.endpoint_verified && analysis.field_errors.length === 0)
    : !baseline.request_contract_error
  const readiness = [draftAnalyzed || storedVerified, contractValid, credentialConfigured, storedVerified, priceValid]
  const readyCount = readiness.filter(Boolean).length
  const isBodyMethod = form.method !== 'GET'
  const pathParameters = form.path_parameters ?? []
  const queryParameters = form.query_parameters ?? []
  const allParameters = [...pathParameters.map(parameter => ({ ...parameter, location: 'path' as const })),
    ...queryParameters.map(parameter => ({ ...parameter, location: 'query' as const }))]
  const suggestionCount = useMemo(() => analysis ? countSuggestions(analysis) : 0, [analysis])
  const categoryOptions = CATEGORIES.includes(form.category) ? CATEGORIES : [form.category, ...CATEGORIES]
  const methodOptions = form.method && !HTTP_METHODS.includes(form.method) ? [form.method, ...HTTP_METHODS] : HTTP_METHODS
  const finalActionGuidance = analyzing
    ? { title: 'Analysis running', detail: 'Mahshar is checking this draft. Its result will appear here when complete.' }
    : analysis?.endpoint_verified && analysis.field_errors.length === 0
      ? { title: 'Analysis complete', detail: dirty ? 'Review the result, then save your deliberate changes.' : 'This draft has been analyzed and has no unsaved changes.' }
      : analysis
        ? { title: 'Analysis failed', detail: 'Review the endpoint guidance before saving or try the analysis again.' }
        : executableChanged
          ? { title: 'Analyze this draft', detail: 'Check endpoint and request-contract changes here before saving. Saving sensitive changes still clears verification.' }
          : dirty
            ? { title: 'Save required', detail: 'Preview or analyze if needed, then save the current draft.' }
            : !baseline.verified_at
              ? { title: 'Verification required', detail: 'The saved configuration must be verified before this listing can be activated.' }
              : { title: 'No unsaved changes', detail: 'Preview or analyze the stored configuration at any time.' }

  function update<K extends keyof EditState>(field: K, value: EditState[K]) {
    setForm(previous => {
      if (field === 'method' && value === 'GET') {
        return { ...previous, method: 'GET', body_required: false, example_request: '' }
      }
      if (field === 'dynamic_path_supported' && value === false) {
        return { ...previous, dynamic_path_supported: false, path_parameters: [] }
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

  function analysisPayload() {
    return {
      api_id: baseline.id,
      draft: true,
      seller_wallet: address,
      name: form.name,
      category: form.category,
      description: form.description,
      endpoint_url: form.endpoint_url,
      method: form.method,
      auth_type: form.auth_type,
      auth_key: credentialReplacement || undefined,
      auth_param_name: form.auth_param_name || undefined,
      example_request: isBodyMethod ? (form.example_request ?? '') : '',
      example_response: form.example_response ?? '',
      expected_status_codes: baseline.expected_status_codes ?? undefined,
      body_required: isBodyMethod ? form.body_required : false,
      dynamic_path_supported: form.dynamic_path_supported === true,
      path_parameters: form.dynamic_path_supported ? pathParameters : [],
      query_parameters: queryParameters,
    }
  }

  async function analyzeEndpoint() {
    if (!form.endpoint_url.trim()) {
      setFieldErrors({ endpoint_url: 'Enter the public HTTPS endpoint for this listing.' })
      return
    }
    setAnalyzing(true)
    setError(null)
    setNotice(null)
    setFieldErrors({})
    try {
      const response = await marketplaceFetch('/api/ai/score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analysisPayload()),
      })
      const result = await response.json().catch(() => null) as (Partial<AnalysisResult> & { error?: string }) | null
      if (!result || typeof result.endpoint_verified !== 'boolean') {
        setError(result?.error ?? 'Endpoint analysis is temporarily unavailable. Your stored listing was not changed.')
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
    let suggestedCredential: string | null = null
    try {
      const endpoint = new URL(form.endpoint_url)
      const credentialName = suggested.auth_param_name ?? [...endpoint.searchParams.keys()]
        .find(name => CREDENTIAL_QUERY_NAMES.test(name))
      suggestedCredential = credentialName ? endpoint.searchParams.get(credentialName) : null
    } catch { suggestedCredential = null }
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
    if (suggestedCredential) setCredentialReplacement(suggestedCredential)
    setAnalysis(null)
    setFieldErrors({})
    setNotice('Suggestions applied to this draft. Review and save explicitly; the listing has not changed yet.')
  }

  function addToken() {
    const suggestedAuth = analysis?.suggestions.auth_type
    if (form.auth_type === 'public') update('auth_type', suggestedAuth && suggestedAuth !== 'public' ? suggestedAuth : 'bearer')
    window.setTimeout(() => credentialRef.current?.focus(), 0)
  }

  async function reloadListing() {
    const response = await marketplaceFetch(`/api/apis/${encodeURIComponent(baseline.id)}`, { cache: 'no-store' })
    const payload = await response.json().catch(() => ({})) as { api?: ApiListing; error?: string }
    if (!response.ok || !payload.api) throw new Error(payload.error ?? 'The updated listing could not be reloaded.')
    setBaseline(payload.api)
    setForm(stateFromListing(payload.api))
    setCredentialReplacement('')
    onListingChange(payload.api)
    return payload.api
  }

  async function saveChanges(event: FormEvent) {
    event.preventDefault()
    if (!address) return setError('Connect the listing owner wallet to save changes.')
    if (!metadataComplete || !priceValid) return setError('Complete the required listing details and enter a positive price.')
    if (!credentialConfigured) return setError('Add the credential required by the selected authentication type.')
    if (!dirty) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await (requiresFreshAuthorization ? sensitiveRequest : marketplaceFetch)(`/api/apis/${baseline.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The listing could not be updated.')
      const refreshed = await reloadListing()
      setAnalysis(null)
      setFieldErrors({})
      setNotice(executableChanged
        ? 'Changes saved. Verification was cleared and the listing is inactive until this exact configuration is verified.'
        : `Changes saved. The listing remains ${refreshed.is_active ? 'active' : 'inactive'} with its existing verification state.`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The listing could not be updated.')
    } finally {
      setSaving(false)
    }
  }

  async function verifyStoredConfiguration() {
    if (dirty) return setError('Save this draft before verifying it.')
    setVerifying(true)
    setError(null)
    setNotice(null)
    try {
      const response = await marketplaceFetch(`/api/apis/${baseline.id}/verify`, { method: 'POST' })
      const result = await response.json().catch(() => ({})) as { error?: string; already_verified?: boolean }
      if (!response.ok) throw new Error(result.error ?? 'The endpoint could not be verified.')
      await reloadListing()
      setNotice(result.already_verified ? 'This stored configuration is already verified.' : 'This exact stored configuration is verified.')
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'The endpoint could not be verified.')
    } finally {
      setVerifying(false)
    }
  }

  async function changeActivation(nextActive: boolean) {
    if (!address) return setError('Connect the listing owner wallet to change availability.')
    if (dirty) return setError('Save or discard this draft before changing availability.')
    setChangingActivation(true)
    setError(null)
    setNotice(null)
    try {
      const response = await marketplaceFetch(`/api/apis/${baseline.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: address, is_active: nextActive }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error ?? `The listing could not be ${nextActive ? 'activated' : 'deactivated'}.`)
      await reloadListing()
      setNotice(nextActive ? 'Listing activated and available through Mahshar.' : 'Listing deactivated. Its stored configuration was preserved.')
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : 'Availability could not be changed.')
    } finally {
      setChangingActivation(false)
    }
  }

  return <form onSubmit={saveChanges} className={styles.form}>
    <div className={styles.editPageHeader}>
      <div><button type="button" onClick={onClose} className={styles.backButton}>← Back to APIs</button>
        <span className={styles.editEyebrow}>EXISTING LISTING</span><h1>Edit your API</h1>
        <p>Review the stored configuration, analyze only when you choose, and save deliberate changes.</p></div>
      <div className={styles.listingState}><span className={baseline.is_active ? styles.stateActive : styles.stateInactive}>{baseline.is_active ? 'Active' : 'Inactive'}</span>
        <span className={baseline.verified_at ? styles.stateVerified : styles.stateUnverified}>{baseline.verified_at ? 'Verified' : 'Verification required'}</span></div>
    </div>
    {error && <div className={styles.alert} role="status">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {baseline.request_contract_error && <div className={styles.legacyNotice} role="status"><strong>Request contract needs correction</strong><span>{baseline.request_contract_error}</span><small>The listing remains owner-visible. Saving a safe correction uses the current deterministic rules.</small></div>}

    <div className={styles.workspace}>
      <div className={styles.mainColumn}>
        <Card title="API Setup" eyebrow="Review the stored endpoint">
          <Field label="Endpoint URL" error={fieldErrors.endpoint_url} className={styles.endpointField}>
            <div className={styles.endpointInputWrap}><span className={styles.lockIcon} aria-hidden="true">⌁</span>
              <input type="url" required value={form.endpoint_url} onChange={event => update('endpoint_url', event.target.value)}
                className={inputClass(fieldErrors.endpoint_url)} /></div>
          </Field>
          <EndpointStatus analysis={analysis} analyzing={analyzing} storedVerified={storedVerified} />

          <div className={styles.setupGrid}>
            <Field label="API Name" required><input required maxLength={120} value={form.name} onChange={event => update('name', event.target.value)} className={inputClass()} /></Field>
            <Field label="Category" required><select value={form.category} onChange={event => update('category', event.target.value)} className={inputClass()}>{categoryOptions.map(category => <option key={category}>{category}</option>)}</select></Field>
            <Field label="HTTP Method" required error={fieldErrors.method}><select value={form.method ?? ''} onChange={event => update('method', event.target.value)} className={inputClass(fieldErrors.method)}>
              {!form.method && <option value="" disabled>Choose method</option>}{methodOptions.map(method => <option key={method}>{method}{!HTTP_METHODS.includes(method) ? ' (legacy)' : ''}</option>)}</select></Field>
            <Field label="Authentication" required><select value={form.auth_type} onChange={event => {
              const authType = event.target.value as AuthType
              if (authType === 'public') setCredentialReplacement('')
              update('auth_type', authType)
            }} className={inputClass()}>
              <option value="public">Public</option><option value="apikey">API Key · x-api-key</option><option value="bearer">Bearer Token</option><option value="queryparam">Query Parameter</option></select></Field>
          </div>
          <Field label="Description" required><textarea required rows={2} maxLength={300} value={form.description} onChange={event => update('description', event.target.value)} className={inputClass()} /></Field>
          {form.auth_type !== 'public' && <div className={styles.credentialGrid}>
            {form.auth_type === 'queryparam' && <Field label="Credential parameter" error={fieldErrors.auth_param_name}>
              <input value={form.auth_param_name ?? ''} onChange={event => update('auth_param_name', event.target.value)} placeholder="api_key" className={inputClass(fieldErrors.auth_param_name)} /></Field>}
            <Field label={form.auth_type === 'bearer' ? 'Replace bearer token' : 'Replace API credential'} error={fieldErrors.auth_key} className={form.auth_type === 'queryparam' ? undefined : styles.fullField}>
              <input ref={credentialRef} type="password" autoComplete="new-password" value={credentialReplacement}
                onChange={event => { setCredentialReplacement(event.target.value); setAnalysis(null); setError(null); setNotice(null) }}
                placeholder={baseline.credential_configured ? 'Configured · leave blank to keep' : 'No credential configured'} className={inputClass(fieldErrors.auth_key)} />
              <small className={styles.credentialHint}>{baseline.credential_configured
                ? storedCredentialMatchesDraft
                  ? 'The existing secret is never shown. Leave this blank to keep it and use it for analysis.'
                  : 'The existing secret is never sent to a changed endpoint during draft analysis. Enter a replacement to analyze now, or save with fresh authorization and then verify.'
                : 'Add a credential before testing or saving protected authentication.'}</small>
            </Field>
          </div>}
        </Card>

        <Card title="Request & Response" eyebrow="Review what buyers can send">
          <div className={styles.exampleGrid}>
            <Field label={isBodyMethod ? 'Example Request' : 'Request inputs'} error={fieldErrors.example_request}>
              {isBodyMethod ? <><textarea rows={3} value={form.example_request ?? ''} onChange={event => update('example_request', event.target.value)} className={`${inputClass(fieldErrors.example_request)} ${styles.codeInput}`} />
                <label className={styles.inlineCheck}><input type="checkbox" checked={form.body_required === true} onChange={event => update('body_required', event.target.checked)} />JSON body required</label></>
                : <div className={styles.emptyRequest}>GET bodies are not forwarded. Review path or query inputs below.</div>}
            </Field>
            <Field label="Example Response"><textarea rows={3} value={form.example_response ?? ''} onChange={event => update('example_response', event.target.value)} className={`${inputClass()} ${styles.codeInput}`} /></Field>
          </div>
          <div className={styles.parameterSummary}><div><span className={styles.summaryLabel}>Configured input parameters</span><div className={styles.parameterPills}>
            {allParameters.length ? allParameters.map((parameter, index) => <span key={`${parameter.location}-${parameter.name}-${index}`}>{parameter.name || 'unnamed'} <i>·</i> {parameter.type ?? 'string'} <i>·</i> {parameter.required ? 'required' : 'optional'}</span>) : <em>No buyer-controlled inputs configured</em>}
          </div></div>
            <details className={styles.parameterEditor}><summary>Edit parameters</summary><div className={styles.parameterEditorBody}>
              <label className={styles.inlineCheck}><input type="checkbox" checked={form.dynamic_path_supported === true} onChange={event => update('dynamic_path_supported', event.target.checked)} />Variable path segments</label>
              {form.dynamic_path_supported && <RequestParameterEditor location="path" value={pathParameters} onChange={value => update('path_parameters', value)} />}
              <RequestParameterEditor location="query" value={queryParameters} onChange={value => update('query_parameters', value)} />
            </div></details>
          </div>
        </Card>

        <Card title="Pricing & Publish" eyebrow="Manage this existing listing">
          {executableChanged && <div className={styles.lifecycleNotice}><strong>Verification will be cleared</strong><span>Saving endpoint, authentication, or request-contract changes safely deactivates this listing. Verify the saved configuration before activating it again.</span></div>}
          <div className={styles.publishRow}>
            <Field label="Listed Base Price per Call" required className={styles.priceField}><div className={styles.priceInputWrap}>
              <input required type="number" min="0.000001" step="0.000001" value={form.price_per_call} onChange={event => update('price_per_call', event.target.value)} className={inputClass()} /><span>USDC</span></div></Field>
            <ProviderPriceBreakdown listedPrice={form.price_per_call} />
            <div className={styles.miniPreview}><div><span>{form.method ?? '—'}</span><strong>{form.name || 'Your API'}</strong></div><p>{form.description || 'Your marketplace description will appear here.'}</p><b>{priceValid ? `${form.price_per_call} USDC` : 'Set a price'} <small>/ call</small></b></div>
            <div className={styles.publishFooter}>
              <p className={styles.finalActionGuidance} role="status"><strong>{finalActionGuidance.title}</strong><span>{finalActionGuidance.detail}</span></p>
              <div className={styles.publishActions}>
                <button type="button" className={styles.previewButton} onClick={() => setShowPreview(true)}>Preview</button>
                <button type="button" onClick={() => void analyzeEndpoint()} disabled={analyzing} className={styles.analyzeButton}>
                  {analyzing ? <><Spinner /> Checking</> : 'Analyze'}</button>
                <button type="submit" className={styles.saveButton} disabled={!dirty || saving}>{saving ? <><Spinner /> Saving</> : 'Save changes'}</button>
              </div>
            </div>
          </div>
          <div className={styles.lifecycleActions}>
            {!baseline.verified_at && <button type="button" onClick={() => void verifyStoredConfiguration()} disabled={dirty || verifying}>{verifying ? 'Verifying…' : 'Verify saved setup'}</button>}
            {baseline.is_active
              ? <button type="button" onClick={() => void changeActivation(false)} disabled={dirty || changingActivation} className={styles.deactivateButton}>{changingActivation ? 'Updating…' : 'Deactivate'}</button>
              : <button type="button" onClick={() => void changeActivation(true)} disabled={dirty || !baseline.verified_at || changingActivation} className={styles.activateButton}>{changingActivation ? 'Updating…' : 'Activate listing'}</button>}
            <p>{dirty ? 'Save or discard the draft before verification or availability changes.' : baseline.is_active ? 'This exact stored configuration is currently available to buyers and agents.' : baseline.verified_at ? 'The saved configuration is verified and can be activated.' : 'Verify the exact saved configuration before activation.'}</p>
          </div>
        </Card>
      </div>

      <Assistant analysis={analysis} analyzing={analyzing} suggestionCount={suggestionCount} readyCount={readyCount}
        readiness={readiness} active={baseline.is_active} dirty={dirty} onApply={applySuggestions} onAddToken={addToken}
        onAnalyze={() => void analyzeEndpoint()} />
    </div>
    {showPreview && <PreviewModal form={form} sellerWallet={baseline.seller_wallet} onClose={() => setShowPreview(false)} />}
  </form>
}

function Assistant({ analysis, analyzing, suggestionCount, readyCount, readiness, active, dirty, onApply, onAddToken, onAnalyze }: {
  analysis: AnalysisResult | null; analyzing: boolean; suggestionCount: number; readyCount: number; readiness: boolean[]
  active: boolean; dirty: boolean; onApply: () => void; onAddToken: () => void; onAnalyze: () => void
}) {
  const checks = ['Endpoint checked', 'Request structure valid', 'Authentication configured', 'Stored setup verified', 'Price set']
  const authenticationProblem = Boolean(analysis?.analysis?.authentication_likely || analysis?.field_errors.some(item => item.field === 'auth_key' || item.field === 'auth_param_name'))
  return <aside className={styles.assistant} aria-label="Mahshar Assistant">
    <header className={styles.assistantHeader}><span className={styles.assistantMark}>M</span><div><h2>Mahshar Assistant</h2><p>Advisory help for this listing</p></div></header>
    <section className={styles.assistantSection}><div className={styles.assistantTitle}><span>Endpoint analysis</span>{analyzing && <Spinner />}</div>
      {!analysis && !analyzing && <div className={styles.assistantEmpty}><span>⌁</span><p>Select Analyze when you want Mahshar to inspect this draft. Opening Edit never runs analysis or changes the listing.</p></div>}
      {analyzing && <div className={styles.analysisLoading}><span /><span /><span /></div>}
      {analysis && <ul className={styles.factList}><li className={analysis.endpoint_verified ? styles.factGood : styles.factBad}><i>{analysis.endpoint_verified ? '✓' : '!'}</i><span>{analysis.endpoint_verified ? 'Draft endpoint is reachable' : analysis.blocking_issue ?? 'Endpoint needs attention'}<small>{analysis.endpoint_test_note}</small></span></li>
        {analysis.analysis?.json_response && <li className={styles.factGood}><i>✓</i><span>JSON response detected<small>{analysis.analysis.content_type}</small></span></li>}
        {analysis.analysis?.method && <li><i>↗</i><span>{analysis.analysis.method} request tested{analysis.analysis.latency_ms !== null && <small>{analysis.analysis.latency_ms}ms response time</small>}</span></li>}
        {analysis.analysis && analysis.analysis.detected_parameter_count > 0 && <li><i>•</i><span>{analysis.analysis.detected_parameter_count} input parameter{analysis.analysis.detected_parameter_count === 1 ? '' : 's'} detected</span></li>}
      </ul>}
      {analysis?.summary && <p className={styles.assistantSummary}>{analysis.summary}</p>}
      {analysis && analysis.warnings.slice(0, 2).map(warning => <p key={warning} className={styles.assistantWarning}>{warning}</p>)}
    </section>
    {analysis && suggestionCount > 0 && <section className={styles.assistantSection}><div className={styles.assistantTitle}><span>Suggested setup</span><b>{suggestionCount}</b></div><div className={styles.suggestionList}>
      {analysis.suggestions.name && <Suggestion label="API Name" value={analysis.suggestions.name} />}{analysis.suggestions.category && <Suggestion label="Category" value={analysis.suggestions.category} />}
      {analysis.suggestions.method && <Suggestion label="Method" value={analysis.suggestions.method} />}{analysis.suggestions.auth_type && <Suggestion label="Authentication" value={authLabel(analysis.suggestions.auth_type)} />}
      {analysis.suggestions.description && <Suggestion label="Description" value={analysis.suggestions.description} />}
      {(analysis.suggestions.path_parameters.length + analysis.suggestions.query_parameters.length) > 0 && <Suggestion label="Parameters" value={`${analysis.suggestions.path_parameters.length + analysis.suggestions.query_parameters.length} detected`} />}
    </div><button type="button" onClick={onApply} className={styles.applyButton}>Apply suggestions</button></section>}
    {analysis?.blocking_issue && <section className={`${styles.assistantSection} ${styles.problemSection}`}><div className={styles.assistantTitle}><span>Action needed</span></div><strong>{authenticationProblem ? 'Authentication required' : 'Fix endpoint setup'}</strong><p>{analysis.blocking_issue}</p>
      {authenticationProblem ? <button type="button" onClick={onAddToken}>Add token</button> : <button type="button" onClick={onAnalyze}>Try again</button>}</section>}
    {analysis && !analysis.ai_available && <p className={styles.aiNotice}>AI suggestions are unavailable right now. Deterministic endpoint checks still work, and the listing is unchanged.</p>}
    <section className={`${styles.assistantSection} ${styles.readinessSection}`}><div className={styles.readinessTop}><div><span>{active && !dirty ? 'Marketplace ready' : 'Listing readiness'}</span><p>{dirty ? 'Save and verify executable changes.' : readyCount === 5 ? 'The stored setup is ready.' : 'Complete the remaining checks.'}</p></div><strong>{readyCount} / 5</strong></div>
      <ul>{checks.map((check, index) => <li key={check} className={readiness[index] ? styles.ready : ''}><i>{readiness[index] ? '✓' : '○'}</i>{check}</li>)}</ul></section>
  </aside>
}

function EndpointStatus({ analysis, analyzing, storedVerified }: { analysis: AnalysisResult | null; analyzing: boolean; storedVerified: boolean }) {
  if (analyzing) return <div className={`${styles.endpointStatus} ${styles.statusChecking}`}><Spinner />Checking endpoint security and response…</div>
  if (!analysis) return <div className={`${styles.endpointStatus} ${storedVerified ? styles.statusSuccess : ''}`}><i>{storedVerified ? '✓' : ''}</i>{storedVerified ? 'Stored configuration verified' : 'Ready to analyze explicitly'}</div>
  return <div className={`${styles.endpointStatus} ${analysis.endpoint_verified ? styles.statusSuccess : styles.statusError}`}><i>{analysis.endpoint_verified ? '✓' : '!'}</i>{analysis.endpoint_verified ? 'Draft endpoint reachable' : analysis.blocking_issue}<span>{analysis.endpoint_test_note}</span></div>
}

function Card({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return <section className={styles.card}><header><div><span>{eyebrow}</span><h2>{title}</h2></div></header><div className={styles.cardBody}>{children}</div></section>
}
function Field({ label, required, error, className, children }: { label: string; required?: boolean; error?: string; className?: string; children: ReactNode }) {
  return <label className={`${styles.field} ${className ?? ''}`}><span className={styles.label}>{label}{required && <b>*</b>}</span>{children}{error && <small className={styles.fieldError}>{error}</small>}</label>
}
function Suggestion({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><p>{value}</p></div> }
function Spinner() { return <span className={styles.spinner} aria-hidden="true" /> }
function inputClass(error?: string) { return `${styles.input} ${error ? styles.inputError : ''}` }

function PreviewModal({ form, sellerWallet, onClose }: { form: EditState; sellerWallet: string; onClose: () => void }) {
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className={styles.previewModal} role="dialog" aria-modal="true" aria-label="Marketplace preview">
    <header><div><span>Draft marketplace preview</span><h2>{form.name || 'Your API'}</h2></div><button type="button" onClick={onClose} aria-label="Close preview">×</button></header>
    <div className={styles.previewModalBody}><div className={styles.previewBadges}><span>{form.category}</span><span>{form.method ?? 'Method not set'}</span><span>{authLabel(form.auth_type)}</span></div>
      <p>{form.description || 'Add a description to help buyers understand this API.'}</p><div><small>Listed base price</small><strong>{form.price_per_call || '—'} USDC</strong></div>
      <footer><span>Seller</span><code>{`${sellerWallet.slice(0, 6)}…${sellerWallet.slice(-4)}`}</code></footer></div>
  </section></div>
}

function stateFromListing(listing: ApiListing): EditState {
  return {
    name: listing.name, endpoint_url: listing.endpoint_url, method: listing.method, description: listing.description,
    price_per_call: String(listing.price_per_call), category: listing.category, auth_type: listing.auth_type,
    auth_param_name: listing.auth_param_name, example_request: listing.example_request, example_response: listing.example_response,
    body_required: listing.body_required ?? null, dynamic_path_supported: listing.dynamic_path_supported ?? null,
    path_parameters: Array.isArray(listing.path_parameters) ? listing.path_parameters as DeclaredParameter[] : null,
    query_parameters: Array.isArray(listing.query_parameters) ? listing.query_parameters as DeclaredParameter[] : null,
  }
}

function same(left: unknown, right: unknown) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null) }
function buildPatch(form: EditState, listing: ApiListing, credentialReplacement: string) {
  const patch: Record<string, unknown> = { seller_wallet: listing.seller_wallet }
  const original = stateFromListing(listing)
  for (const key of Object.keys(form) as Array<keyof EditState>) {
    if (key === 'price_per_call') continue
    if (!same(form[key], original[key])) patch[key] = form[key]
  }
  const price = Number(form.price_per_call)
  if (Number.isFinite(price) && price !== Number(listing.price_per_call)) patch.price_per_call = price
  if (form.auth_type !== 'public' && credentialReplacement) patch.auth_key = credentialReplacement
  return patch
}

function countSuggestions(analysis: AnalysisResult) {
  const suggestion = analysis.suggestions
  return [suggestion.name, suggestion.description, suggestion.category, suggestion.method, suggestion.auth_type,
    suggestion.auth_param_name, suggestion.example_request, suggestion.example_response,
    ...suggestion.path_parameters, ...suggestion.query_parameters].filter(Boolean).length
}
function authLabel(auth: AuthType) { return auth === 'public' ? 'Public' : auth === 'apikey' ? 'API Key' : auth === 'bearer' ? 'Bearer Token' : 'Query Parameter' }
function inferredExample(value: string, type?: DeclaredParameter['type']) {
  if (type === 'integer' && /^-?\d+$/.test(value)) return Number(value)
  if (type === 'number' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  return value
}
