import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'

// Try .env.local at the project root — either cwd or one level up from this script
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

// Plain REST client — avoids supabase-js pulling in Realtime (broken on Node 20 without ws polyfill)
async function supaSelect<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams(params).toString()
  const url = `${supabaseUrl}/rest/v1/${path}?${qs}`
  const res = await fetch(url, {
    headers: {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
      // Ask PostgREST for all rows in one shot — default cap is 1000, plenty for our sizes
      'Range-Unit': 'items',
      Range: '0-9999',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supabase REST ${res.status}: ${body.slice(0, 200)}`)
  }
  return await res.json() as T[]
}

type Class = 'json_ok' | 'html_docs' | 'dead'

interface Verdict {
  id: string
  source_table: 'api_listings' | 'crawl_queue'
  name: string | null
  original_url: string
  tested_url: string
  class: Class
  status: number | null
  content_type: string | null
  latency_ms: number | null
  reason: string
}

const CONCURRENCY = 10
const TIMEOUT_MS = 5000

async function classify(url: string): Promise<Omit<Verdict, 'id' | 'source_table' | 'name' | 'original_url' | 'tested_url'>> {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: {
        'User-Agent': 'mahshar-verify-discovery/1.0',
        // Match what a buyer would send through the Mahshar proxy — some servers content-negotiate.
        Accept: 'application/json',
      },
    })
    const latency = Date.now() - start
    const status = res.status
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()

    if (status < 200 || status >= 400) {
      return { class: 'dead', status, content_type: ct || null, latency_ms: latency, reason: `http_${status}` }
    }

    // Read up to ~4KB — enough to fingerprint content, avoids downloading giant bodies
    const reader = res.body?.getReader()
    let sample = ''
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: false })
      let total = 0
      while (total < 4096) {
        const { done, value } = await reader.read()
        if (done) break
        sample += decoder.decode(value, { stream: true })
        total += value.byteLength
      }
      try { await reader.cancel() } catch { /* ignore */ }
    }

    if (ct.includes('application/json')) {
      return { class: 'json_ok', status, content_type: ct, latency_ms: latency, reason: 'content_type_json' }
    }

    // Some APIs serve JSON with wrong Content-Type — try parsing
    const trimmed = sample.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        return { class: 'json_ok', status, content_type: ct || null, latency_ms: latency, reason: 'body_parses_as_json' }
      } catch { /* fall through */ }
    }

    if (ct.includes('text/html') || trimmed.toLowerCase().startsWith('<!doctype') || trimmed.startsWith('<')) {
      return { class: 'html_docs', status, content_type: ct || null, latency_ms: latency, reason: 'html_body' }
    }

    return { class: 'html_docs', status, content_type: ct || null, latency_ms: latency, reason: 'non_json_non_error' }
  } catch (err: unknown) {
    const latency = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    const short = msg.length > 120 ? msg.slice(0, 120) + '…' : msg
    return { class: 'dead', status: null, content_type: null, latency_ms: latency, reason: `fetch_error: ${short}` }
  }
}

async function runPool<T, R>(items: T[], worker: (item: T, idx: number) => Promise<R>, concurrency: number, onProgress?: (done: number, total: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
      done++
      if (onProgress && done % 25 === 0) onProgress(done, items.length)
    }
  })
  await Promise.all(workers)
  if (onProgress) onProgress(done, items.length)
  return results
}

function sampleByClass(verdicts: Verdict[], klass: Class, n: number): Verdict[] {
  return verdicts.filter(v => v.class === klass).slice(0, n)
}

// ── Fetch discovery listings ──────────────────────────────────────────────────
type Row = { id: string; name: string | null; endpoint_url: string }

console.log('Fetching api_listings (source=discovery)…')
let listingRows: Row[]
try {
  listingRows = await supaSelect<Row>('api_listings', {
    select: 'id,name,endpoint_url',
    source: 'eq.discovery',
  })
} catch (err) {
  console.error('Failed to fetch listings:', (err as Error).message)
  process.exit(1)
}
console.log(`  → ${listingRows.length} listings`)

// ── Fetch unsafe_url rejects from crawl_queue ─────────────────────────────────
console.log('Fetching crawl_queue (status=rejected, reject_reason=unsafe_url)…')
let unsafeRows: Row[]
try {
  unsafeRows = await supaSelect<Row>('crawl_queue', {
    select: 'id,name,endpoint_url',
    status: 'eq.rejected',
    reject_reason: 'eq.unsafe_url',
  })
} catch (err) {
  console.error('Failed to fetch unsafe_url rejects:', (err as Error).message)
  process.exit(1)
}
console.log(`  → ${unsafeRows.length} unsafe_url rejects`)

const totalReqs = listingRows.length + unsafeRows.length
console.log(`\nVerifying ${totalReqs} URLs (concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms)…\n`)

const listingVerdicts = await runPool(
  listingRows,
  async row => {
    const c = await classify(row.endpoint_url)
    return {
      id: row.id,
      source_table: 'api_listings' as const,
      name: row.name,
      original_url: row.endpoint_url,
      tested_url: row.endpoint_url,
      ...c,
    }
  },
  CONCURRENCY,
  (done, total) => console.log(`  listings ${done}/${total}`),
)

const unsafeVerdicts = await runPool(
  unsafeRows,
  async row => {
    const swapped = row.endpoint_url.replace(/^http:\/\//i, 'https://')
    const c = await classify(swapped)
    return {
      id: row.id,
      source_table: 'crawl_queue' as const,
      name: row.name,
      original_url: row.endpoint_url,
      tested_url: swapped,
      ...c,
    }
  },
  CONCURRENCY,
  (done, total) => console.log(`  unsafe_url ${done}/${total}`),
)

const all: Verdict[] = [...listingVerdicts, ...unsafeVerdicts]

// ── Report ────────────────────────────────────────────────────────────────────
function classCounts(rows: Verdict[]): Record<Class, number> {
  return {
    json_ok: rows.filter(r => r.class === 'json_ok').length,
    html_docs: rows.filter(r => r.class === 'html_docs').length,
    dead: rows.filter(r => r.class === 'dead').length,
  }
}

const listingCounts = classCounts(listingVerdicts)
const unsafeCounts = classCounts(unsafeVerdicts)

console.log('\n─── Summary ──────────────────────────────────────')
console.log('api_listings (discovery):', listingCounts, `total=${listingVerdicts.length}`)
console.log('crawl_queue (unsafe_url, re-tested with https://):', unsafeCounts, `total=${unsafeVerdicts.length}`)

for (const klass of ['json_ok', 'html_docs', 'dead'] as const) {
  console.log(`\n── Sample: ${klass} (up to 10) ──`)
  const samples = sampleByClass(all, klass, 10)
  for (const s of samples) {
    console.log(`  [${s.source_table}] ${s.name ?? '—'}`)
    console.log(`    url:    ${s.tested_url}${s.tested_url !== s.original_url ? ` (was ${s.original_url})` : ''}`)
    console.log(`    status: ${s.status ?? 'n/a'}  ct: ${s.content_type ?? 'n/a'}  reason: ${s.reason}`)
  }
}

const reportPath = resolve(process.cwd(), 'scripts', 'verify-discovery-report.json')
writeFileSync(reportPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  counts: { api_listings: listingCounts, crawl_queue_unsafe: unsafeCounts },
  verdicts: all,
}, null, 2))

console.log(`\nWrote full report → ${reportPath}`)
console.log('Dry-run only — is_active was not modified.')
