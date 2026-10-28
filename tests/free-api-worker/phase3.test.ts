import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { databaseStore } from '../../src/lib/free-api-worker/runtime'
import { OWNER, digest, usableCandidates, type Candidate } from '../../src/lib/free-api-worker/model'
import * as bulk from '../../src/app/api/admin/free-api-worker/list/route'
import * as publicListings from '../../src/app/api/apis/route'
import * as listing from '../../src/app/api/apis/[id]/route'
import * as proxy from '../../src/app/api/proxy/[api_id]/route'
import * as envelope from '../../src/app/api/proxy/route'
import { getPublicSeoListing } from '../../src/lib/seo/public-catalog'
import * as adminStatus from '../../src/app/api/admin/free-api-worker/status/route'
import { groq } from '../../src/lib/groq'
const quote = (value: unknown) => "'" + JSON.stringify(value).replace(/'/g,"''") + "'::jsonb"
const owner = { ...alice, address: OWNER } as const
export const output = 'isolated-validation/free-api-worker-replacement/owner-publication-control'
export let ownerHeaders: ReturnType<typeof sessionHeaders>
export const request = (path: string, body?: unknown, headers = ownerHeaders, method = body ? 'POST' : 'GET') => new NextRequest(origin+path,
  { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
export async function publish(ids: string[], mode = 'FREE', price = 0, ownerRightsConfirmed: unknown = false) {
  const response = await bulk.POST(request('/api/admin/free-api-worker/list', { ids, mode, price, confirmed: true, owner_rights_confirmed: ownerRightsConfirmed }))
  const body = await response.json(); assert.equal(response.status,200,JSON.stringify(body)); return body
}
export function fixture(name: string, permission = 'UNKNOWN') {
  const id = digest('phase3:'+name), endpoint = `https://${name.toLowerCase().replace(/\W/g,'')}.example.org/books?limit=1&language=en`
  const lead = { id, providerId: new URL(endpoint).hostname, name, description: 'Saved synthetic book service', docs: endpoint.replace('/books?', '/docs?'), sources: [], auth: 'none' }
  const result = { technical:'PASSED',freeAccess:'VERIFIED',permission,termsChecked:true,endpoint,docs:lead.docs,lastSuccess:'2026-10-27T00:00:00Z',reason:'Saved fixture',retryAt:null,
    evidence:[{url:lead.docs,sha256:digest(name),note:permission==='ALLOWED'?'Commercial proxy and resale of API access are explicitly permitted.':'No applicable permission or prohibition found.',checkedAt:'2026-10-27T00:00:00Z'}],
    tests:[{url:endpoint,status:200,reason:'Functional saved result',sha256:digest(name)}] }
  sql(`INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES ('${id}','${lead.providerId}','${name}','${lead.docs}',${quote(lead)},${quote(result)},now())`)
  return {id,endpoint,lead,result}
}
async function main() {
  reset(); process.env.ADMIN_WALLETS=OWNER; ownerHeaders=sessionHeaders(owner)
  process.env.GROQ_API_KEY = 'offline-phase3-fixture'
  // Exercise the actual score parser and Seller persistence; only model transport is mocked.
  ;(groq.chat.completions as unknown as { create: () => Promise<unknown> }).create = async () => ({ choices: [{ message: { content: JSON.stringify({
    score: 8, suggested_price: 0.001, approved: true, critical_issues: [], warnings: [], positives: ['Functional fixture'],
    summary: 'Fixture review.', suggestions: { category: 'Data' },
  }) } }] })
  mkdirSync(output,{recursive:true})
  const source='isolated-validation/free-api-worker-replacement/discovery-phase2/listed-candidates.json'
  const sourceHash=digest(readFileSync(source)), ready=JSON.parse(readFileSync(source,'utf8')) as Candidate[]
  assert.equal(ready.length,672)
  // Read-only copy of the real ready inventory into a disposable database. No API requests.
  sql(`INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead,result,attempts,completed_at,saved_inventory)
    SELECT value->'lead'->>'id',value->'lead'->>'providerId',value->'lead'->>'name',value->'lead'->>'docs',value->'lead',value->'result',coalesce((value->>'attempts')::int,0),now(),CASE WHEN (value->>'historical')::boolean THEN jsonb_build_object('original',value) ELSE NULL END FROM jsonb_array_elements(${quote(ready)})`)
  assert.equal(sql('SELECT count(*) FROM public.api_listings WHERE free_worker_candidate_id IS NOT NULL'),'0')
  const originalProof=sql("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.free_worker_apis t")
  const inventory = JSON.parse(readFileSync('isolated-validation/free-api-worker-replacement/discovery-phase2/evaluation.json','utf8')).rows as Candidate[]
  assert.deepEqual(usableCandidates(inventory).map(row=>row.lead.id).sort(),ready.map(row=>row.lead.id).sort(), 'Every qualifying existing candidate is represented')
  const store=await databaseStore();assert.equal(usableCandidates(await store.candidates()).length,672)
  const view=await adminStatus.GET(request('/api/admin/free-api-worker/status'));assert.equal((await view.json()).total,672)
  const a=fixture('Phase3 Single'), b=fixture('Phase3 Paid','ALLOWED'), c=fixture('Phase3 Retry'), d=fixture('Phase3 Review','REVIEW_REQUIRED'), e=fixture('Phase3 Concurrent')
  let result=await publish([a.id]);assert.equal(result.published,1,JSON.stringify(result))
  const first=result.results[0].listingId;assert.ok(result.results[0].url.startsWith(`/apis/${first}/`))
  assert.equal(outbound.calls.get(a.endpoint),1)
  result=await publish([a.id]);assert.equal(result.results[0].listingId,first);assert.equal(outbound.calls.get(a.endpoint),1,'Completed Seller verification is reused')
  outbound.fail.add(c.endpoint)
  result=await publish([c.id,d.id]);assert.equal(result.published,1);assert.equal(result.results[0].success,false)
  const draft=result.results[0].listingId;assert.ok(draft)
  assert.ok(usableCandidates(await store.candidates()).some(row=>row.lead.id===c.id))
  outbound.fail.delete(c.endpoint)
  result=await publish([c.id]);assert.equal(result.published,1);assert.equal(result.results[0].listingId,draft)
  result=await publish([b.id],'PAID',0.001);assert.equal(result.published,0,'ALLOWED alone must not auto-confirm owner rights')
  result=await publish([b.id],'PAID',0.001,true);assert.equal(result.published,1,JSON.stringify(result))
  const unknown=fixture('Phase3 Unknown Paid')
  // Missing provider evidence stays ready and never becomes an affirmative permission.
  sql(`UPDATE public.free_worker_apis SET result=jsonb_set(result,'{evidence}','[]') WHERE id='${unknown.id}'`)
  const unknownBefore=sql(`SELECT result::text FROM public.free_worker_apis WHERE id='${unknown.id}'`)
  assert.ok(usableCandidates(await store.candidates()).some(row=>row.lead.id===unknown.id))
  for (const flag of [undefined,false,'true',1]) {
    result=await publish([unknown.id],'PAID',0.001,flag);assert.equal(result.published,0);assert.match(result.results[0].error,/rights/)
  }
  assert.equal(sql(`SELECT count(*) FROM public.api_listings WHERE free_worker_candidate_id='${unknown.id}'`),'0')
  const prohibited=fixture('Phase3 Prohibited','PROHIBITED')
  assert.equal((await publish([prohibited.id],'PAID',0.001,true)).published,0)
  assert.equal((await publish([prohibited.id])).published,0)
  assert.ok(!usableCandidates(await store.candidates()).some(row=>row.lead.id===prohibited.id))
  const concurrent=await Promise.all([publish([e.id]),publish([e.id])]);assert.ok(concurrent.some(row=>row.published===1))
  assert.equal(sql(`SELECT count(*) FROM public.api_listings WHERE free_worker_candidate_id='${e.id}'`),'1')
  const rows=JSON.parse(sql("SELECT json_agg(t) FROM public.api_listings t WHERE free_worker_candidate_id IS NOT NULL"))
  assert.equal(rows.length,5);assert.ok(rows.every((row:any)=>row.seller_wallet===OWNER&&row.is_active&&row.verified_at))
  assert.equal(Number(rows.find((row:any)=>row.free_worker_candidate_id===b.id).price_per_call),0.001)
  assert.ok(rows.filter((row:any)=>row.free_worker_candidate_id!==b.id).every((row:any)=>Number(row.price_per_call)===0))
  assert.equal(rows.find((row:any)=>row.id===first).endpoint_url,a.endpoint)
  assert.equal(sql('SELECT count(*) FROM public.free_worker_apis WHERE published_at IS NOT NULL'),'5')
  const published=await publicListings.GET(new NextRequest(origin+'/api/apis'));const publicBody=await published.json()
  assert.equal(publicBody.apis.length,5)
  assert.ok(await getPublicSeoListing(first), 'Successful FREE listing URL must resolve publicly')
  const freeResponse=await proxy.GET(new NextRequest(origin+`/api/proxy/${first}`),{params:Promise.resolve({api_id:first})})
  assert.equal(freeResponse.status,200);assert.equal((await freeResponse.json()).payment,'FREE')
  const freeEnvelope=await envelope.POST(request('/api/proxy',{api_id:first}));assert.equal(freeEnvelope.status,200)
  assert.equal(outbound.paidCalls,0);assert.equal(state.tables.api_calls.length,0);assert.equal(state.tables.purchases.length,0)
  console.log('PASS isolated publish, partial retry, duplicates, public FREE URL and delivery; no payment side effects')
  // Session, owner, origin, confirmation, precision and sensitive-action protections.
  assert.equal((await bulk.POST(request('/api/admin/free-api-worker/list',{ids:[unknown.id],confirmed:true,mode:'FREE'},{} as any))).status,403)
  assert.equal((await bulk.POST(request('/api/admin/free-api-worker/list',{ids:[unknown.id],confirmed:true,mode:'FREE'},{origin} as any))).status,401)
  process.env.ADMIN_WALLETS=OWNER+','+bob.address.toLowerCase()
  assert.equal((await bulk.POST(request('/api/admin/free-api-worker/list',{ids:[unknown.id],confirmed:true,mode:'FREE'},sessionHeaders(bob)))).status,403)
  process.env.ADMIN_WALLETS=OWNER
  assert.equal((await bulk.POST(request('/api/admin/free-api-worker/list',{ids:[unknown.id],confirmed:false,mode:'FREE'}))).status,400)
  assert.equal((await bulk.POST(request('/api/admin/free-api-worker/list',{ids:[unknown.id],confirmed:true,mode:'PAID',price:0.0000001}))).status,400)
  assert.equal((await bulk.POST(request('/api/admin/free-api-worker/list',{ids:[unknown.id],confirmed:true,mode:'FREE'},sessionHeaders(owner,{expired:true})))).status,401)
  assert.equal((await listing.PATCH(request(`/api/apis/${first}`,{endpoint_url:'https://changed.example.org/books'},ownerHeaders,'PATCH'),{params:Promise.resolve({id:first})})).status,401)
  result=await publish([unknown.id],'PAID',0.001,true);assert.equal(result.published,1)
  assert.equal(sql(`SELECT result::text FROM public.free_worker_apis WHERE id='${unknown.id}'`),unknownBefore)
  const receipt=JSON.parse(sql(`SELECT owner_rights_confirmation FROM public.api_listings WHERE free_worker_candidate_id='${unknown.id}'`))
  assert.equal(receipt.owner,OWNER);assert.equal(receipt.endpoint,unknown.endpoint);assert.equal(receipt.candidateId,unknown.id)
  assert.equal(receipt.confirmed,true);assert.ok(Date.parse(receipt.confirmedAt));assert.equal(receipt.version,'paid-api-access-v1')
  // Direct Seller requests cannot forge the server receipt or omit explicit owner confirmation.
  const direct=fixture('Phase3 Direct')
  let directResponse=await publicListings.POST(request('/api/apis',{free_worker_candidate_id:direct.id,price_per_call:0.001,
    owner_rights_confirmation:receipt}))
  assert.equal(directResponse.status,409)
  directResponse=await publicListings.POST(request('/api/apis',{free_worker_candidate_id:direct.id,price_per_call:0}))
  assert.equal(directResponse.status,201)
  const directId=(await directResponse.json()).id
  const context={params:Promise.resolve({id:directId})}
  assert.equal((await listing.PATCH(request(`/api/apis/${directId}`,{price_per_call:0.001},ownerHeaders,'PATCH'),context)).status,409)
  assert.equal((await listing.PATCH(request(`/api/apis/${directId}`,{price_per_call:0.001,owner_rights_confirmed:false},ownerHeaders,'PATCH'),context)).status,409)
  assert.equal((await listing.PATCH(request(`/api/apis/${directId}`,{price_per_call:0.001,owner_rights_confirmed:true},ownerHeaders,'PATCH'),context)).status,200)
  assert.equal(sql(`SELECT is_active FROM public.api_listings WHERE id='${directId}'`),'f','Rights confirmation must not publish a draft')
  assert.ok(usableCandidates(await store.candidates()).some(row=>row.lead.id===direct.id))
  const removed=fixture('Phase3 Removed');await store.remove([removed.id],OWNER)
  assert.equal((await publish([removed.id])).published,0)
  const limited=fixture('Phase3 Limited');state.rateLimitAllowed=false
  result=await publish([limited.id]);assert.equal(result.published,0);assert.ok(result.results[0].retryAfter>0)
  state.rateLimitAllowed=true
  result=await publish([limited.id]);assert.equal(result.published,1)
  // Successful publication is durable; re-admission does not resurrect it.
  await store.admit([a.lead as Candidate['lead']]);assert.ok(!usableCandidates(await store.candidates()).some(row=>row.lead.id===a.id))
  console.log('PASS session, ownership, origin, pricing, sensitive signatures, rate limits and durable Ready removal')
  if(process.env.FREE_WORKER_BROWSER==='1') { const {verifyBulkBrowser}=await import('./phase3-browser');await verifyBulkBrowser(fixture) }
  const originalIds=ready.map(row=>`'${row.lead.id}'`).join(',')
  assert.equal(sql(`SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.free_worker_apis t WHERE id IN (${originalIds})`),originalProof)
  assert.equal(digest(readFileSync(source)),sourceHash)
  assert.equal(usableCandidates(await store.candidates()).filter(row=>ready.some(original=>original.lead.id===row.lead.id)).length,672)
  const testListings=Number(sql('SELECT count(*) FROM public.api_listings WHERE free_worker_candidate_id IS NOT NULL'))
  const active=Number(sql('SELECT count(*) FROM public.api_listings WHERE free_worker_candidate_id IS NOT NULL AND is_active'))
  const report={isolated:true,readyPreserved:672,testListings,active,duplicatePrevention:true,partialFailureAndRetry:true,free:true,paid:true,owner:OWNER,sessionReused:true,paidOperations:outbound.paidCalls,ownerRightsConfirmation:true,providerEvidenceUnchanged:true,allQualifyingRepresented:true,browser:process.env.FREE_WORKER_BROWSER==='1',sourceHash}
  writeFileSync(output+'/verification.json',JSON.stringify(report,null,2)+'\n');console.log('PASS Phase 3',JSON.stringify(report))
}
main().catch(error=>{console.error(error);process.exitCode=1})
