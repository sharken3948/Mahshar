import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Groq, { APIError } from 'groq-sdk'
import { NextRequest } from 'next/server'
import { alice, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { OWNER, digest } from '../../src/lib/free-api-worker/model'
import { groq, scoreApi } from '../../src/lib/groq'
import { GROQ_MODEL } from '../../src/lib/groq-neutral'
import { GroqAnalysisError } from '../../src/lib/groq-analysis-error'
import { runBulkAttempt } from '../../src/lib/free-api-worker/bulk-attempt'
import { POST as create } from '../../src/app/api/admin/free-api-worker/batches/route'
import { POST as advance, GET as status } from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import { POST as analyze } from '../../src/app/api/ai/score/route'
import { bulkCounts, type BulkProgress } from '../../src/lib/free-api-worker/bulk-progress'

reset(); process.env.ADMIN_WALLETS = OWNER; process.env.GROQ_API_KEY = 'offline-fixture'
delete process.env.MAHSHAR_GROQ_BUDGET_ENABLED
const headers = sessionHeaders({ ...alice, address: OWNER })
const quote = (value: unknown) => "'" + (typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''") + "'"
const req = (path: string, body?: unknown) => new NextRequest(origin + path, { method: body ? 'POST' : 'GET', headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const leak = 'SENSITIVE_PAYLOAD_DO_NOT_LOG'
const cases = [
  [401, 'authentication', 'authentication_error'], [403, 'permission', 'permission_error'],
  // Durable Bulk 429 is covered by groq-pause.test.ts; it is now pending, not failed.
  [500, 'upstream', 'server_error'], [502, 'upstream', 'api_error'],
  [503, 'upstream', 'server_error'], [504, 'upstream', 'server_error'],
  [400, 'request', 'invalid_request_error'], [404, 'request', 'invalid_request_error'],
  ['network', 'network', null], ['timeout', 'timeout', null],
] as const
let scenario: number | string = 401, providerType: string | null = 'authentication_error', calls = 0
const logs: unknown[][] = []
const originalWarn = console.warn
console.warn = (...args: unknown[]) => { logs.push(args) }
const review = { score: 8, approved: true, suggested_price: .001, critical_issues: [], warnings: [], positives: ['Fixture'], summary: 'Fixture', suggestions: { category: 'Data' } }
// Real installed SDK, with only its transport mocked. Global network is forbidden by the test loader.
const provider = new Groq({ apiKey: 'offline-fixture', timeout: groq.timeout, maxRetries: groq.maxRetries, fetch: async (_url, init) => {
  calls++
  const payload = JSON.parse(init!.body as string)
  assert.equal(payload.model, GROQ_MODEL); assert.equal(payload.temperature, .3)
  assert.equal(payload.response_format.type, 'json_object')
  if (scenario === 'network') throw new TypeError(leak)
  if (scenario === 'timeout') throw new DOMException(leak, 'AbortError')
  if (scenario === 'bulk-abort') return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException(leak, 'AbortError')), { once: true }))
  if (scenario === 'success') return Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] })
  return Response.json({ error: { message: leak, type: providerType, code: scenario === 429 ? 'rate_limit_exceeded' : 'json_validate_failed', failed_generation: leak } }, {
    status: Number(scenario), headers: { 'x-request-id': 'req_0123456789abcdef', 'retry-after': '17', 'authorization': 'Bearer ' + leak, 'x-private': leak },
  })
} })
groq.chat.completions.create = provider.chat.completions.create.bind(provider.chat.completions)
function candidate(index: number) {
  const name = 'groqerror' + index, id = digest(name), endpoint = `https://${name}.example.org/data`
  const lead = { id, name, providerId: name + '.example.org', description: 'Offline visibility fixture', docs: endpoint, sources: [], auth: 'none' }
  const result = { technical: 'PASSED', freeAccess: 'VERIFIED', permission: 'UNKNOWN', termsChecked: true, endpoint, docs: endpoint, lastSuccess: '2026-10-28T00:00:00Z', reason: 'Fixture', retryAt: null, evidence: [], tests: [{ url: endpoint, status: 200, reason: 'Fixture', sha256: digest(name) }] }
  sql(`INSERT INTO free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES(${quote(id)},${quote(lead.providerId)},${quote(name)},${quote(endpoint)},${quote(lead)}::jsonb,${quote(result)}::jsonb,now())`)
  return id
}
async function main() {
  assert.equal(groq.timeout, 8000); assert.equal(groq.maxRetries, 0)
  const ids = cases.map((_, index) => candidate(index))
  const created = await create(req('/api/admin/free-api-worker/batches', { id: randomUUID(), ids, mode: 'FREE', price: 0, confirmed: true }))
  assert.equal(created.status, 201, await created.clone().text())
  let batch = (await created.json()).batch as BulkProgress
  for (const [index, entry] of cases.entries()) {
    ;[scenario, , providerType] = entry
    const before = calls, beforeLogs = logs.length
    const response = await advance(req('/api/admin/free-api-worker/batches/' + batch.id, { action: 'next' }), { params: Promise.resolve({ id: batch.id }) })
    assert.equal(response.status, 200, await response.clone().text())
    batch = (await response.json()).batch
    assert.equal(calls, before + 1, 'No SDK or batch retry added, including 429')
    assert.equal(logs.length, beforeLogs + 1)
    const [event, details] = logs.at(-1)! as [string, GroqAnalysisError['details']]
    assert.equal(event, 'groq_analysis_failed'); assert.equal(details.error_type, entry[1])
    assert.equal(details.status, typeof scenario === 'number' ? scenario : null)
    assert.equal(details.provider_error_type, providerType)
    assert.equal(details.request_id, typeof scenario === 'number' ? 'req_0123456789abcdef' : null)
    assert.equal(details.retry_after_seconds, typeof scenario === 'number' ? 17 : null)
    const item = batch.items[index]
    assert.equal(item.status, 'failed'); assert.equal(item.attempts, 1); assert.equal(item.lease_until, null)
    assert.match(item.last_error!, typeof scenario === 'number' ? new RegExp('Groq HTTP ' + scenario) : scenario === 'timeout' ? /timed out/ : /connection failed/)
    assert.doesNotMatch(JSON.stringify({ logs, batch }), new RegExp(leak))
    const saved = JSON.parse(sql(`SELECT to_jsonb(a) FROM api_listings a WHERE free_worker_candidate_id=${quote(ids[index])}`))
    assert.equal(saved.is_active, false); assert.equal(saved.score, null); assert.equal(saved.free_worker_review, null)
    console.log('PASS mocked SDK response → Seller analysis → durable Bulk failure:', scenario)
  }
  assert.deepEqual(bulkCounts(batch), { published: 0, failed: cases.length, processing: 0, remaining: 0 })
  const reread = await status(req('/api/admin/free-api-worker/batches/' + batch.id), { params: Promise.resolve({ id: batch.id }) })
  assert.deepEqual((await reread.json()).batch.items, batch.items)
  console.log('PASS next candidate continues, reload retains short errors, no automatic retries or publication')

  scenario = 403; providerType = 'permission_error'
  const seller = await analyze(req('/api/ai/score', { api_id: batch.items[0].listing_id }))
  const result = await seller.json()
  assert.equal(result.ai_available, false); assert.equal(result.inconclusive, true)
  assert.equal(result.analysis_failure_reason, undefined, 'Ordinary Seller response contract remains unchanged')
  assert.equal((logs.at(-1)![1] as GroqAnalysisError['details']).error_type, 'permission')
  assert.equal((logs.at(-1)![1] as GroqAnalysisError['details']).status, 403)
  assert.equal(result.retry_after_seconds, undefined, 'Provider Retry-After must not enter the automatic retry path')
  assert.equal(result.score, null)
  console.log('PASS ordinary Seller logs the same safe details without altering its response or retry behavior')

  const malicious = new GroqAnalysisError(APIError.generate(400, { error: { message: leak, type: leak, code: 'gsk_' + leak } }, undefined, new Headers({ 'x-request-id': 'gsk_' + leak, 'retry-after': leak })))
  assert.equal(malicious.details.provider_error_type, null); assert.equal(malicious.details.provider_error_code, null)
  assert.equal(malicious.details.request_id, null); assert.equal(malicious.details.retry_after_seconds, null)
  assert.doesNotMatch(JSON.stringify(malicious) + malicious.message, new RegExp(leak))
  const retryDate = new Date(Date.now() + 60000).toUTCString()
  const dated = new GroqAnalysisError(APIError.generate(429, { type: 'requests' }, undefined, new Headers({ 'retry-after': retryDate, 'x-request-id': randomUUID() })))
  assert(dated.details.retry_after_seconds! >= 59 && dated.details.retry_after_seconds! <= 60)
  assert(dated.details.request_id); assert.equal(dated.details.provider_error_type, 'requests')
  assert.equal(new GroqAnalysisError(new Error(leak)).details.error_type, 'unknown')
  console.log('PASS hostile messages, credentials, labels and headers are discarded; HTTP-date Retry-After supported')

  scenario = 'bulk-abort'; const beforeAbort = logs.length
  await assert.rejects(runBulkAttempt({ batch: randomUUID(), candidate: ids[0], token: randomUUID(), deadline: Date.now() + 50 }, () => scoreApi({ name: 'Fixture', description: 'Fixture', category: '', endpoint_url: 'https://fixture.example.org', method: 'GET', auth_type: 'public' })), /TIMEOUT:/)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(logs.length, beforeAbort, 'Application deadline must not be reported as provider failure')
  scenario = 'success'
  const successful = await scoreApi({ name: 'Fixture', description: 'Fixture', category: '', endpoint_url: 'https://fixture.example.org', method: 'GET', auth_type: 'public' })
  assert.equal(successful.score, 8); assert.equal(successful.suggestions.category, 'Data')
  assert.equal(groq.timeout, 8000); assert.equal(groq.maxRetries, 0)
  assert.equal(outbound.paidCalls, 0); assert.equal(sql('SELECT count(*) FROM purchases'), '0')
  assert.equal(sql('SELECT count(*) FROM api_calls'), '0'); assert.equal(sql('SELECT count(*) FROM api_listings WHERE is_active'), '0')
  console.log('PASS Bulk cancellation distinguished; scoring/model/8-second SDK timeout intact; no publication or financial actions')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { console.warn = originalWarn })
