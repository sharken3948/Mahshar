import { documentation, policyLinks, text } from './discovery'
import { domain, emptyResult, providerDocument, lead as apiService, type Lead, type Permission, type Result } from './model'
import { AccessError, Network, safeEndpoint, credentialPayload, type Page } from './network'

/** Reject error envelopes and empty/metadata/health responses even with HTTP 200. */
export function functional(page: Page, description = ''): { ok: boolean; reason: string } {
  if (page.status !== 200) return { ok: false, reason: `http_${page.status}` }
  if (credentialPayload(page.body)) return { ok: false, reason: 'credential_payload_rejected' }
  if (/(?:^|\/)(?:plans|billing|checkout|credits)(?:\/|$)/i.test(new URL(page.url).pathname)) {
    return { ok: false, reason: 'provider_billing_not_functionality' }
  }
  if (/(?:^|\/)partners(?:\/|$)/i.test(new URL(page.url).pathname) && !/\bpartners?\b/i.test(description)) {
    return { ok: false, reason: 'provider_partner_directory_not_functionality' }
  }
  if (page.binary && /image|avatar|icon|photo|chart|picture|favicon|picsum|screenshot|\bmaps?\b|radar|cross sections|vertical profiles/i.test(description)) {
    const signature = page.binary.prefix
    const valid = page.binary.bytes > 32 && (/^image\/png/i.test(page.type) && signature.startsWith('89504e470d0a1a0a')
      || /^image\/jpe?g/i.test(page.type) && signature.startsWith('ffd8ff')
      || /^image\/gif/i.test(page.type) && /^47494638(?:3761|3961)/.test(signature)
      || /^image\/(?:x-icon|vnd.microsoft.icon)/i.test(page.type) && signature.startsWith('00000100')
      || /^image\/webp/i.test(page.type) && /^52494646.{8}57454250/.test(signature))
    return { ok: valid, reason: valid ? 'documented_image_signature_verified' : 'invalid_image_payload' }
  }
  if (/image\/svg\+xml/i.test(page.type) && /image|avatar|icon|photo|chart|picture|favicon|placeholder|qr/i.test(description)) {
    const ok = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(page.body) && /<\/svg>\s*$/i.test(page.body)
      && /<(?:path|rect|circle|ellipse|line|polygon|polyline|text)\b/i.test(page.body)
      && !/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:)|\b(?:not found|bad gateway|unauthorized)\b/i.test(page.body)
    return { ok, reason: ok ? 'documented_safe_svg_verified' : 'invalid_or_active_svg' }
  }
  if (/csv/i.test(page.type)) {
    const input = page.body.trim(), header = input.split(/\r?\n/,1)[0]
    const delimiter = header.includes(',') ? ',' : header.includes('\t') ? '\t' : ';'
    const widths: number[] = []
    let width = 1, quoted = false, fieldStarted = false, closed = false, malformed = false
    for (let index = 0; index < input.length; index++) {
      const char = input[index]
      if (quoted) {
        if (char === '"' && input[index + 1] === '"') index++
        else if (char === '"') { quoted = false; closed = true }
      } else if (char === delimiter) { width++; fieldStarted = false; closed = false }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && input[index + 1] === '\n') index++
        widths.push(width); width = 1; fieldStarted = false; closed = false
      } else if (char === '"') {
        if (fieldStarted || closed) malformed = true
        quoted = true; fieldStarted = true
      } else { if (closed && !/\s/.test(char)) malformed = true; fieldStarted = true }
    }
    widths.push(width)
    const ok = !quoted && !malformed && widths.length > 1 && widths[0] > 1 && widths.every(n => n === widths[0])
      && !/^\s*(?:error|<!?html)/i.test(input)
    return { ok, reason: ok ? 'documented_csv_rows_verified' : 'invalid_csv_data' }
  }
  if (!/(?:json|javascript|text\/plain)/i.test(page.type)) return { ok: false, reason: 'non_json_functionality_unverified' }
  let data: any
  try { data = JSON.parse(page.body) } catch {
    const ok = /text\/plain/i.test(page.type) && /quote|joke|fact|greeting|hello|lorem|phrase|proverb/i.test(description)
      && page.body.trim().length >= 8 && !/[<>]|\b(?:error|not found|unauthorized|forbidden|bad gateway|api key|subscription)\b/i.test(page.body)
    return { ok, reason: ok ? 'documented_plain_text_verified' : 'invalid_json' }
  }
  if (typeof data === 'string' && !/\b(?:quote|joke|fact|phrase|proverb|greeting|lorem|insult)\w*\b/i.test(description)) {
    return { ok: false, reason: 'unverified_text_functionality' }
  }
  if (Array.isArray(data) && data.length && data.every(row => row && typeof row === 'object'
    && /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(row.type ?? row.method ?? '') && (row.fullUrl || row.path))) {
    return { ok: false, reason: 'service_manifest_not_functionality' }
  }
  if (Array.isArray(data) && data.length && /agent team|workflow orchestration/i.test(description)
    && data.every(row => row?.at && row?.by && row?.kind && row?.what)) {
    return { ok: false, reason: 'service_changelog_not_functionality' }
  }
  if (Array.isArray(data) && data.length && data.every(value => typeof value === 'number')
    && /\/stats(?:[/.]|$)/i.test(new URL(page.url).pathname) && !/statistic|count|number|metric|math/i.test(description)) {
    return { ok: false, reason: 'service_metadata_not_functionality' }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.type === 'FeatureCollection' || Array.isArray(data.features)) {
      const metadata = data.features?.length && data.features.every((feature: any) => feature?.geometry
        && feature.properties && Object.keys(feature.properties).every(key => /^(?:id|name|title|type|collection|resources|description)$/i.test(key)))
      if (metadata && /forecast|weather|currents?|profiles?|cross sections|radar/i.test(description)
        && !/\b(?:location catalogue|geocod\w*|boundaries)\b/i.test(description)) {
        return { ok: false, reason: 'location_catalogue_not_advertised_functionality' }
      }
    }
    const values = Object.values(data)
    if (Array.isArray(data.layergroups) && data.layergroups.length
      && data.layergroups.every((group: any) => Array.isArray(group.layers) && group.layers.every((layer: any) =>
        Array.isArray(layer.timesteps) && layer.timesteps.every((step: any) => typeof step.url==='string')))
      && !/catalog|directory/i.test(description)) {
      return { ok: false, reason: 'forecast_resource_manifest_not_functionality' }
    }
    if (values.length && values.every((value: any) => value && typeof value === 'object'
      && Array.isArray(value.area) && Array.isArray(value.content))) {
      return { ok: false, reason: 'service_options_not_functionality' }
    }
    if (data.title && ('body_html' in data || 'body_markdown' in data)
      && !/\b(?:articles?|blog|posts?|news|content management)\b/i.test(description)) {
      return { ok: false, reason: 'documentation_article_not_api_functionality' }
    }
    const declarations = data.function_declarations ?? data.functionDeclarations ?? data.functions
    if (Array.isArray(declarations) && declarations.length && declarations.every((entry: any) => entry?.name && (entry?.parameters || entry?.inputSchema || entry?.input_schema))) {
      return { ok: false, reason: 'service_manifest_not_functionality' }
    }
    if (data.sample === true && !/\b(?:mock|fake|fixture|sample data|synthetic data)\b/i.test(description)) {
      return { ok: false, reason: 'sample_response_not_live_functionality' }
    }
    const content = data.data ?? data.result ?? data
    if (data.html && data.raw_path && data.blame_path
      || data.meta_tool && (data.meta_tool.input_schema || data.meta_tool.inputSchema || data.meta_tool.parameters)
      || data.contract?.hierarchy && data.contract?.dimensions?.pricing_model && data.families
      || data.runsTotal && data.cases && Array.isArray(data.runs)
      || data._postman_variable_scope
      || data.transport && data.openapi && data.hint
      || data.podcasts?.totals && data.episodes?.totals && data.episodes?.added
      || Array.isArray(data.exchanges) && data.exchanges.length && data.exchanges.every((row: any) => row?.name && row?.api && row?.type)
        && /transfer routing/i.test(description)
      || data.service && data.host && Object.keys(data).every(key => /^(?:status|service|host|dataset_version|edge_colo|response_ms)$/i.test(key))
      || data.contractVersion && data.endpointBase && data.templatePayload
      || Array.isArray(data.capabilities) && data.capabilities.length && data.capabilities.every((row: any) => row?.action && row?.required_params)
      || Array.isArray(data.apis) && data.apis.length && data.apis.every((row: any) => row?.method && row?.path)
        && !/catalog|directory|registry/i.test(description)
      || data.endpoints && data.categories && typeof data.message === 'string' && !data.joke
      || data.connections && Array.isArray(data.nodes) && data.nodes.some((node: any) => /^n8n-nodes/.test(node?.type ?? ''))
        && !/templates?|workflow catalog/i.test(description)
      || data.provider && data.docs && (data.billing || data.billingUnit || data.pricingPage)
      || data.registry_hash && data.release && Array.isArray(data.data)
      || data.name && (data.input_schema || data.inputSchema || data.parameters?.properties)
      || data.tools && data.how_to_choose && data.billing
      || data.billing && Array.isArray(data.types) && data.types.length && data.types.every((row: any) => row?.required_params)
      || Array.isArray(data.results) && data.results.length && data.results.every((row: any) => row?.method && row?.path && row?.pricing)
        && !/catalog|directory|registry/i.test(description)
      || data.page?.url && data.status && Array.isArray(data.components) && Array.isArray(data.incidents)
        && !/\bstatus|uptime|outage|monitor/i.test(description)
      || data.requestMaxBytes && data.sites?.maxFiles
      || data.abi && data.abiRevision && data.versions
      || Array.isArray(data.languages) && data.languages.length && data.languages.every((row: any) => row?.file && row?.title)
        && !/language|translation/i.test(description)
      || Array.isArray(content) && content.length && content.every((row: any) => row?.input_modalities && row?.pricing)
        && !/model (?:catalog|directory|pricing)/i.test(description)
      || Array.isArray(content) && content.length && content.every((row: any) => row?.status === 'planned' && row?.title && row?.text)
      || content.endpoints && content.site && content.fonts && !/statistics/i.test(description)
      || data.endpoints && data.version && data.description && !data.data && !data.results) {
      return { ok: false, reason: 'service_metadata_not_functionality' }
    }
    if (data.type === 'function' && data.function?.name && data.function?.parameters
      || data.operations && (data['x-mcp-tools'] || data['x-mcp-tool-list'] || data['x-a2a-skills'])
      || data.noProviderCalls === true && data.executionBootstrap
      || data.hello && Object.keys(data).length === 1 && !/greeting|hello|echo/i.test(description)
      || data.name && data.docs && Object.keys(data).every(key => /^(?:name|docs|mcp)$/i.test(key))
      || data.data?.marketStatus !== undefined && Object.keys(data.data).every(key => key === 'marketStatus')
      || Array.isArray(data.regions) && data.regions.length && data.regions.every((r: any) => r?.apiUrl)
        && !/regions?|datacent(?:er|re)/i.test(description)
      || data.smoke_at && data.bench_at && data.families && /agent team|workflow orchestration/i.test(description)
      || Array.isArray(data.ipv4) && Array.isArray(data.ipv6) && /screenshot|page content/i.test(description)) {
      return { ok: false, reason: 'service_metadata_not_functionality' }
    }
    if (data.topic_list && Array.isArray(data.users) && !/forum|discourse|discussion/i.test(description)) {
      return { ok: false, reason: 'support_forum_not_advertised_api_functionality' }
    }
    if (/\brpc\b/i.test(description) && typeof data.auth === 'string'
      && Array.isArray(data.chains) && data.chains.length
      && data.chains.every((chain: any) => typeof chain?.https === 'string' && typeof chain?.docs === 'string')) {
      return { ok: false, reason: 'service_metadata_not_functionality' }
    }
    const payload = data.data ?? data.result ?? data
    if (data.requestSchema && data.methods && data.endpoint
      || data.tools && data.openapi && data.usage
      || data.methods && data.requestFormat && data.responseFormat
      || data.feeds && data.docs && Object.keys(data).every(key => /^(?:feeds|docs|note|updated)$/i.test(key))
      || data.service && data.mcp_tool && data.endpoint && data.params
      || data.authenticated === false && data.principal === null && data.plan
      || data.sample_only && data.live_prediction_data_requires_paid_key) {
      return { ok: false, reason: 'service_metadata_not_functionality' }
    }
    if (data.documentation && data.methods && data.health && data.title
      && !/\b(?:api catalog|public apis|api directory)\b/i.test(description)) {
      return { ok: false, reason: 'unrelated_api_catalogue_entry' }
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload.documentation && payload.version && (payload.authentication || payload.endpoints || payload.rate_limit || payload.terms_of_service)
        || payload.endpoints && Array.isArray(payload.tools)
        || payload.endpoints && (payload.docs || payload.openapi || payload.mcp_tools)
        || payload.apiCatalog && (payload.docs || payload.openapi || payload.mcp)
        || payload.totalEndpoints && payload.groups && payload.description
        || payload.service && payload.billing && (payload.checkout || payload.callbacks)
        || payload.servicos && payload.creditos && payload.pagamento
        || (payload.como_comprar || payload.how_to_purchase || payload.how_to_pay) && (payload.ofertas || payload.offers || payload.gratis)
        || payload.free_endpoints && payload.payment
        || payload.engine && payload.reference && payload.method && payload.samples && !/benchmark/i.test(description))) {
      return { ok: false, reason: 'service_metadata_not_functionality' }
    }
    if ((data.description || data.version || data.documentation || data.endpoints)
      && Object.keys(data).every(key => /^(?:name|description|version|apiVersion|endpoints|routes|capabilities|status|success|documentation|docs|openapi|mcp|links|author|creator|license)$/i.test(key))) {
      return { ok: false, reason: 'service_manifest_not_functionality' }
    }
    const directoryRows = data.data
    const descriptors = Array.isArray(directoryRows) && directoryRows.length && directoryRows.every((row: any) => row?.uri
      && Object.keys(row).every(key => /^(?:name|label|description|uri|version)$/i.test(key)))
    if (descriptors || data.model?.dimensions && (data.model.fact_table || data.model.measures)
      || data.object === 'list' && Array.isArray(data.data) && data.data.length && data.data.every((row: any) => row?.object === 'model')
      || data.headers && data.method && data.url && !/\b(?:echo|httpbin|http testing|request inspection)\b/i.test(description)) {
      return { ok: false, reason: 'service_metadata_not_functionality' }
    }
    const items = data.result?.items ?? data.result?.results
    const collections = data.data?.collections
    if ((Array.isArray(items) && items.some((row: any) => row?.distribution || row?.accrualPeriodicity)
      || Array.isArray(collections) && collections.length && collections.every((row: any) => row?.collectionId && row?.name)
      || Array.isArray(data.datasets) && data.datasets.length && data.datasets.every((row: any) => row?.columns && row?.formats))
      && !/catalog|open government|open data/i.test(description)) return { ok: false, reason: 'dataset_catalogue_not_functionality' }
    const fields = Object.entries(data).filter(([key]) => !/^(?:status|success|code|creator|copyright|attribution|license|timestamp)$/i.test(key))
    if (fields.length === 1 && /^(?:result|data|response)$/i.test(fields[0][0]) && typeof fields[0][1] === 'string'
      && !/\b(?:text|jokes?|quotes?|facts?|trivia|dare|truth|advice|definition|translation|poetry|poem|proverb|insult|greeting|lorem|eight ball)\b/i.test(description)) {
      return { ok: false, reason: 'unverified_text_functionality' }
    }
  }
  const forecastIndex = Array.isArray(data) ? data : data && typeof data==='object'
    && Object.keys(data).every(key=>/^(?:routes|reftimes|timesteps|areas|parameters|options|products|models|resources)$/i.test(key))
    ? Object.values(data).flat() : null
  if (Array.isArray(forecastIndex) && forecastIndex.length && forecastIndex.every(value=>typeof value==='string')
    && /\/(?:routes|reftimes|timesteps|areas|parameters|options|products|models|resources)\/?$/i.test(new URL(page.url).pathname) && /forecast|cross sections|weather|radar/i.test(description)) {
    return { ok: false, reason: 'forecast_catalogue_not_functionality' }
  }
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const values = Object.values(data)
    const imageResult = [data.image,data.url,data.message].some(value => typeof value === 'string' && /^https:\/\/.+\.(?:png|jpe?g|gif|webp)(?:\?|$)/i.test(value))
    const directory = !imageResult && values.length && values.every(value => typeof value === 'string'
      && (/^https:\/\//.test(value) && new URL(value).origin === new URL(page.url).origin
        || /^\/[a-z][\w/:.-]*$/i.test(value)))
    const descriptors = values.length && values.every((value: any) => value && typeof value === 'object' && (value.documentation || value.swagger) && value.version)
    if (directory || descriptors || data.transport && data.mcp && Array.isArray(data.chains)) return { ok: false, reason: 'service_manifest_not_functionality' }
  }
  if (data && !Array.isArray(data) && typeof data === 'object' && (/^[23]\.\d/.test(data.openapi ?? data.swagger ?? '') && (data.paths || data.info)
    || (data.collection?.info ?? data.info)?._postman_id || /postman/i.test((data.collection?.info ?? data.info)?.schema ?? '')
    || data.identifierSpace && data.schemaSpace && data.versions && data.suggest
    || data.jsonrpc && (data.result?.capabilities || data.result?.tools)
    || Array.isArray(data.tools) && data.tools.some((tool: any) => tool?.inputSchema || tool?.input_schema)
    || Array.isArray(data.apis) && data.specificationVersion
    || data.icons && (data.start_url || data.short_name || Array.isArray(data.icons))
    || (data.endpoints || data.routes || data.capabilities) && Object.keys(data).every(key => /^(?:name|description|version|apiVersion|endpoints|routes|capabilities|status|success|documentation)$/i.test(key)))) return { ok: false, reason: 'service_manifest_not_functionality' }
  // A suite mentioning a validation tool does not turn every other operation
  // (pricing, datasets, etc.) into a validator that must return a verdict.
  const validator = /\bvalidat(?:e|es|ion|or)\b/i.test(description.split(/\bAPI\b|[.!?]|\b(?:provides?|offers?|checks?|generates?)\b/i)[0])
    || /\/(?:validate|validation|validator)(?:\/|$)/i.test(new URL(page.url).pathname)
  if (validator) {
    const object = data?.result ?? data?.data ?? data
    const verdict = object?.valid ?? object?.isValid ?? object?.is_valid ?? object?.validation ?? object?.verdict
    if (typeof verdict !== 'boolean' && !/^(?:valid|invalid)$/i.test(String(verdict ?? ''))) return { ok: false, reason: 'advertised_validation_unverified' }
  }
  if (/AI(?:[- ]generated)?(?: content| text)? detect|detect AI[- ]generated/i.test(description)) {
    const detection = data?.result ?? data?.data ?? data
    const verdict = detection?.ai_probability ?? detection?.ai_score ?? detection?.is_ai ?? detection?.isAI
      ?? detection?.classification ?? detection?.label ?? detection?.verdict ?? detection?.prediction ?? detection?.score
    if (verdict == null && !Array.isArray(detection?.sentences)) {
      return { ok: false, reason: 'advertised_text_detection_unverified' }
    }
  }
  const meaningful = (value: any, depth = 0): boolean => {
    if (depth > 8 || value == null) return false
    if (typeof value === 'string') return value.trim().length > 1 && !/^(?:ok|online|healthy|running|success|up)$/i.test(value)
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'boolean') return validator
    if (Array.isArray(value)) return value.some(v => meaningful(v, depth + 1))
    if (typeof value !== 'object') return false
    if ((value.error && (typeof value.error !== 'object' || Object.keys(value.error).length))
      || typeof value.error_message === 'string' && value.error_message.trim().length > 0
      || (value.errors && typeof value.errors === 'object' && Object.keys(value.errors).length) || value.success === false || value.ok === false || value.status === false
      || /^(?:error|fail(?:ed|ure)?|unauthorized|forbidden)$/i.test(String(value.status ?? ''))
      || (typeof value.status === 'number' && value.status >= 400)
      || /(?:invalid|missing|required|unauthorized|expired|subscription|rate.?limit|access denied|upgrade|api.?key|not found)/i.test(String(value.message ?? value.detail ?? ''))) return false
    return Object.entries(value).some(([key, v]) => (key === 'message' && (Array.isArray(v) || typeof v === 'object' && v !== null || typeof v === 'string' && /^https:\/\//.test(v))
      || !/^(?:status|success|ok|message|code|error|errors|meta|metadata|links|version|health|uptime|timestamp|request.?id|documentation|docs|plan|pricing|billing|rate.?limit|credits|quota|count|total|total_pages|resultCount|found|creator|copyright|attribution|license|provider_name|provider_url|_rights)$/i.test(key))
      && meaningful(v, depth + 1))
  }
  return meaningful(data) ? { ok: true, reason: 'functional_documented_data' } : { ok: false, reason: 'empty_error_or_metadata_response' }
}
export function classifyTerms(raw: string): { permission: Permission; note: string } {
  const plain = text(raw).replace(/\s+/g, ' ')
  if (/\bthis (?:work|data|content) is licensed under (?:a )?creative commons attribution.noncommercial/i.test(plain)) {
    return { permission: 'PROHIBITED', note: 'The provider explicitly licences this content for non-commercial use.' }
  }
  if (/\bAPI data usage conditions:/i.test(raw) && /\bCC[- ]BY[- ](?:NC|NC[- ](?:SA|ND))\b|creativecommons\.org\/licenses\/by-nc(?:-sa|-nd)?\//i.test(raw)) {
    return { permission: 'PROHIBITED', note: 'The provider explicitly attaches a non-commercial Creative Commons licence to this API data.' }
  }
  const sentences = plain.split(/(?<=[.!?])\s+/)
  const serviceContext = /\b(?:api|service|access)\b/i.test(plain)
  const grants: string[] = [], bans: string[] = [], uncertain: string[] = []
  for (const sentence of sentences) {
    // Example input defaults describe a request, not the provider's usage terms.
    if (/^\s*(?:defaults?|default parameters?|example inputs?)\s*:/i.test(sentence)) continue
    if (!serviceContext && !/\b(?:api|service|access|proxy|resell|resale)\b/i.test(sentence)) continue
    if (/\b(?:sdk|source code|documentation|software license|website content)\b/i.test(sentence)
      && !/api (?:service|access)|proxy access/i.test(sentence)) continue
    if (/\b(?:credential|password|accounts?|trademark|pre-release materials)\b/i.test(sentence)
      && /resell|sell|resale/i.test(sentence) && !/\b(?:api|data|proxy|service access)\b/i.test(sentence)) continue
    if (/\bcommercial code\b/i.test(sentence) && !/resell|resale|proxy|commercial (?:use|access|purposes)/i.test(sentence)) continue
    // Provider privacy promises are not restrictions on a customer's API use.
    if (/do not sell or share my personal information/i.test(sentence)
      || /\bwe\s+(?:never|do not|don['’]t|will not)\b[^.!?]*\bsell\b/i.test(sentence)
        && !/\byou\s+(?:may not|must not|shall not|cannot)\b/i.test(sentence)) continue
    const use = /resell|resale|\bsell\b|proxy|commercial|non.commercial|personal use only|only for academic use|academic users only/i.test(sentence)
    if (!use) continue
    // Negation must govern the restricted activity, not an unrelated clause
    // about client secrets, commercial market data, or a third party's policy.
    const negation = String.raw`(?:may not|must not|shall not|will not|do not|don['’]t|cannot|agree not to|not allowed to|not permitted to|not (?=resell|redistribut|sublicen))`
    const restricted = String.raw`(?:resell|resale|sell access|redistribut\w*|sublicen[sc]\w*|proxy (?:the |our |this )?(?:api|service|access))`
    const ban = (new RegExp(negation + String.raw`\b[^.!?;]{0,180}\b` + restricted, 'i').test(sentence)
      || new RegExp(negation + String.raw`\s+(?:use|access|offer|provide)\b[^.!?;]{0,120}\bcommercial`, 'i').test(sentence)
      || /\b(?:resale|commercial use|commercial access)\b[^.!?;]{0,50}\b(?:prohibited|forbidden|not permitted|not allowed)\b|\bno (?:resale|commercial use)\b|\bpersonal use only\b/i.test(sentence)
      || /\bonly for academic use\b|\bacademic users only\b/i.test(sentence)
      || /\b(?:only|restricted to|limited to|exclusively)\b[^.!?;]{0,40}\bnon.commercial\b|\b(?:free|available|provided|offered)\s+for\b[^.!?;]{0,50}\bnon.commercial\b|\bpersonal[,\s]+(?:and\s+)?non.commercial\b|\bnon.commercial (?:use|purposes) only\b/i.test(sentence)
        && !/\bnon.commercial\s*(?:,?\s*(?:or|and)|\/)\s*commercial\b|\bcommercial\s*(?:,?\s*(?:or|and)|\/)\s*non.commercial\b/i.test(sentence))
      && !/do(?:es)? not prohibit|no prohibition|not prohibited/i.test(sentence)
    const grant = !ban && /\b(?:may|permitted|allowed|authoriz(?:ed|e))\b|\bpermission (?:is )?granted\b/i.test(sentence)
    const conditional = /unless|except|in violation of (?:these|the) terms|(?:prior|written|explicit|separate) (?:permission|consent|authori[sz]ation)|without[^.!?]{0,40}(?:permission|consent|authori[sz]ation)|(?:obtain|seek|requires?|subject to)[^.!?]{0,40}(?:permission|consent|authori[sz]ation)|certain plans|third.party|underlying data|raw data.*standalone product|contact us[^.!?]{0,60}(?:permission|commercial|resale)|(?:separate|written) agreement|without (?:proper )?attribution/i.test(sentence)
    const uncertainScope = /\b(?:site|website|such documents|such information)\b/i.test(sentence) && !/\bapi\b/i.test(sentence)
    if (conditional && (ban || grant) || uncertainScope && ban) uncertain.push(sentence)
    else if (ban) bans.push(sentence)
    else if (grant && /commercial/i.test(sentence) && /proxy|resell|resale|sell access/i.test(sentence)) grants.push(sentence)
    else if (/resale restriction|licensing requirement|does not (?:allow|grant).*(?:commercial|redistribut|resell)/i.test(sentence)
      || /resell|resale|redistribut|\bsell\b/i.test(sentence)
        && (new RegExp(negation + String.raw`[^.!?]*\b(?:resell|resale|redistribut\w*|sell)\b`,'i').test(sentence)
          || /prohibit|restrict/i.test(sentence))) uncertain.push(sentence)
  }
  const permission: Permission = bans.length && grants.length ? 'REVIEW_REQUIRED' : bans.length ? 'PROHIBITED'
    : uncertain.length ? 'REVIEW_REQUIRED' : grants.length ? 'ALLOWED' : 'UNKNOWN'
  return { permission, note: [...bans, ...uncertain, ...grants].join(' ').slice(0, 1200) || 'No explicit applicable commercial proxy/resale permission or prohibition found.' }
}
/** Only explicit provider rights fields; arbitrary dataset content is not policy. */
export function responseTerms(page: Page): string {
  if (!/json/i.test(page.type)) return page.body
  let data: any
  try { data = JSON.parse(page.body) } catch { return '' }
  if (Array.isArray(data)) {
    const first = data[0]
    data = first && first.legal && Object.keys(first).every(key => /^(?:legal|last_updated|updated|copyright|license)$/i.test(key)) ? first : null
  }
  const parts: string[] = []
  const collect = (value: any, depth = 0) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return
    for (const [key, content] of Object.entries(value)) {
      if (/^(?:_?rights|legal|usage|licen[sc]e(?:_note)?|terms(?:_of_use)?|conditions|condiciones|condizioni|condicoes|condições|villkor|attribution|dct:rights)$/i.test(key)) {
        parts.push(typeof content === 'string' ? content : JSON.stringify(content))
      }
      if (/^(?:meta|metadata|_meta)$/i.test(key)) collect(content, depth + 1)
    }
  }
  collect(data)
  return parts.length ? 'API data usage conditions: ' + parts.join('\n') : ''
}
export async function checkTerms(item: Lead, pages: Page[], network: Network, endpoint?: string) {
  const research = [...pages]
  if (endpoint && (domain(endpoint) !== domain(item.docs) || pages.every(page => !/html/i.test(page.type)))) {
    try { const homepage = await network.page(new URL('/', endpoint).href); if (homepage.status === 200) research.push(homepage) }
    catch (error) { if (error instanceof AccessError && error.message === 'worker_stopped') throw error }
  }
  const urls = [...new Set(research.flatMap(policyLinks).filter(url => (domain(url) === domain(item.docs) || endpoint && domain(url) === domain(endpoint))
    && !/github\.com\/.+\/(?:blob|tree)\/.+\/(?:LICENSE|COPYING)/i.test(url)))]
  for (const url of urls) {
    try { const page = await network.page(url); if (page.status === 200) research.push(page) }
    catch (error) { if (error instanceof AccessError && error.message === 'worker_stopped') throw error }
  }
  const findings = research.map(page => ({ page, ...(endpoint && !providerDocument(endpoint,page.url)
    ? { permission: 'UNKNOWN' as const, note: 'Documentation source retained; this page does not establish official provider commercial permission.' }
    : classifyTerms(page.body.startsWith('API data rights:') ? page.body : responseTerms(page))) }))
  const classes = findings.map(x => x.permission)
  const permission: Permission = classes.includes('PROHIBITED') && classes.includes('ALLOWED') ? 'REVIEW_REQUIRED'
    : classes.includes('PROHIBITED') ? 'PROHIBITED' : classes.includes('REVIEW_REQUIRED') ? 'REVIEW_REQUIRED'
      : classes.includes('ALLOWED') ? 'ALLOWED' : 'UNKNOWN'
  return { permission, evidence: findings.map(({ page, note }) => ({ url: page.url, sha256: page.sha256, note, checkedAt: new Date().toISOString() })) }
}

/** Detect explicitly labelled static examples without rejecting real request examples. */
export function documentedSample(pages: Page[], endpoint: string, description: string): boolean {
  if (/\b(?:mock|fake|fixture|sample data|synthetic data)\b/i.test(description)) return false
  const target = new URL(endpoint)
  if (target.search || !/\.(?:json|csv)$/i.test(target.pathname)) return false
  return pages.some(page => [...page.body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)].some(match => {
    let href
    try { href = new URL(match[1].replaceAll('&amp;', '&'), page.url).href } catch { return false }
    if (href !== endpoint) return false
    const surrounding = text(page.body.slice(Math.max(0, match.index! - 600), match.index! + match[0].length)).replace(/\s+/g, ' ')
    return /download[^.]{0,150}(?:sample|example)[^.]{0,100}(?:file|bulk)|download[^.]{0,100}(?:sample|example) of[^.]{0,100}file/i.test(surrounding)
  }))
}
/** The sole processing path, shared by the durable Worker and controlled evaluation. */
export async function evaluate(item: Lead, network: Network, previous?: Result | null, checkpoint?: (result: Result) => Promise<void>): Promise<Result> {
  // A successful functional test is durable evidence, even if terms were interrupted.
  if (previous?.technical === 'PASSED' && previous.freeAccess === 'VERIFIED' && previous.endpoint
    && previous.lastSuccess && previous.tests.some(test => test.status === 200 && test.sha256)) {
    if (previous.termsChecked) return { ...previous, retryAt: null }
    const result = structuredClone(previous)
    try {
      const { pages } = await documentation(item, network)
      const rights: Page[] = previous.responseRights ? [{ url: previous.endpoint, body: 'API data rights: ' + previous.responseRights,
        status: 200, type: 'text/plain', sha256: previous.tests.find(test => test.sha256)?.sha256 ?? '' }] : []
      const terms = await checkTerms(item, [...pages, ...rights], network, previous.endpoint)
      result.permission = terms.permission; result.termsChecked = true
      result.evidence = [...previous.evidence, ...terms.evidence]; result.retryAt = null; result.reason = 'validated'
    } catch (error) {
      result.reason = error instanceof AccessError ? error.message : 'documentation_processing_failed'
      result.retryAt = error instanceof AccessError && error.retryAt ? error.retryAt : new Date(Date.now() + 60_000).toISOString()
    }
    return result
  }
  const result = emptyResult(item.docs)
  if (!apiService(item)) { result.reason = 'not_an_api_service'; return result }
  const purpose = item.name + ' ' + item.description
  if (/\b(?:generat\w*|creat\w*|provision\w*|issu\w*)\b/i.test(purpose)
    && /\b(?:wireguard|warp|vpn configur\w*|credentials?|api keys?|access tokens?)\b/i.test(purpose)) {
    result.reason = 'credential_generation_not_tested'; return result
  }
  try {
    const { pages, endpoints, endpointDocs } = await documentation(item, network)
    result.docs = pages[0]?.url ?? item.docs
    const requiresCredentials = item.auth === 'required' || pages.some(page => /(?:api key|authentication|access token)\s+is\s+required|requires?\s+(?:an?\s+)?(?:api key|access token|paid subscription)|(?:paid subscription|subscription plan) required/i.test(text(page.body)))
    if (requiresCredentials && !pages.some(page => /(?:no (?:api )?key|no authentication|without (?:an? )?(?:api )?key|unauthenticated|public endpoint)/i.test(text(page.body)))) {
      result.freeAccess = 'CREDENTIALS_REQUIRED'; result.reason = 'documented_credentials_required'; return result
    }
    if (!endpoints.length) { result.reason = 'documented_endpoint_unresolved'; return result }
    let transient: AccessError | null = null
    for (const endpoint of endpoints) {
      if (!safeEndpoint(endpoint)) continue
      if (documentedSample(pages, endpoint, purpose)) {
        result.tests.push({ url: endpoint, status: null, reason: 'documentation_sample_not_functionality' }); continue
      }
      try {
        const response = await network.page(endpoint, true)
        if (!safeEndpoint(response.url)) { result.tests.push({ url: endpoint, status: response.status, reason: 'unsafe_redirect_target' }); continue }
        const imagePurpose = /\b(?:returns?|generates?|renders?|creates?|serves?|random|placeholder)\b[^.]{0,60}\b(?:images?|icons?|avatars?|photos?|charts?|pictures?)\b/i.test(item.description)
          || /\b(?:maps|weather charts|cross sections|radar images|vertical profiles)\b/i.test(item.description)
        const purpose = /^image\//i.test(response.type) && !imagePurpose ? item.name : item.name + ' ' + item.description
        const outcome = functional(response, purpose)
        result.tests.push({ url: response.url, status: response.status, reason: outcome.reason, sha256: response.sha256 })
        if (response.status === 401) result.freeAccess = 'CREDENTIALS_REQUIRED'
        if (!outcome.ok) continue
        result.technical = 'PASSED'; result.freeAccess = 'VERIFIED'; result.endpoint = response.url
        result.docs = endpointDocs[endpoint] ?? result.docs
        result.lastSuccess = new Date().toISOString(); result.reason = 'validated'
        // Response-provided rights are evidence too; code/data licences never grant API resale.
        const rights = responseTerms(response)
        if (rights) result.responseRights = rights
        await checkpoint?.(structuredClone(result))
        const rightsPages = rights ? [response] : []
        const terms = await checkTerms(item, [...pages, ...rightsPages], network, response.url)
        result.permission = terms.permission; result.termsChecked = true; result.evidence = terms.evidence
        return result
      } catch (error) {
        const failure = error instanceof AccessError ? error : new AccessError('test_failed')
        if (result.technical === 'PASSED') {
          // A later policy interruption cannot erase an actual successful test.
          // Incomplete terms keep the candidate out of the usable list.
          result.reason = failure.message; result.retryAt = failure.retryAt ?? new Date(Date.now() + 60_000).toISOString()
          return result
        }
        result.tests.push({ url: endpoint, status: null, reason: failure.message })
        if (failure.retryAt) transient = failure
        if (['rate_limited','provider_cooldown','access_denied','worker_stopped'].includes(failure.message)) break
      }
    }
    result.technical = 'FAILED'
    result.reason = result.tests.at(-1)?.reason ?? 'no_safe_functional_endpoint'
    if (transient) result.retryAt = transient.retryAt
  } catch (error) {
    result.reason = error instanceof AccessError ? error.message : 'documentation_processing_failed'
    result.retryAt = error instanceof AccessError ? error.retryAt : null
  }
  return result
}
