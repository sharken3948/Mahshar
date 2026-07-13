import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const candidates = [
  resolve(process.cwd(), '.env.local'),
  resolve(scriptDir, '..', '.env.local'),
]
let loadedFrom: string | null = null
let loadedCount = 0
for (const p of candidates) {
  if (!existsSync(p)) continue
  const result = config({ path: p, override: true })
  if (result.error) continue
  loadedFrom = p
  loadedCount = Object.keys(result.parsed ?? {}).length
  break
}
if (!loadedFrom) {
  console.error('Could not find .env.local at any of:', candidates)
  process.exit(1)
}
console.log(`[env] loaded ${loadedCount} vars from ${loadedFrom}`)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local')
  process.exit(1)
}

// ── Load verify report ────────────────────────────────────────────────────────
const reportPath = resolve(scriptDir, 'verify-discovery-report.json')
if (!existsSync(reportPath)) {
  console.error(`Report not found: ${reportPath}`)
  console.error('Run scripts/verify-discovery.mts first.')
  process.exit(1)
}

interface Verdict {
  id: string
  source_table: 'api_listings' | 'crawl_queue'
  name: string | null
  original_url: string
  tested_url: string
  class: 'json_ok' | 'html_docs' | 'dead'
  status: number | null
  content_type: string | null
  latency_ms: number | null
  reason: string
}

// GitHub content-negotiates on Accept: application/json, so verify may misclassify
// a github.com endpoint_url as json_ok even though it's just serving GitHub's own API,
// not the listed API. Filter those out before flipping is_active.
const BLACKLISTED_HOSTS = new Set([
  'github.com', 'www.github.com', 'api.github.com',
  'raw.githubusercontent.com', 'gist.github.com',
])
function isBlacklistedHost(host: string): boolean {
  return BLACKLISTED_HOSTS.has(host.toLowerCase())
}
function endpointHost(u: string): string | null {
  try { return new URL(u).hostname } catch { return null }
}

// Second layer — manually-identified false positives from prior review:
//   • http:// endpoints (cleartext — reject on principle for paid buyers)
//   • Postman doc hosts (documenter pages return JSON but are not runnable APIs)
//   • Named rows whose rescued URL points at an unrelated third-party service
const QUALITY_EXCLUDED_HOSTS = new Set([
  'documenter.getpostman.com', 'documenter.gw.postman.com',
])
const QUALITY_EXCLUDED_NAMES = new Set([
  'Coronavirus', 'Onyx Bazaar',
])
function qualityReason(v: Verdict): string | null {
  if (v.tested_url.toLowerCase().startsWith('http://')) return 'http_only'
  const host = endpointHost(v.tested_url)?.toLowerCase() ?? ''
  if (QUALITY_EXCLUDED_HOSTS.has(host)) return `postman_doc_host:${host}`
  if (v.name && QUALITY_EXCLUDED_NAMES.has(v.name)) return `manual:${v.name}`
  return null
}

const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as { verdicts: Verdict[] }
const jsonOk = report.verdicts.filter(
  v => v.source_table === 'api_listings' && v.class === 'json_ok',
)

const activatable: Verdict[] = []
const excludedGithub: Verdict[] = []
const excludedQuality: Array<{ v: Verdict; reason: string }> = []

for (const v of jsonOk) {
  const host = endpointHost(v.tested_url)
  if (host && isBlacklistedHost(host)) {
    excludedGithub.push(v)
    continue
  }
  const qr = qualityReason(v)
  if (qr) {
    excludedQuality.push({ v, reason: qr })
    continue
  }
  activatable.push(v)
}

console.log(`Found ${jsonOk.length} json_ok rows in api_listings.`)
console.log(`  → ${excludedGithub.length} excluded by GitHub host blacklist`)
console.log(`  → ${excludedQuality.length} excluded (manual/quality)`)
console.log(`  → ${activatable.length} eligible to activate\n`)

if (excludedGithub.length > 0) {
  console.log('Excluded rows (GitHub content-negotiation false positives):')
  for (const v of excludedGithub) {
    console.log(`  ${v.name ?? '—'}  →  ${v.tested_url}`)
  }
  console.log('')
}

if (excludedQuality.length > 0) {
  console.log('Excluded rows (manual/quality):')
  for (const { v, reason } of excludedQuality) {
    console.log(`  ${v.name ?? '—'}  →  ${v.tested_url}   [${reason}]`)
  }
  console.log('')
}

console.log('Rows to activate:')
for (const v of activatable) {
  console.log(`  ${v.name ?? '—'}  →  ${v.tested_url}`)
}

const DRY_RUN = process.argv.includes('--dry-run')
if (DRY_RUN) {
  console.log('\n--dry-run flag set — no updates written.')
  process.exit(0)
}

// ── Flip is_active=true on those rows ─────────────────────────────────────────
console.log('\nActivating…')
let ok = 0
let failed = 0
const errors: Array<{ id: string; name: string | null; err: string }> = []

for (const v of activatable) {
  const url = `${supabaseUrl}/rest/v1/api_listings?id=eq.${encodeURIComponent(v.id)}`
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ is_active: true }),
    })
    if (!res.ok) {
      const body = await res.text()
      failed++
      errors.push({ id: v.id, name: v.name, err: `HTTP ${res.status}: ${body.slice(0, 120)}` })
      continue
    }
    ok++
    console.log(`  ✓ ${v.name ?? v.id}`)
  } catch (err) {
    failed++
    errors.push({ id: v.id, name: v.name, err: (err as Error).message })
  }
}

console.log(`\nActivated: ${ok}   Failed: ${failed}`)
if (errors.length) {
  console.log('\nErrors:')
  for (const e of errors) console.log(`  ${e.name ?? e.id}: ${e.err}`)
}
