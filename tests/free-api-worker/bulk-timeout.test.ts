import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { OWNER, digest } from '../../src/lib/free-api-worker/model'
import { groq } from '../../src/lib/groq'
import { POST as create } from '../../src/app/api/admin/free-api-worker/batches/route'
import { POST as advance, GET as status } from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import { bulkCounts, mergeBulkProgress, runBulkSelection, type BulkProgress } from '../../src/lib/free-api-worker/bulk-progress'
import { bulkRpc } from '../../src/lib/free-api-worker/bulk'
import { bulkDatabaseFetch, currentBulkAttempt, runBulkAttempt } from '../../src/lib/free-api-worker/bulk-attempt'

reset();process.env.ADMIN_WALLETS=OWNER;process.env.GROQ_API_KEY='offline-fixture'
const headers=sessionHeaders({...alice,address:OWNER})
const quote=(value:unknown)=>"'"+(typeof value==='string'?value:JSON.stringify(value)).replace(/'/g,"''")+"'"
const req=(path:string,body?:unknown)=>new NextRequest(origin+path,{method:body===undefined?'GET':'POST',headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
const pause=(ms=25)=>new Promise(resolve=>setTimeout(resolve,ms))
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {resolve,promise}}
const calls=new Map<string,number>()
const review=(score=8)=>({choices:[{message:{content:JSON.stringify({score,suggested_price:.004,approved:true,critical_issues:[],warnings:[],positives:['JSON data'],summary:'Fixture',suggestions:{category:'Data'}})}}]})
const oldGroq=deferred<ReturnType<typeof review>>();let timedSignal:AbortSignal|undefined
;(groq.chat.completions as any).create=async(params:any,options?:{signal:AbortSignal})=>{
 const name=/https:\/\/([a-z0-9]+)\.example\.org/.exec(params.messages[1].content)![1]
 calls.set(name,(calls.get(name)??0)+1)
 if(name==='timeoutreal'&&calls.get(name)===1){timedSignal=options?.signal;return oldGroq.promise}
 return review()
}
function candidate(name:string){
 const id=digest('timeout:'+name),endpoint=`https://${name}.example.org/data`
 const lead={id,providerId:name+'.example.org',name,description:'Bulk timeout fixture',docs:endpoint,sources:[],auth:'none'}
 const result={technical:'PASSED',freeAccess:'VERIFIED',permission:'UNKNOWN',termsChecked:true,endpoint,docs:endpoint,lastSuccess:'2026-10-28T00:00:00Z',reason:'Fixture',retryAt:null,evidence:[],tests:[{url:endpoint,status:200,reason:'Fixture',sha256:digest(name)}]}
 sql(`INSERT INTO free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES(${quote(id)},${quote(lead.providerId)},${quote(name)},${quote(endpoint)},${quote(lead)}::jsonb,${quote(result)}::jsonb,now())`)
 return {id,name,endpoint}
}
async function selection(ids:string[]){const response=await create(req('/api/admin/free-api-worker/batches',{id:randomUUID(),ids,mode:'PAID',price:.001,confirmed:true,owner_rights_confirmed:true}));assert.equal(response.status,201,await response.clone().text());return (await response.json()).batch as BulkProgress}
async function read(id:string){const response=await status(req('/api/admin/free-api-worker/batches/'+id),{params:Promise.resolve({id})});assert.equal(response.status,200);return (await response.json()).batch as BulkProgress}
async function action(batch:BulkProgress,action='next'){const response=await advance(req('/api/admin/free-api-worker/batches/'+batch.id,{action}),{params:Promise.resolve({id:batch.id})});assert.equal(response.status,200,await response.clone().text());return (await response.json()).batch as BulkProgress}
const listing=(id:string)=>JSON.parse(sql(`SELECT coalesce((SELECT to_jsonb(t) FROM api_listings t WHERE free_worker_candidate_id=${quote(id)}),'null')`))
let cases=0;const pass=(message:string)=>{cases++;console.log('PASS',message)}
async function main(){
 const probe=candidate('probe');let probeBatch=await selection([probe.id]);const lease=await bulkRpc<any>('claim',{p_id:probeBatch.id,p_owner:OWNER})
 const remaining=Date.parse(lease.lease_until)-Date.now();assert(remaining>58000&&remaining<=60000)
 await bulkRpc('finish',{p_id:probeBatch.id,p_owner:OWNER,p_candidate:probe.id,p_token:lease.lease_token,p_status:'failed',p_error:'Fixture preparation'})
 pass('Production claim creates exactly a 60-second deadline, without a ten-minute lock')

 const items=Array.from({length:25},(_,i)=>candidate(i===5?'timeoutreal':'deadline'+i))
 let batch=await selection(items.map(x=>x.id));let timeoutElapsed=0,steps=0
 batch=await runBulkSelection({batch,stopped:()=>false,onProgress:()=>{},wait:async()=>{throw Error('Unexpected wait')},request:async(path,init)=>{
   const start=Date.now();const response=await advance(req(path,JSON.parse(init!.body as string)),{params:Promise.resolve({id:batch.id})});steps++;if(steps===6)timeoutElapsed=Date.now()-start;return response
 }})
 assert.deepEqual(bulkCounts(batch),{published:24,failed:1,processing:0,remaining:0});assert.equal(steps,25)
 assert(timeoutElapsed>=59000&&timeoutElapsed<75000,`Actual server timeout ${timeoutElapsed}ms`)
 assert(timedSignal?.aborted);assert.match(batch.items[5].last_error!,/^TIMEOUT:/)
 const draft=listing(items[5].id);assert(draft&&!draft.is_active);assert.equal(draft.score,null)
 assert.equal(sql(`SELECT manual_failed_at IS NULL AND removed_at IS NULL FROM free_worker_apis WHERE id=${quote(items[5].id)}`),'t')
 pass('Real 60-second server timeout aborts Groq, saves TIMEOUT and automatically finishes the other 24 APIs; failed candidate stays Ready')

 batch=await action(await action(batch,'retry_failed'));const retried=listing(items[5].id)
 assert.equal(bulkCounts(batch).published,25);assert.equal(retried.id,draft.id);assert.equal(calls.get('timeoutreal'),2)
 oldGroq.resolve(review(1));await pause(100)
 assert.deepEqual(listing(items[5].id),retried);assert.equal((await read(batch.id)).items[5].status,'published')
 pass('Manual Retry reuses draft; late old Groq response cannot overwrite the new review, outcome or publication')

 // Short deadlines below are injected ONLY into this disposable DB to exercise every failure stage quickly.
 sql(`CREATE FUNCTION fixture_short_deadline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='processing' AND OLD.status<>'processing' AND NEW.input->>'name' LIKE 'short%' THEN NEW.lease_until=clock_timestamp()+interval '2 seconds'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_short_deadline BEFORE UPDATE ON free_worker_bulk_items FOR EACH ROW EXECUTE FUNCTION fixture_short_deadline()`)
 const preparation=candidate('shortprepare');let prepareBatch=await selection([preparation.id]);const oldInsert=deferred<void>();let insertHeld=false
 outbound.beforeListingWrite=async value=>{if(value.name===preparation.name&&!insertHeld){insertHeld=true;await oldInsert.promise}}
 prepareBatch=await action(prepareBatch);assert.equal(prepareBatch.items[0].status,'failed');assert.match(prepareBatch.items[0].last_error!,/^TIMEOUT:/);assert.equal(listing(preparation.id),null)
 outbound.beforeListingWrite=null;prepareBatch=await action(await action(prepareBatch,'retry_failed'));const prepared=listing(preparation.id)
 oldInsert.resolve();await pause(100);assert.deepEqual(listing(preparation.id),prepared)
 pass('Late draft INSERT is fenced after timeout and newer retry; one listing remains')

 const activation=candidate('shortactivation');let activationBatch=await selection([activation.id]);const oldActivation=deferred<void>();let activationHeld=false
 outbound.beforeListingWrite=async value=>{if(value.is_active===true&&!activationHeld){activationHeld=true;await oldActivation.promise}}
 activationBatch=await action(activationBatch);assert.equal(activationBatch.items[0].status,'failed');assert.match(activationBatch.items[0].last_error!,/^TIMEOUT:/)
 const reviewed=listing(activation.id);assert(!reviewed.is_active&&reviewed.free_worker_review.approved);assert.equal(calls.get(activation.name),1)
 outbound.beforeListingWrite=null;activationBatch=await action(await action(activationBatch,'retry_failed'));const activated=listing(activation.id)
 assert.equal(activated.id,reviewed.id);assert.equal(calls.get(activation.name),1)
 oldActivation.resolve();await pause(100);assert.deepEqual(listing(activation.id),activated)
 pass('Completed Groq review survives activation timeout and is reused; late activation cannot overwrite newer state')

 const endpoint=candidate('shortendpoint');let endpointBatch=await selection([endpoint.id]);let endpointSignal:AbortSignal|undefined
 const oldEndpoint=deferred<Response>()
 outbound.waitForEndpoint=async(url,init)=>{
   if(url!==endpoint.endpoint)return null
   const prepared=typeof init==='function'?await init():init
   endpointSignal=prepared.outboundInit.signal;return oldEndpoint.promise
 }
 endpointBatch=await action(endpointBatch);assert.equal(endpointBatch.items[0].status,'failed');assert(endpointSignal?.aborted)
 outbound.waitForEndpoint=null;oldEndpoint.resolve(Response.json({books:[{title:'late'}]}));await pause(100)
 assert.equal(calls.get(endpoint.name),undefined);assert.equal(listing(endpoint.id).score,null)
 endpointBatch=await action(await action(endpointBatch,'retry_failed'));assert.equal(endpointBatch.items[0].status,'published')
 pass('Bulk cancellation covers endpoint validation without changing its existing timeout; late endpoint cannot start Groq')

 const abandoned=candidate('abandoned'),following=candidate('following');let interrupted=await selection([abandoned.id,following.id])
 const oldLease=await bulkRpc<any>('claim',{p_id:interrupted.id,p_owner:OWNER})
 sql(`UPDATE free_worker_bulk_items SET lease_until=now()-interval '1 second' WHERE batch_id=${quote(interrupted.id)} AND candidate_id=${quote(abandoned.id)}`)
 interrupted=await action(interrupted);assert.equal(interrupted.items[0].status,'failed');assert.equal(interrupted.items[1].status,'published');assert.match(interrupted.items[0].last_error!,/^TIMEOUT:/)
 assert.equal(calls.get(abandoned.name),undefined)
 assert.equal(await bulkRpc('finish',{p_id:interrupted.id,p_owner:OWNER,p_candidate:abandoned.id,p_token:oldLease.lease_token,p_status:'published'}),false)
 interrupted=await action(await action(interrupted,'retry_failed'));assert.equal(bulkCounts(interrupted).published,2)
 pass('Server/browser interruption expires durably on Resume, skips timed-out API and continues next; explicit Retry restores it')

 // Simulate losing the final checkpoint after activation committed under its valid token.
 const committed=candidate('committed');let committedBatch=await selection([committed.id])
 outbound.afterListingWrite=async value=>{if(value.is_active===true)sql(`UPDATE free_worker_bulk_items SET lease_until=now()-interval '1 second' WHERE candidate_id=${quote(committed.id)}`)}
 committedBatch=await action(committedBatch);assert.equal(committedBatch.items[0].status,'published');assert.equal(calls.get(committed.name),1)
 outbound.afterListingWrite=null
 pass('Activation committed before deadline is reconciled as published after lost finish, without duplicate publication')

 const lost=candidate('lostresponse');let lostBatch=await selection([lost.id]);let delivered=false
 lostBatch=await runBulkSelection({batch:lostBatch,stopped:()=>false,onProgress:()=>{},wait:async()=>{},request:async(path,init)=>{
   if(init?.method==='POST'){await action(lostBatch);delivered=true;throw Error('Lost HTTP response')}
   assert(delivered);return status(req(path),{params:Promise.resolve({id:lostBatch.id})})
 }})
 assert.equal(lostBatch.items[0].status,'published');assert.equal(calls.get(lost.name),1)
 pass('Browser transport failure reads saved progress before continuing; delivered publication is not repeated')

 const browserPending=structuredClone(lostBatch);browserPending.items[0].status='pending'
 const browserFailed=structuredClone(lostBatch);browserFailed.items[0].status='failed';browserFailed.items[0].last_error='TIMEOUT: fixture'
 let browserSignal:AbortSignal|undefined,browserReads=0
 mock.timers.enable({apis:['setTimeout']})
 try {
   const hung=runBulkSelection({batch:browserPending,stopped:()=>false,onProgress:()=>{},wait:async()=>{},request:async(_path,init)=>{
     if(init?.method==='POST'){browserSignal=init.signal as AbortSignal;return new Promise<Response>(()=>{})}
     browserReads++;return Response.json({batch:browserFailed})
   }})
   await Promise.resolve();mock.timers.tick(75000)
   assert.equal((await hung).items[0].status,'failed');assert(browserSignal?.aborted);assert.equal(browserReads,1)
 } finally {mock.timers.reset()}
 pass('Hung browser delivery is bounded and reconciles saved TIMEOUT rather than remaining Processing indefinitely')

 const older=structuredClone(lostBatch);older.items[0].status='processing';older.items[0].updated_at='2020-01-01T00:00:00Z'
 assert.equal(mergeBulkProgress(lostBatch,older)!.items[0].status,'published')
 assert.equal(mergeBulkProgress(older,lostBatch)!.items[0].status,'published')
 assert.equal(bulkDatabaseFetch(),undefined,'ordinary clients have no new timeout/fetch override')
 assert.equal(currentBulkAttempt(),undefined)
 const originalFetch=globalThis.fetch;let captured:RequestInit|undefined
 globalThis.fetch=async(_input,init)=>{captured=init;return Response.json({ok:true})}
 try {await runBulkAttempt({batch:randomUUID(),candidate:digest('capture'),token:randomUUID(),deadline:Date.now()+1000},async()=>{const scoped=bulkDatabaseFetch()!;await scoped('https://db.example.org',{headers:{authorization:'fixture'}});assert(new Headers(captured?.headers).has('x-mahshar-bulk-attempt'));assert.equal(new Headers(captured?.headers).get('authorization'),'fixture');assert(captured?.signal)})} finally{globalThis.fetch=originalFetch}
 pass('Polling merges monotonically; attempt context is per request and ordinary clients are unchanged')

 const atomic=await selection([committed.id]);const atomicLease=await bulkRpc<any>('claim',{p_id:atomic.id,p_owner:OWNER})
 const beforeAtomic=listing(committed.id)
 sql(`UPDATE free_worker_bulk_items SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE batch_id=${quote(atomic.id)}`)
 await runBulkAttempt({batch:atomic.id,candidate:committed.id,token:atomicLease.lease_token,deadline:Date.now()+2000},async()=>{
   assert.throws(()=>sql(`UPDATE api_listings SET score=9 WHERE free_worker_candidate_id=${quote(committed.id)}; SELECT pg_sleep(0.4)`),/TIMEOUT/)
 })
 assert.deepEqual(listing(committed.id),beforeAtomic)
 await action(atomic)
 pass('Database checks deadline at transaction completion; a write started before expiry but committed late is rolled back')

 assert.equal(sql('SELECT count(*) FROM (SELECT free_worker_candidate_id FROM api_listings GROUP BY free_worker_candidate_id HAVING count(*)>1) s'),'0')
 assert.equal(sql("SELECT has_function_privilege('anon','free_worker_bulk_expire(uuid,text)','EXECUTE')"),'f')
 assert.equal(sql('SELECT count(*) FROM purchases'),'0');assert.equal(sql('SELECT count(*) FROM x402_settlement_attempts'),'0');assert.equal(outbound.paidCalls,0)
 pass('Duplicate prevention, service-only RPCs and financial isolation preserved')
 console.log(`PASS ${cases} Bulk timeout/recovery scenarios`)
}
main().catch(error=>{console.error(error);process.exitCode=1})
