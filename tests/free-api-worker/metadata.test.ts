import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { OWNER, digest } from '../../src/lib/free-api-worker/model'
import { groq } from '../../src/lib/groq'
import { POST as publish } from '../../src/app/api/admin/free-api-worker/list/route'
import { POST as analyze } from '../../src/app/api/ai/score/route'

const quote = (v: unknown) => "'" + (typeof v === 'string' ? v : JSON.stringify(v)).replace(/'/g, "''") + "'"
reset(); process.env.ADMIN_WALLETS = OWNER; process.env.GROQ_API_KEY = 'offline-fixture'
const headers = sessionHeaders({ ...alice, address: OWNER })
const request = (path: string, body: unknown, auth = headers) => new NextRequest(origin + path,
  { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const good = (category = 'Data', score = 8) => ({ score, suggested_price: 0.999, approved: true,
  critical_issues: [], warnings: [], positives: ['Functional JSON'], summary: 'Useful API.', suggestions: { category } })
let raw: unknown = good(), fail = false, calls = 0, beforeCompletion = () => {}
let lastPrompt = ''
const completion = groq.chat.completions as unknown as { create: (params: any) => Promise<any> }
completion.create = async params => {
  calls++; lastPrompt = params.messages[1].content
  assert(lastPrompt.includes('Real Endpoint Test:'))
  beforeCompletion()
  if (fail) throw new Error('Mock timeout; no network')
  return { choices: [{ message: { content: typeof raw === 'string' ? raw : JSON.stringify(raw) } }] }
}
const fixture = (name: string) => {
  const id = digest('metadata:' + name), endpoint = `https://${name.toLowerCase().replace(/\W/g,'')}.example.org/data`
  const lead = { id, providerId: new URL(endpoint).hostname, name, description: 'Synthetic API for metadata integration', docs: endpoint, sources: [], auth: 'none' }
  const result = { technical: 'PASSED', freeAccess: 'VERIFIED', permission: 'UNKNOWN', termsChecked: true,
    endpoint, docs: endpoint, lastSuccess: '2026-10-28T00:00:00Z', reason: 'Fixture', retryAt: null,
    evidence: [], tests: [{ url: endpoint, status: 200, reason: 'Fixture response', sha256: digest(name) }] }
  sql(`INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES (${quote(id)},${quote(lead.providerId)},${quote(name)},${quote(endpoint)},${quote(lead)}::jsonb,${quote(result)}::jsonb,now())`)
  return { id, endpoint }
}
const row = (id: string) => JSON.parse(sql(`SELECT row_to_json(t) FROM public.api_listings t WHERE free_worker_candidate_id=${quote(id)}`))
async function bulk(ids: string[], mode: 'FREE' | 'PAID' = 'PAID') {
  const response = await publish(request('/api/admin/free-api-worker/list', { ids, confirmed: true, mode, price: mode === 'FREE' ? 0 : 0.001,
    ...(mode === 'PAID' ? { owner_rights_confirmed: true } : {}) }))
  assert.equal(response.status, 200)
  return response.json()
}
let cases = 0
const pass = (name: string) => { cases++; console.log('PASS', name) }

async function main() {
const a = fixture('Categorized')
let result = await bulk([a.id]); assert.equal(result.published, 1, JSON.stringify(result))
assert.equal(row(a.id).category, 'Data'); assert.equal(Number(row(a.id).score), 8)
assert.equal(Number(row(a.id).price_per_call), 0.001, 'Model price must never change the selected price')
assert.equal(row(a.id).seller_wallet, OWNER); assert.equal(row(a.id).endpoint_url, a.endpoint)
assert.equal(calls, 1); assert.equal(outbound.calls.get(a.endpoint), 1)
assert.match(lastPrompt, /Actual Response Body/); assert.match(lastPrompt, /Isolated fixture/)
assert.doesNotMatch(lastPrompt, /Category\nOther/)
pass('real scoring function and Seller route persist Groq category and score before paid activation')
const saved = row(a.id)
result = await bulk([a.id]); assert.equal(result.results[0].listingId, saved.id)
assert.equal(calls, 1); assert.equal(outbound.calls.get(a.endpoint), 1)
pass('completed publication retry preserves ID without a second Groq/provider call')

for (const [name, value, throws] of [
  ['timeout', good(), true], ['malformed', 'not json', false],
  ['missing score', { ...good(), score: undefined }, false], ['string score', { ...good(), score: '8' }, false],
  ['missing category', { ...good(), suggestions: {} }, false],
  ['invalid category', good('Invented Category'), false],
] as const) {
  const f = fixture(name); raw = value; fail = throws
  result = await bulk([f.id]); assert.equal(result.published, 0)
  const draft = row(f.id); assert.equal(draft.is_active, false); assert.equal(draft.score, null)
  assert.equal(draft.category, 'Other'); assert.ok(result.results[0].error)
  assert.equal(sql(`SELECT published_at IS NULL FROM public.free_worker_apis WHERE id=${quote(f.id)}`), 't')
  raw = good('Utility', 7); fail = false
  result = await bulk([f.id]); assert.equal(result.published, 1, JSON.stringify(result))
  assert.equal(result.results[0].listingId, draft.id); assert.equal(row(f.id).category, 'Utility'); assert.equal(Number(row(f.id).score), 7)
  pass(name + ': no fabricated metadata or publication; retry reuses draft and persists real result')
}
raw = good('Other', 6)
const other = fixture('Legitimate Other'); result = await bulk([other.id])
assert.equal(result.published, 1); assert.equal(Number(row(other.id).score), 6)
pass('Other is accepted only as an actual validated model recommendation')

raw = good(); const missingKey = fixture('Missing Key'); delete process.env.GROQ_API_KEY
const beforeMissing = calls; result = await bulk([missingKey.id]); assert.equal(result.published, 0); assert.equal(calls, beforeMissing)
assert.equal(row(missingKey.id).score, null); process.env.GROQ_API_KEY = 'offline-fixture'
pass('missing Groq configuration leaves an unpublished unscored draft')

const dbFailure = fixture('Storage Failure')
sql(`CREATE FUNCTION public.metadata_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='Storage Failure' AND NEW.score IS NOT NULL THEN RAISE EXCEPTION 'Fixture write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER metadata_write_failure BEFORE UPDATE ON public.api_listings FOR EACH ROW EXECUTE FUNCTION public.metadata_write_failure()`)
result = await bulk([dbFailure.id]); assert.equal(result.published, 0)
assert.equal(row(dbFailure.id).score, null); assert.equal(row(dbFailure.id).category, 'Other')
sql('DROP TRIGGER metadata_write_failure ON public.api_listings; DROP FUNCTION public.metadata_write_failure()')
pass('database failure rolls back both category and score and blocks activation')

const race = fixture('Concurrent Edit')
beforeCompletion = () => sql(`UPDATE public.api_listings SET category='Finance' WHERE free_worker_candidate_id=${quote(race.id)}`)
result = await bulk([race.id]); assert.equal(result.published, 0); assert.equal(row(race.id).category, 'Finance'); assert.equal(row(race.id).score, null)
beforeCompletion = () => {}
pass('concurrent category edit prevents stale metadata persistence and activation')

const reject = fixture('Rejected Review'); raw = { ...good(), approved: false, critical_issues: ['Unsafe fixture'] }
result = await bulk([reject.id]); assert.equal(result.published, 0); assert.equal(row(reject.id).is_active, false)
pass('rejected Groq review is not published')
raw = good(); const healthy = fixture('Partial Success'); fail = true
beforeCompletion = () => { fail = !lastPrompt.includes('Partial Success') }
result = await bulk([reject.id, healthy.id]); assert.equal(result.published, 1); assert.equal(row(healthy.id).is_active, true)
beforeCompletion = () => {}; fail = false
pass('per-listing Groq failure does not prevent the rest of a selected batch')

// New future-publication fixtures, independent of the five existing correction records.
sql(`CREATE TABLE public.metadata_expected(candidate_id text PRIMARY KEY, category text, score integer);
  CREATE FUNCTION public.metadata_before_publication() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.is_active AND NOT OLD.is_active AND EXISTS (SELECT 1 FROM public.metadata_expected WHERE candidate_id=NEW.free_worker_candidate_id) THEN
      IF NOT EXISTS (SELECT 1 FROM public.metadata_expected WHERE candidate_id=NEW.free_worker_candidate_id
        AND category=NEW.category AND score=NEW.score) THEN
        RAISE EXCEPTION 'Activation before expected Groq metadata was persisted';
      END IF;
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER metadata_before_publication BEFORE UPDATE ON public.api_listings FOR EACH ROW EXECUTE FUNCTION public.metadata_before_publication()`)
for (const mode of ['FREE', 'PAID'] as const) {
  const batch = [['Data', 9], ['Weather', 5], ['Utility', 7], ['Media', 6]].map(([category, score], index) => ({
    ...fixture(`New ${mode} Batch ${index}`), category: String(category), score: Number(score),
  }))
  for (const item of batch) sql(`INSERT INTO public.metadata_expected VALUES (${quote(item.id)},${quote(item.category)},${item.score})`)
  const evidence = sql(`SELECT md5(jsonb_agg(jsonb_build_object('id',id,'lead',lead,'result',result) ORDER BY id)::text) FROM public.free_worker_apis`)
  const reviewed: string[] = []
  let failLast = true
  beforeCompletion = () => {
    const item = batch.find(item => lastPrompt.includes(item.endpoint))
    assert.ok(item, 'Each selected API supplies its own real endpoint result to Seller/Groq')
    const draft = row(item.id)
    assert.equal(draft.is_active, false, 'Analysis must precede publication')
    assert.equal(draft.score, null)
    reviewed.push(item.id)
    raw = failLast && item === batch[3] ? { ...good(), suggestions: {} } : good(item.category, item.score)
  }
  result = await bulk(batch.map(item => item.id), mode)
  assert.equal(result.published, 3, JSON.stringify(result))
  assert.deepEqual([...new Set(reviewed)].sort(), batch.map(item => item.id).sort())
  for (const item of batch.slice(0, 3)) {
    const listing = row(item.id)
    assert.equal(listing.is_active, true); assert.equal(listing.category, item.category); assert.equal(Number(listing.score), item.score)
    assert.equal(Number(listing.price_per_call), mode === 'FREE' ? 0 : 0.001)
    assert.equal(listing.seller_wallet, OWNER); assert.equal(listing.endpoint_url, item.endpoint)
    if (mode === 'PAID') {
      assert.equal(listing.owner_rights_confirmation.confirmed, true)
      assert.equal(listing.owner_rights_confirmation.candidateId, item.id)
    } else assert.equal(listing.owner_rights_confirmation, null)
  }
  const failed = row(batch[3].id)
  assert.equal(failed.is_active, false); assert.equal(failed.score, null)
  pass(`${mode}: four newly selected APIs each analyzed; three distinct categories/scores persisted before activation, failed analysis stays unpublished`)
  const beforeRetry: number = calls
  failLast = false; reviewed.length = 0
  result = await bulk(batch.map(item => item.id), mode)
  assert.equal(result.published, 4, JSON.stringify(result)); assert.equal(calls, beforeRetry + 1)
  assert.deepEqual(reviewed, [batch[3].id]); assert.equal(row(batch[3].id).id, failed.id)
  assert.equal(row(batch[3].id).category, 'Media'); assert.equal(Number(row(batch[3].id).score), 6)
  assert.equal(sql(`SELECT md5(jsonb_agg(jsonb_build_object('id',id,'lead',lead,'result',result) ORDER BY id)::text) FROM public.free_worker_apis`), evidence)
  pass(`${mode}: batch retry analyzes only failed draft; existing IDs, owner rights and discovery evidence preserved`)
}
beforeCompletion = () => {}; raw = good()
sql('DROP TRIGGER metadata_before_publication ON public.api_listings; DROP FUNCTION public.metadata_before_publication(); DROP TABLE public.metadata_expected')

const unauthorized = await analyze(request('/api/ai/score', { api_id: saved.id, require_category: true }, sessionHeaders(bob)))
assert.equal(unauthorized.status, 403)
const badMode = await analyze(request('/api/ai/score', { api_id: saved.id, require_category: true, draft: true }))
assert.equal(badMode.status, 400)
assert.equal(outbound.paidCalls, 0); assert.equal(sql('SELECT count(*) FROM public.purchases'), '0')
assert.equal(sql('SELECT count(*) FROM public.api_calls'), '0')
pass('ownership and persistence-mode guards; no calls, purchases or financial operations')
console.log(`PASS ${cases} focused metadata integration cases`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
