import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Groq from 'groq-sdk'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { OWNER, digest } from '../../src/lib/free-api-worker/model'
import { groq } from '../../src/lib/groq'
import { POST as create } from '../../src/app/api/admin/free-api-worker/batches/route'
import { POST as advance, GET as status } from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import { POST as analyze } from '../../src/app/api/ai/score/route'
import { bulkCounts, mergeBulkProgress, runBulkSelection, type BulkProgress } from '../../src/lib/free-api-worker/bulk-progress'
import { workerListingInput } from '../../src/lib/free-api-worker/listing'
import { publishWorkerListing } from '../../src/lib/free-api-worker/publication'
import { bulkRpc } from '../../src/lib/free-api-worker/bulk'
import { verifyGroqPauseBrowser } from './groq-pause-browser'

reset(); process.env.ADMIN_WALLETS=OWNER; process.env.GROQ_API_KEY='offline-fixture'
delete process.env.MAHSHAR_GROQ_BUDGET_ENABLED
const headers=sessionHeaders({...alice,address:OWNER})
const quote=(v:unknown)=>"'"+(typeof v==='string'?v:JSON.stringify(v)).replace(/'/g,"''")+"'"
const req=(path:string,body?:unknown,auth=headers)=>new NextRequest(origin+path,{method:body===undefined?'GET':'POST',headers:{...auth,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
const calls=new Map<string,number>(), failing=new Map<string,string|null>()
const review={score:8,suggested_price:.004,approved:true,critical_issues:[],warnings:[],positives:['JSON data'],summary:'Fixture',suggestions:{category:'Data'}}
const provider=new Groq({apiKey:'offline-fixture',timeout:groq.timeout,maxRetries:groq.maxRetries,fetch:async(_url,init)=>{
 const params=JSON.parse(init!.body as string),name=/https:\/\/([a-z0-9]+)\.example\.org/.exec(params.messages[1].content)![1]
 calls.set(name,(calls.get(name)??0)+1)
 if(failing.has(name))return Response.json({error:{type:'tokens',code:'rate_limit_exceeded',message:'Fixture only'}},{status:429,headers:{'x-request-id':'req_0123456789abcdef',...(failing.get(name)===null?{}:{'retry-after':failing.get(name)!})}})
 return Response.json({choices:[{message:{content:JSON.stringify(review)}}]})
}})
groq.chat.completions.create=provider.chat.completions.create.bind(provider.chat.completions)
function candidate(name:string){
 const id=digest('groqpause:'+name),endpoint=`https://${name}.example.org/data`
 const lead={id,name,providerId:name+'.example.org',description:'Offline pause fixture',docs:endpoint,sources:[],auth:'none'}
 const result={technical:'PASSED',freeAccess:'VERIFIED',permission:'UNKNOWN',termsChecked:true,endpoint,docs:endpoint,lastSuccess:'2026-10-28T00:00:00Z',reason:'Fixture',retryAt:null,evidence:[],tests:[{url:endpoint,status:200,reason:'Fixture',sha256:digest(name)}]}
 sql(`INSERT INTO free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES(${quote(id)},${quote(lead.providerId)},${quote(name)},${quote(endpoint)},${quote(lead)}::jsonb,${quote(result)}::jsonb,now())`)
 return {id,name,endpoint}
}
async function selection(ids:string[]){const r=await create(req('/api/admin/free-api-worker/batches',{id:randomUUID(),ids,mode:'PAID',price:.001,confirmed:true,owner_rights_confirmed:true}));assert.equal(r.status,201,await r.clone().text());return (await r.json()).batch as BulkProgress}
async function read(id:string){const r=await status(req('/api/admin/free-api-worker/batches/'+id),{params:Promise.resolve({id})});assert.equal(r.status,200);return (await r.json()).batch as BulkProgress}
async function action(batch:BulkProgress,action='next',retry_at=batch.retry_at){return advance(req('/api/admin/free-api-worker/batches/'+batch.id,{action,retry_at}),{params:Promise.resolve({id:batch.id})})}
async function run(batch:BulkProgress,interrupted=false){return runBulkSelection({batch,stopped:()=>false,onProgress:()=>{},wait:async()=>{throw Error('Provider cooldown must not sleep')},request:async(path,init)=>{
 if(init?.method!=='POST')return status(req(path),{params:Promise.resolve({id:batch.id})})
 const response=await advance(req(path,JSON.parse(init.body as string)),{params:Promise.resolve({id:batch.id})})
 if(interrupted&&(await response.clone().json()).batch.pause_reason)throw Error('Simulated lost POST response')
 return response
 }})}
const listing=(id:string)=>JSON.parse(sql(`SELECT to_jsonb(a) FROM api_listings a WHERE free_worker_candidate_id=${quote(id)}`))
async function expire(batch:BulkProgress){sql(`UPDATE free_worker_bulk_batches SET retry_at=clock_timestamp()-interval '1 second' WHERE id=${quote(batch.id)}`);return read(batch.id)}
let cases=0;const pass=(s:string)=>{cases++;console.log('PASS',s)}
async function main(){
 const entries=Array.from({length:4},(_,i)=>candidate('pause'+i));let batch=await selection(entries.map(x=>x.id))
 const [first,limited,third,cached]=batch.items
 // Prepare a genuine completed Seller review in a synthetic draft, with activation deliberately interrupted.
 await assert.rejects(publishWorkerListing(req('/fixture'),await workerListingInput(cached.candidate_id,OWNER,.001,true),async stage=>{if(stage==='activation')throw Error('Fixture stops before activation')}),/Fixture/)
 const cachedBefore=listing(cached.candidate_id);assert(cachedBefore.free_worker_review.approved&&!cachedBefore.is_active)
 failing.set(limited.name,'605');const started=Date.now();batch=await run(batch,true)
 assert(Date.now()-started<15000,'605-second provider wait must not hold an HTTP request')
 assert.equal(batch.pause_reason,'groq_rate_limit');assert.deepEqual(bulkCounts(batch),{published:1,failed:0,processing:0,remaining:3})
 const seconds=(Date.parse(batch.retry_at!)-Date.now())/1000;assert(seconds>590&&seconds<=605)
 const held=batch.items.find(x=>x.candidate_id===limited.candidate_id)!;assert.equal(held.status,'pending');assert.equal(held.lease_until,null)
 const draft=listing(limited.candidate_id);assert(!draft.is_active&&draft.score===null)
 const events=JSON.parse(sql(`SELECT events FROM free_worker_bulk_items WHERE batch_id=${quote(batch.id)} AND candidate_id=${quote(limited.candidate_id)}`))
 assert(events.some((e:any)=>e.event==='groq_rate_limit'&&e.retry_after_seconds===605))
 assert.equal(sql(`SELECT manual_failed_at IS NULL AND published_at IS NULL FROM free_worker_apis WHERE id=${quote(limited.candidate_id)}`),'t')
 pass('real SDK 429 persists 605s pause and pending draft atomically; lost response restores pause without sleep')
 assert.throws(()=>sql(`UPDATE free_worker_bulk_batches SET price=price+1 WHERE id=${quote(batch.id)}`),/authorization_immutable/)
 assert.throws(()=>sql(`UPDATE free_worker_bulk_batches SET rights_confirmed=false WHERE id=${quote(batch.id)}`),/authorization_immutable/)
 assert.throws(()=>sql(`UPDATE free_worker_bulk_items SET input=input||'{"name":"unauthorized change"}'::jsonb WHERE batch_id=${quote(batch.id)}`),/selection_immutable/)
 const beforeCalls=JSON.stringify([...calls]),before=await read(batch.id)
 assert.deepEqual(before,batch);await run(batch);await action(batch)
 const early=await action(batch,'resume');assert.equal(early.status,409);assert.match(await early.text(),/groq_pause_not_elapsed/)
 assert.equal(JSON.stringify([...calls]),beforeCalls);assert.deepEqual(await read(batch.id),before)
 assert.equal(calls.get(third.name),undefined)
 pass('reload, repeated next, browser loop and premature Resume cannot call Groq or touch subsequent APIs')
 const future=batch;batch=await expire(batch);await run(batch);await action(batch)
 assert.equal((await read(batch.id)).pause_reason,'groq_rate_limit');assert.equal(JSON.stringify([...calls]),beforeCalls)
 const badOwner=await advance(req('/api/admin/free-api-worker/batches/'+batch.id,{action:'resume',retry_at:batch.retry_at},sessionHeaders(bob)),{params:Promise.resolve({id:batch.id})});assert.equal(badOwner.status,403)
 const stale=await action(batch,'resume',future.retry_at);assert.equal(stale.status,409)
 const r=await action(batch,'resume');assert.equal(r.status,200,await r.clone().text());const resumed=(await r.json()).batch as BulkProgress
 assert.equal(resumed.pause_reason,null);assert.equal(JSON.stringify([...calls]),beforeCalls)
 assert.equal(mergeBulkProgress(resumed,batch)!.pause_reason,null,'stale read cannot resurrect cleared pause')
 assert.equal(mergeBulkProgress(future,{...future,pause_reason:null,items:future.items.map(x=>({...x,updated_at:future.authorized_at}))})!.pause_reason,'groq_rate_limit')
 pass('elapsed time alone never restarts; owner Resume checks saved time; stale polling cannot overwrite pause/resume')
 failing.delete(limited.name);batch=await run(resumed)
 assert.deepEqual(bulkCounts(batch),{published:4,failed:0,processing:0,remaining:0})
 assert.equal(calls.get(first.name),1);assert.equal(calls.get(limited.name),2);assert.equal(calls.get(third.name),1);assert.equal(calls.get(cached.name),1)
 assert.equal(listing(limited.candidate_id).id,draft.id);assert.equal(listing(cached.candidate_id).id,cachedBefore.id)
 assert.deepEqual(listing(cached.candidate_id).free_worker_review,cachedBefore.free_worker_review)
 const finishedCalls=JSON.stringify([...calls]);await action(batch);await action(batch,'resume');assert.equal(JSON.stringify([...calls]),finishedCalls)
 assert.equal(sql(`SELECT count(*) FROM api_listings WHERE free_worker_candidate_id IN (${entries.map(x=>quote(x.id)).join(',')})`),'4')
 pass('Resume continues saved ordinal; published APIs and completed draft reviews are reused without duplicates')

 for(const [name,header] of [['missingheader',null],['dateheader',new Date(Date.now()+605000).toUTCString()]] as const){
  const item=candidate(name);let b=await selection([item.id]);failing.set(name,header)
  b=await run(b);const remaining=(Date.parse(b.retry_at!)-Date.now())/1000
  assert(b.pause_reason==='groq_rate_limit'&&remaining>0&&remaining<606)
  assert(remaining>(header===null?45:570));failing.delete(name)
  b=await expire(b);const resumedResponse=await action(b,'resume');b=await run((await resumedResponse.json()).batch)
  assert.equal(b.items[0].status,'published')
 }
 pass('HTTP-date Retry-After preserved; missing header uses conservative 60-second manual pause')

 // Seller requests do not receive the Bulk-specific hint or a new retry policy.
 failing.set(limited.name,'605');const seller=await analyze(req('/api/ai/score',{api_id:draft.id}));const result=await seller.json()
 assert.equal(result.ai_available,false);assert.equal(result.bulk_groq_retry_after_seconds,undefined);assert.equal(result.retry_after_seconds,undefined)
 assert.equal((await read(batch.id)).pause_reason,null);failing.delete(limited.name)
 assert.equal(groq.timeout,8000);assert.equal(groq.maxRetries,0)
 pass('normal Seller response/retry behavior and Groq SDK settings remain unchanged')

 const leaseEntry=candidate('leasefence');let leaseBatch=await selection([leaseEntry.id])
 const claimed=await bulkRpc<any>('claim',{p_id:leaseBatch.id,p_owner:OWNER})
 assert(Date.parse(claimed.lease_until)-Date.now()>58000&&Date.parse(claimed.lease_until)-Date.now()<=60000)
 assert.equal(await bulkRpc('pause',{p_id:leaseBatch.id,p_owner:OWNER,p_candidate:leaseEntry.id,p_token:randomUUID(),p_retry:605}),false)
 assert.equal((await read(leaseBatch.id)).pause_reason,null)
 sql(`UPDATE free_worker_bulk_items SET lease_until=clock_timestamp()-interval '1 second' WHERE batch_id=${quote(leaseBatch.id)}`)
 await bulkRpc('pause',{p_id:leaseBatch.id,p_owner:OWNER,p_candidate:leaseEntry.id,p_token:claimed.lease_token,p_retry:605})
 leaseBatch=await read(leaseBatch.id);assert.equal(leaseBatch.pause_reason,null);assert.match(leaseBatch.items[0].last_error!,/^TIMEOUT:/)
 assert.equal(sql(`SELECT bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT p.prosecdef) FROM pg_proc p WHERE proname IN ('free_worker_bulk_pause','free_worker_bulk_resume')`),'t')
 pass('60-second lease and late-result fencing retained; pause/resume RPCs remain service-only')
 await verifyGroqPauseBrowser(candidate,selection,action,expire,read,failing,calls)
 pass('Chromium reload/countdown/explicit Resume and repeated provider pause')
 assert.equal(outbound.paidCalls,0);assert.equal(sql('SELECT count(*) FROM purchases'),'0');assert.equal(sql('SELECT count(*) FROM api_calls'),'0')
 console.log(`PASS ${cases} focused Groq pause scenario groups; no real inference/publication/payment`)
}
main().catch(error=>{console.error(error);process.exitCode=1})
