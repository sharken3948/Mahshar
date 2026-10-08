import 'server-only'
import { configuredArcRpc, getMaintenanceInventory } from './inventory'
import type { ArcNotice, MaintenanceCheckResult, MaintenanceDashboardDto, MaintenanceInventoryItem, MaintenanceSeverity } from './types'

const MAX_JSON_BYTES = 256_000
const CHECK_TIMEOUT_MS = 8_000

export type MaintenanceFetch = typeof fetch

type CheckDependencies = {
  fetch?: MaintenanceFetch
  now?: () => Date
  inventory?: MaintenanceInventoryItem[]
}

function bounded(value: unknown, maximum: number, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : fallback
}

async function officialText(fetcher: MaintenanceFetch, url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    const response = await fetcher(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal, headers })
    if (!response.ok) throw new Error(`upstream_${response.status}`)
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_JSON_BYTES) throw new Error('upstream_too_large')
    if (!response.body) throw new Error('upstream_empty')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = 0
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('upstream_too_large') }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function officialJson(fetcher: MaintenanceFetch, url: string, init?: RequestInit): Promise<unknown> {
  return JSON.parse(await officialText(fetcher, url, init)) as unknown
}

type Version = { major: number; minor: number; patch: number; prerelease: string[] | null }

export function parseVersion(value: string): Version | null {
  const match = value.trim().replace(/^v/, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) return null
  const prerelease = match[4]?.split('.') || null
  if (prerelease?.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null
  return { major: parts[0], minor: parts[1], patch: parts[2], prerelease }
}

export function compareVersions(current: string, latest: string): number | null {
  const left = parseVersion(current); const right = parseVersion(latest)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch'] as const) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  if (left.prerelease === null && right.prerelease === null) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]; const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a); const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

function updateSeverity(current: string, latest: string): MaintenanceSeverity {
  const left = parseVersion(current); const right = parseVersion(latest)
  if (!left || !right) return 'Review'
  return left.major === right.major && left.minor === right.minor ? 'Info' : 'Review'
}

function failure(item: MaintenanceInventoryItem, checkedAt: string): MaintenanceCheckResult {
  return { ...item, latest: null, status: 'check_failed', severity: 'Review', impact: 'The source could not be checked. Mahshar continues operating unchanged.', details: 'This source failed independently; no application configuration was changed.', recommended_action: 'Retry the manual check later.', checked_at: checkedAt }
}

async function checkPackage(item: MaintenanceInventoryItem, fetcher: MaintenanceFetch, checkedAt: string): Promise<MaintenanceCheckResult> {
  const packageName = item.package_name as string
  const data = await officialJson(fetcher, `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`) as { version?: unknown }
  const latest = bounded(data.version, 64)
  const comparison = compareVersions(item.current, latest)
  if (!latest || comparison === null) throw new Error('package_metadata_invalid')
  if (comparison >= 0) return { ...item, latest, status: 'current', severity: 'Info', impact: 'Installed version is current.', details: 'Official npm registry metadata reports no newer stable version.', recommended_action: 'No action required.', checked_at: checkedAt }
  const severity = updateSeverity(item.current, latest)
  return { ...item, latest, status: 'update_available', severity, impact: 'A newer package version is available; the current integration remains unchanged.', details: `Official npm metadata reports ${latest}. No compatibility claim is inferred.`, recommended_action: 'Review the official release notes and test manually before any upgrade.', checked_at: checkedAt }
}

export function evaluateArcRelease(item: MaintenanceInventoryItem, latest: string, notes: string, checkedAt: string, configuredRpcs = configuredArcRpc().values): MaintenanceCheckResult {
  const text = notes.toLowerCase()
  const mentionsConfigured = configuredRpcs.some(value => text.includes(value.toLowerCase().replace(/\/$/, '')))
  const rpcFacing = /\bjson-rpc\b|\brpc\b|\bendpoint\b|\beth_[a-z]/.test(text)
  const retirement = /deprecat|sunset|retir|brownout/.test(text)
  if (mentionsConfigured && retirement) return { ...item, latest, status: 'action_required', severity: 'Critical', impact: 'The latest Arc release notes name a configured Mahshar RPC endpoint in a retirement notice.', details: 'Mahshar does not operate an Arc node, but this RPC-facing release note directly matches its configuration.', recommended_action: 'Review the official release and validate an approved endpoint change manually.', checked_at: checkedAt }
  if (rpcFacing) return { ...item, latest, status: 'current', severity: 'Review', impact: 'No Mahshar node upgrade is required, but the release notes contain RPC-facing changes worth reviewing.', details: 'Mahshar is an RPC consumer rather than a node operator. No runtime change was made.', recommended_action: 'Review the official RPC-facing release notes against Mahshar’s request behavior.', checked_at: checkedAt }
  return { ...item, latest, status: 'current', severity: 'Info', impact: 'No Mahshar node upgrade is required because Mahshar is an RPC consumer, not a node operator.', details: `The latest official Arc node release is ${latest}; no application-facing RPC change was identified in its bounded release summary.`, recommended_action: 'No action required beyond normal monitoring.', checked_at: checkedAt }
}

async function checkArcRelease(item: MaintenanceInventoryItem, fetcher: MaintenanceFetch, checkedAt: string): Promise<MaintenanceCheckResult> {
  const headers: Record<string, string> = { 'x-github-api-version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN?.trim()) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`
  const data = await officialJson(fetcher, 'https://api.github.com/repos/circlefin/arc-node/releases/latest', { headers }) as { tag_name?: unknown; body?: unknown }
  const latest = bounded(data.tag_name, 64)
  if (!latest || !parseVersion(latest)) throw new Error('arc_release_invalid')
  return evaluateArcRelease(item, latest, bounded(data.body, 10_000), checkedAt)
}

export function evaluateArcNotice(item: MaintenanceInventoryItem, notice: ArcNotice, configuredRpc: string | string[] = configuredArcRpc().values, checkedAt = notice.updatedAt): MaintenanceCheckResult {
  const text = `${notice.title} ${notice.body}`.toLowerCase()
  const configured = (Array.isArray(configuredRpc) ? configuredRpc : [configuredRpc]).map(value => value.toLowerCase().replace(/\/$/, '')).filter(Boolean)
  const mentionsConfigured = configured.some(value => text.includes(value))
  const testnetOnly = /testnet/.test(text) && !/mainnet/.test(text)
  const configuredUsesTestnet = configured.some(value => value.includes('testnet'))
  if (testnetOnly && !configuredUsesTestnet && !mentionsConfigured) {
    return { ...item, latest: bounded(notice.title, 180), source_url: notice.url, status: 'current', severity: 'Info', impact: 'No Mahshar action required — Mahshar’s configured RPC roles target Mainnet, not the affected Testnet endpoint.', details: 'This official Arc notice is Testnet-only. Full notice text remains at the official source.', recommended_action: 'No action required. Continue monitoring Mainnet notices.', checked_at: checkedAt }
  }
  if (mentionsConfigured || (!testnetOnly && /deprecat|sunset|retir|brownout/.test(text))) {
    return { ...item, latest: bounded(notice.title, 180), source_url: notice.url, status: 'action_required', severity: mentionsConfigured ? 'Critical' : 'Important', impact: mentionsConfigured ? 'The notice names a configured Mahshar RPC endpoint.' : 'This Mainnet or network-wide endpoint notice may affect Mahshar.', details: 'This is an official Arc endpoint or operational notice. Full notice text remains at the official source.', recommended_action: 'Review the official notice and validate an approved endpoint change manually.', checked_at: checkedAt }
  }
  return { ...item, latest: bounded(notice.title, 180), source_url: notice.url, status: 'unknown', severity: 'Review', impact: 'Review is warranted, but direct Mahshar impact was not established.', details: 'This official Arc operational notice did not match a configured endpoint. Full notice text remains at the official source.', recommended_action: 'Compare the official notice with Mahshar’s configured Arc Mainnet RPC roles.', checked_at: checkedAt }
}

async function checkArcStatus(item: MaintenanceInventoryItem, fetcher: MaintenanceFetch, checkedAt: string): Promise<MaintenanceCheckResult> {
  const data = await officialJson(fetcher, 'https://status.arc.io/api/v2/summary.json') as {
    status?: { description?: unknown }; incidents?: unknown[]; scheduled_maintenances?: unknown[]
  }
  const entries = [...(Array.isArray(data.incidents) ? data.incidents : []), ...(Array.isArray(data.scheduled_maintenances) ? data.scheduled_maintenances : [])].slice(0, 20)
  const notices: ArcNotice[] = entries.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const title = bounded(row.name, 180); if (!title) return []
    const updates = Array.isArray(row.incident_updates) ? row.incident_updates : []
    const update = updates[0] && typeof updates[0] === 'object' ? updates[0] as Record<string, unknown> : {}
    const updatedAt = bounded(row.updated_at, 40, checkedAt)
    return [{ id: bounded(row.id, 100, title), title, body: bounded(update.body, 600), url: item.source_url, updatedAt: Number.isNaN(Date.parse(updatedAt)) ? checkedAt : new Date(updatedAt).toISOString() }]
  })
  if (notices.length) {
    const evaluated = notices.map(notice => evaluateArcNotice(item, notice, configuredArcRpc().values, checkedAt))
    const rank = { Critical: 4, Important: 3, Review: 2, Info: 1 }
    return evaluated.sort((a, b) => rank[b.severity] - rank[a.severity] || b.checked_at.localeCompare(a.checked_at))[0]
  }
  const status = bounded(data.status?.description, 120)
  if (!status) throw new Error('arc_status_invalid')
  return { ...item, latest: 'No active notices', status: 'current', severity: 'Info', impact: 'No active official Arc incident or maintenance notice requires Mahshar action.', details: 'The official Arc status source returned no active incidents or scheduled maintenance.', recommended_action: 'No action required.', checked_at: checkedAt }
}

export function evaluateGroqModel(item: MaintenanceInventoryItem, modelIds: string[], checkedAt: string): MaintenanceCheckResult {
  if (modelIds.includes(item.current)) return { ...item, latest: 'Available', status: 'current', severity: 'Info', impact: 'The configured Groq model is currently returned by the official Models API.', details: `Configured model ${item.current} is available.`, recommended_action: 'No action required.', checked_at: checkedAt }
  return { ...item, latest: 'Unavailable', status: 'action_required', severity: 'Critical', impact: 'The configured Groq model is not available from the official Models API.', details: 'Tasks using the centralized Groq integration may fail until an operator reviews a supported replacement.', recommended_action: 'Review Groq deprecations and test a supported replacement manually before changing configuration.', checked_at: checkedAt }
}

function plainCell(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/`/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim()
}

export function groqDeprecationForModel(document: string, model: string): { deprecated: boolean; shutdown: string | null } {
  const shutdownDate = (value: string) => {
    const candidate = bounded(value, 32)
    return /^(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})$/.test(candidate) ? candidate : null
  }
  const markdownRows = document.split(/\r?\n/).flatMap(line => {
    if (!line.includes('|')) return []
    const cells = line.split('|').map(plainCell).filter((cell, index, values) => cell || (index > 0 && index < values.length - 1))
    return cells.length >= 2 ? [cells] : []
  })
  for (const cells of markdownRows) if (cells[0] === model) return { deprecated: true, shutdown: shutdownDate(cells[1]) }

  const rows = document.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => plainCell(match[1]))
    if (cells[0] === model) return { deprecated: true, shutdown: shutdownDate(cells[1]) }
  }
  return { deprecated: false, shutdown: null }
}

export function validGroqDeprecationDocument(document: string): boolean {
  const text = plainCell(document).toLowerCase()
  return text.includes('shutdown date') && (text.includes('deprecated model') || text.includes('model id'))
}

async function checkGroqDeprecations(item: MaintenanceInventoryItem, fetcher: MaintenanceFetch, checkedAt: string): Promise<MaintenanceCheckResult> {
  const document = await officialText(fetcher, item.source_url, { headers: { accept: 'text/markdown, text/html;q=0.8' } })
  if (!validGroqDeprecationDocument(document)) throw new Error('groq_deprecations_invalid')
  const notice = groqDeprecationForModel(document, item.current)
  if (!notice.deprecated) return { ...item, latest: 'No matching notice', status: 'current', severity: 'Info', impact: 'The configured model is not listed in the deprecated-model column of Groq’s official notice table.', details: 'Availability is checked separately against the Groq Models API.', recommended_action: 'No action required.', checked_at: checkedAt }
  return { ...item, latest: notice.shutdown ? `Shutdown ${notice.shutdown}` : 'Deprecation listed', status: 'deprecation_notice', severity: 'Important', impact: 'Groq lists the configured Mahshar model as deprecated.', details: 'The notice is separate from live model availability and may require action before its shutdown date.', recommended_action: 'Review the official notice and test a supported replacement manually.', checked_at: checkedAt }
}

async function checkGroqModel(item: MaintenanceInventoryItem, fetcher: MaintenanceFetch, checkedAt: string): Promise<MaintenanceCheckResult> {
  const key = process.env.GROQ_API_KEY?.trim()
  if (!key) throw new Error('groq_not_configured')
  const data = await officialJson(fetcher, 'https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` } }) as { data?: unknown[] }
  if (!Array.isArray(data.data)) throw new Error('groq_models_invalid')
  const ids = data.data.slice(0, 500).flatMap(value => value && typeof value === 'object' ? [bounded((value as Record<string, unknown>).id, 160)] : []).filter(Boolean)
  if (ids.length === 0) throw new Error('groq_models_invalid')
  return evaluateGroqModel(item, ids, checkedAt)
}

export function maintenanceSummary(results: MaintenanceCheckResult[]) {
  return {
    critical: results.filter(item => item.severity === 'Critical').length,
    important: results.filter(item => item.severity === 'Important').length,
    review: results.filter(item => item.severity === 'Review').length,
    current: results.filter(item => item.status === 'current').length,
    check_failures: results.filter(item => item.status === 'check_failed').length,
  }
}

export function maintenanceInventoryDashboard(): MaintenanceDashboardDto {
  const inventory = getMaintenanceInventory()
  return { inventory, results: [], summary: { critical: 0, important: 0, review: 0, current: 0, check_failures: 0 }, checked_at: null }
}

export async function checkMaintenanceUpdates(dependencies: CheckDependencies = {}): Promise<MaintenanceDashboardDto> {
  const fetcher = dependencies.fetch || globalThis.fetch.bind(globalThis)
  const checkedAt = (dependencies.now?.() || new Date()).toISOString()
  const inventory = dependencies.inventory || getMaintenanceInventory()
  const jobs = inventory.map(async item => {
    try {
      if (item.id === 'arc-node') return await checkArcRelease(item, fetcher, checkedAt)
      if (item.id === 'arc-rpc') return await checkArcStatus(item, fetcher, checkedAt)
      if (item.id === 'groq-model') return await checkGroqModel(item, fetcher, checkedAt)
      if (item.id === 'groq-deprecations') return await checkGroqDeprecations(item, fetcher, checkedAt)
      if (item.package_name) return await checkPackage(item, fetcher, checkedAt)
      return failure(item, checkedAt)
    } catch { return failure(item, checkedAt) }
  })
  const results = await Promise.all(jobs)
  return { inventory, results, summary: maintenanceSummary(results), checked_at: checkedAt }
}
