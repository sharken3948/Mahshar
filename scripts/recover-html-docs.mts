import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const envCandidates = [
  resolve(process.cwd(), '.env.local'),
  resolve(scriptDir, '..', '.env.local'),
]
let loadedFrom: string | null = null
let loadedCount = 0
for (const p of envCandidates) {
  if (!existsSync(p)) continue
  const r = config({ path: p, override: true })
  if (r.error) continue
  loadedFrom = p
  loadedCount = Object.keys(r.parsed ?? {}).length
  break
}
if (!loadedFrom) {
  console.error('Could not find .env.local at:', envCandidates)
  process.exit(1)
}
console.log(`[env] loaded ${loadedCount} vars from ${loadedFrom}`)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local')
  process.exit(1)
}

const reportPath = resolve(scriptDir, 'verify-discovery-report.json')
if (!existsSync(reportPath)) {
  console.error(`Report not found: ${reportPath} — run verify-discovery.mts first.`)
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

const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as { verdicts: Verdict[] }
const targets = report.verdicts.filter(
  v => v.source_table === 'api_listings' && v.class === 'html_docs',
)

const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 8
const TIMEOUT_MS = 5000
const MAX_CANDIDATES_PER_ROW = 8

console.log(`\n${targets.length} html_docs rows to attempt recovery on. dry-run=${DRY_RUN}\n`)

// ── Candidate generation ─────────────────────────────────────────────────────
// Reject rescues that "succeed" only because they hit GitHub's own API surface —
// e.g. a GitHub-repo landing page's api.-subdomain guess resolves to api.github.com.
const BLACKLISTED_HOSTS = new Set([
  'github.com', 'www.github.com', 'api.github.com',
  'raw.githubusercontent.com', 'gist.github.com',
])

function isBlacklistedHost(host: string): boolean {
  return BLACKLISTED_HOSTS.has(host.toLowerCase())
}

function isGithubOriginal(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase()
    return h === 'github.com' || h === 'www.github.com'
  } catch { return false }
}

// A URL "looks like an API route" if it's on an api.<host> subdomain OR its path contains an /api/ segment.
// A bare .json extension is NOT sufficient — that catches /assets/foo.json, /media/bar.json, etc.
function looksLikeApiUrl(u: URL): boolean {
  const host = u.hostname.toLowerCase()
  const path = u.pathname.toLowerCase()
  const isApiHost = host.startsWith('api.')
  const isApiPath = path.split('/').includes('api')
  return isApiHost || isApiPath
}

function originAndPath(u: URL): { origin: string; host: string } {
  return { origin: `${u.protocol}//${u.host}`, host: u.host }
}

function generateStaticCandidates(rawUrl: string): string[] {
  const out: string[] = []
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return out
  }

  // GitHub repos: static api. and /api guesses land on GitHub's own API, not the project's.
  // Rely entirely on scraped candidates from the repo README/page.
  if (isGithubOriginal(rawUrl)) return out

  const { origin, host } = originAndPath(u)

  // api. subdomain: swap www.foo.com → api.foo.com, or foo.com → api.foo.com
  const parts = host.split('.')
  if (!host.startsWith('api.')) {
    const bare = parts[0] === 'www' ? parts.slice(1).join('.') : host
    out.push(`${u.protocol}//api.${bare}`)
    out.push(`${u.protocol}//api.${bare}/`)
  }

  // Path variants on original origin
  out.push(`${origin}/api`)
  out.push(`${origin}/api/`)
  out.push(`${origin}/api/v1`)
  out.push(`${origin}/api/v1/`)

  return Array.from(new Set(out)).filter(c => {
    try { return !isBlacklistedHost(new URL(c).hostname) } catch { return false }
  })
}

async function scrapeLandingCandidates(rawUrl: string): Promise<string[]> {
  let html = ''
  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'User-Agent': 'mahshar-recover/1.0' },
    })
    if (!res.ok) return []
    // Cap the read to ~64KB — big enough for most homepages
    const reader = res.body?.getReader()
    if (!reader) return []
    const dec = new TextDecoder('utf-8', { fatal: false })
    let total = 0
    while (total < 65536) {
      const { done, value } = await reader.read()
      if (done) break
      html += dec.decode(value, { stream: true })
      total += value.byteLength
    }
    try { await reader.cancel() } catch { /* ignore */ }
  } catch {
    return []
  }

  const found = new Set<string>()
  const base = new URL(rawUrl)

  // Any absolute URL that looks like an API endpoint
  for (const m of html.matchAll(/https?:\/\/[^\s<>"'`)]+/g)) {
    try {
      // Decode HTML entities the scrape swept up (&amp; &quot; &#39; etc), then
      // strip trailing punctuation/quotes that got attached to the URL match.
      const clean = decodeHtmlEntities(m[0]).replace(/[),.;:'"`]+$/, '')
      const u = new URL(clean)
      if (isBlacklistedHost(u.hostname)) continue
      if (!looksLikeApiUrl(u)) continue
      found.add(clean)
    } catch {
      // ignore
    }
  }

  // Also try href="/api/…" style relative links
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeHtmlEntities(m[1] ?? '').replace(/[),.;:'"`]+$/, '')
    if (!href) continue
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue
    try {
      const abs = new URL(href, base)
      if (isBlacklistedHost(abs.hostname)) continue
      if (!looksLikeApiUrl(abs)) continue
      found.add(abs.toString())
    } catch {
      // ignore
    }
  }

  return Array.from(found)
}

// HTML entity decoder — covers the common ones scraped pages contain in query strings.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
}

// ── JSON test (5s timeout) ───────────────────────────────────────────────────
interface CandidateResult { url: string; ok: boolean; status: number | null; content_type: string | null; latency_ms: number; reason: string }

async function testJson(url: string): Promise<CandidateResult> {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'User-Agent': 'mahshar-recover/1.0', Accept: 'application/json' },
    })
    const latency = Date.now() - start
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (res.status < 200 || res.status >= 400) {
      return { url, ok: false, status: res.status, content_type: ct || null, latency_ms: latency, reason: `http_${res.status}` }
    }

    if (ct.includes('application/json')) {
      return { url, ok: true, status: res.status, content_type: ct, latency_ms: latency, reason: 'content_type_json' }
    }

    // Try parsing first ~4KB
    const reader = res.body?.getReader()
    let sample = ''
    if (reader) {
      const dec = new TextDecoder('utf-8', { fatal: false })
      let total = 0
      while (total < 4096) {
        const { done, value } = await reader.read()
        if (done) break
        sample += dec.decode(value, { stream: true })
        total += value.byteLength
      }
      try { await reader.cancel() } catch { /* ignore */ }
    }
    const trimmed = sample.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        return { url, ok: true, status: res.status, content_type: ct || null, latency_ms: latency, reason: 'body_parses_as_json' }
      } catch { /* fallthrough */ }
    }
    return { url, ok: false, status: res.status, content_type: ct || null, latency_ms: latency, reason: 'not_json' }
  } catch (err) {
    const latency = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    return { url, ok: false, status: null, content_type: null, latency_ms: latency, reason: `fetch_error: ${msg.slice(0, 100)}` }
  }
}

// ── Per-row recovery ─────────────────────────────────────────────────────────
interface Recovery { id: string; name: string | null; original_url: string; rescued_url: string | null; tried: CandidateResult[]; outcome: 'rescued' | 'exhausted' }

async function recoverRow(v: Verdict): Promise<Recovery> {
  const staticCands = generateStaticCandidates(v.original_url)
  const scraped = await scrapeLandingCandidates(v.original_url)
  // Static first (fast, no HTML fetch cost), then scraped
  const all = Array.from(new Set([...staticCands, ...scraped])).slice(0, MAX_CANDIDATES_PER_ROW)

  const tried: CandidateResult[] = []
  for (const c of all) {
    // Rescuing to the same URL is a no-op — verify uses different headers and would still classify it html_docs.
    if (c === v.original_url) continue
    const r = await testJson(c)
    tried.push(r)
    if (r.ok) {
      return { id: v.id, name: v.name, original_url: v.original_url, rescued_url: c, tried, outcome: 'rescued' }
    }
  }
  return { id: v.id, name: v.name, original_url: v.original_url, rescued_url: null, tried, outcome: 'exhausted' }
}

async function runPool<T, R>(items: T[], worker: (t: T) => Promise<R>, concurrency: number, onProgress?: (done: number, total: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i])
      done++
      if (onProgress && done % 25 === 0) onProgress(done, items.length)
    }
  })
  await Promise.all(workers)
  if (onProgress) onProgress(done, items.length)
  return results
}

const recoveries = await runPool(
  targets,
  recoverRow,
  CONCURRENCY,
  (done, total) => console.log(`  progress ${done}/${total}`),
)

const rescued = recoveries.filter(r => r.outcome === 'rescued')
const exhausted = recoveries.filter(r => r.outcome === 'exhausted')

console.log(`\n─── Recovery Summary ─────────────────────────────`)
console.log(`Rescued:   ${rescued.length}`)
console.log(`Exhausted: ${exhausted.length}`)

console.log(`\n── Sample rescued (up to 10) ──`)
for (const r of rescued.slice(0, 10)) {
  console.log(`  ${r.name ?? '—'}`)
  console.log(`    was:  ${r.original_url}`)
  console.log(`    now:  ${r.rescued_url}`)
}

// ── Write DB updates for rescued rows ────────────────────────────────────────
if (!DRY_RUN && rescued.length > 0) {
  console.log(`\nUpdating ${rescued.length} api_listings.endpoint_url values…`)
  let updated = 0
  let failed = 0
  for (const r of rescued) {
    const url = `${supabaseUrl}/rest/v1/api_listings?id=eq.${encodeURIComponent(r.id)}`
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ endpoint_url: r.rescued_url }),
      })
      if (!res.ok) {
        failed++
        console.log(`  ✗ ${r.name ?? r.id}: HTTP ${res.status}`)
      } else {
        updated++
      }
    } catch (err) {
      failed++
      console.log(`  ✗ ${r.name ?? r.id}: ${(err as Error).message}`)
    }
  }
  console.log(`  → updated ${updated}, failed ${failed}`)
} else if (DRY_RUN) {
  console.log('\n--dry-run flag set — no DB updates written.')
}

// ── Persist full recovery report ─────────────────────────────────────────────
const outPath = resolve(scriptDir, 'recovery-report.json')
writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  counts: { rescued: rescued.length, exhausted: exhausted.length, total: recoveries.length },
  recoveries,
}, null, 2))

console.log(`\nWrote full recovery report → ${outPath}`)
console.log('is_active NOT touched — re-run verify-discovery.mts then activate-verified.mts to activate rescued rows.')
