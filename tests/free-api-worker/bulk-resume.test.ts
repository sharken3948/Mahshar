import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { OWNER, digest } from '../../src/lib/free-api-worker/model'
import { groq } from '../../src/lib/groq'
import { POST as create, GET as latest } from '../../src/app/api/admin/free-api-worker/batches/route'
import { POST as advance, GET as status } from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import { bulkCounts, runBulkSelection, type BulkProgress } from '../../src/lib/free-api-worker/bulk-progress'
import { verifyResumeBrowser } from './bulk-resume-browser'
import { bulkRpc } from '../../src/lib/free-api-worker/bulk'

reset(); process.env.ADMIN_WALLETS=OWNER; process.env.GROQ_API_KEY='offline-fixture'
const headers=sessionHeaders({...alice,address:OWNER})
const req=(path:string,body?:unknown,auth=headers)=>new NextRequest(origin+path,{method:body===undefined?'GET':'POST',headers:{...auth,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
const quote=(value:unknown)=>"'"+(typeof value==='string'?value:JSON.stringify(value)).replace(/'/g,"''")+"'"
const calls=new Map<string,number>(), failing=new Set<string>()
;(groq.chat.completions as any).create=async(params:any)=>{
 const prompt=params.messages[1].content as string
 const name=/https:\/\/([a-z0-9]+)\.example\.org/.exec(prompt)![1]
 calls.set(name,(calls.get(name)??0)+1)
 if(failing.has(name))throw Error('Offline fixture scoring unavailable')
 return {choices:[{message:{content:JSON.stringify({score:8,suggested_price:.004,approved:true,critical_issues:[],warnings:[],positives:['JSON data'],summary:'Useful fixture',suggestions:{category:'Data'}})}}]}
}
function candidate(name:string){
 const id=digest('bulk:'+name),endpoint=`https://${name}.example.org/data`
 const lead={id,providerId:name+'.example.org',name,description:'Bulk resume fixture',docs:endpoint,sources:[],auth:'none'}
 const result={technical:'PASSED',freeAccess:'VERIFIED',permission:'UNKNOWN',termsChecked:true,endpoint,docs:endpoint,lastSuccess:'2026-10-28T00:00:00Z',reason:'Fixture',retryAt:null,evidence:[],tests:[{url:endpoint,status:200,reason:'Fixture',sha256:digest(name)}]}
 sql(`INSERT INTO free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES(${quote(id)},${quote(lead.providerId)},${quote(name)},${quote(endpoint)},${quote(lead)}::jsonb,${quote(result)}::jsonb,now())`)
 return {id,name,endpoint}
}
async function selection(ids:string[],mode='PAID',id=randomUUID()){
 const response=await create(req('/api/admin/free-api-worker/batches',{id,ids,mode,price:mode==='FREE'?0:.001,confirmed:true,owner_rights_confirmed:mode==='PAID'}))
 assert.equal(response.status,201,await response.clone().text())
 return (await response.json()).batch as BulkProgress
}
async function next(batch:BulkProgress){
 const response=await advance(req(`/api/admin/free-api-worker/batches/${batch.id}`,{action:'next'}),{params:Promise.resolve({id:batch.id})})
 assert.equal(response.status,200,await response.clone().text());return (await response.json()).batch as BulkProgress
}
async function read(id:string){const response=await status(req('/api/admin/free-api-worker/batches/'+id),{params:Promise.resolve({id})});assert.equal(response.status,200);return (await response.json()).batch as BulkProgress}
async function retry(batch:BulkProgress){const response=await advance(req('/api/admin/free-api-worker/batches/'+batch.id,{action:'retry_failed'}),{params:Promise.resolve({id:batch.id})});assert.equal(response.status,200,await response.clone().text());return (await response.json()).batch as BulkProgress}
async function run(batch:BulkProgress){
 return runBulkSelection({batch,stopped:()=>false,onProgress:()=>{},wait:async()=>{throw Error('Unexpected fixture wait')},
  request:async(path,init)=>advance(req(path,JSON.parse(init!.body as string)),{params:Promise.resolve({id:batch.id})})})
}
const listing=(id:string)=>JSON.parse(sql(`SELECT row_to_json(t) FROM api_listings t WHERE free_worker_candidate_id=${quote(id)}`))
let cases=0;const pass=(message:string)=>{cases++;console.log('PASS',message)}
async function main(){
 const items=Array.from({length:25},(_,i)=>candidate('bulk'+i))
 let batch=await selection(items.map(x=>x.id))
 assert.deepEqual(bulkCounts(batch),{published:0,failed:0,processing:0,remaining:25})
 assert.equal(sql('SELECT count(*) FROM api_listings'),'0','creating authorization must not publish or score')
 assert.equal(calls.size,0)
 const repeated=await create(req('/api/admin/free-api-worker/batches',{id:batch.id,ids:items.map(x=>x.id),mode:'PAID',price:.001,confirmed:true,owner_rights_confirmed:true}))
 assert.equal(repeated.status,200);assert.equal(sql('SELECT count(*) FROM free_worker_bulk_batches'),'1')
 pass('25 selected APIs saved atomically; creation retry is idempotent and does not publish')
 // Individual failures: one Groq outage and one provider validation error.
 failing.add('bulk4');failing.add('bulk9');outbound.fail.add(items[8].endpoint)
 for(let i=0;i<10;i++)batch=await next(batch)
 assert.deepEqual(bulkCounts(batch),{published:7,failed:3,processing:0,remaining:15})
 assert(batch.items[4].last_error);assert(batch.items[8].last_error)
 assert.equal(batch.items[4].stage,'analysis')
 const snapshots=items.filter((_,i)=>i<10&&i!==4&&i!==8&&i!==9).map(x=>listing(x.id))
 // Discard all in-memory UI state, then recover the durable selection.
 const restored=await latest(req('/api/admin/free-api-worker/batches'))
 batch=(await restored.json()).batch
 assert.equal(batch.items.length,25);assert.equal(bulkCounts(batch).remaining,15)
 batch=await run(batch)
 assert.deepEqual(bulkCounts(batch),{published:22,failed:3,processing:0,remaining:0})
 for(const saved of snapshots)assert.deepEqual(listing(saved.free_worker_candidate_id),saved)
 for(const item of items.filter((_,i)=>i!==4&&i!==8&&i!==9))assert.equal(calls.get(item.name),1)
 pass('browser interruption after partial success: Resume finishes remaining 15 and skips saved publications/reviews')
 const draftIds=[listing(items[4].id).id,listing(items[8].id).id]
 failing.clear();outbound.fail.clear();batch=await run(await retry(batch))
 assert.equal(bulkCounts(batch).published,25)
 assert.deepEqual([listing(items[4].id).id,listing(items[8].id).id],draftIds)
 for(const item of items){const row=listing(item.id);assert.equal(row.category,'Data');assert.equal(Number(row.score),8);assert.equal(Number(row.price_per_call),.001);assert.equal(row.seller_wallet,OWNER);assert(row.free_worker_review.approved);assert.equal(sql(`SELECT listing_id=${quote(row.id)}::uuid AND published_at IS NOT NULL FROM free_worker_apis WHERE id=${quote(item.id)}`),'t')}
 assert.equal(sql('SELECT count(*) FROM api_listings'),'25')
 pass('failed drafts retry in place; all 25 category, score, owner, price and publication records correct')
 // Lose the response after a completed publication: delivery failure must not replay it.
 let lost=await selection([items[0].id])
 await assert.rejects(runBulkSelection({batch:lost,stopped:()=>false,onProgress:()=>{},wait:async()=>{},request:async()=>{await next(lost);throw Error('Browser connection lost')}}))
 const before=calls.get('bulk0');lost=await run(await read(lost.id));assert.equal(calls.get('bulk0'),before);assert.equal(bulkCounts(lost).published,1)
 pass('lost response reconciles existing publication without duplicate listing or Groq request')
 // Activation fails after successful Groq result. Retry must reuse the atomic review.
 const activation=candidate('activation');let paused=await selection([activation.id],'FREE')
 sql(`CREATE FUNCTION fail_bulk_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='activation' AND NEW.is_active THEN RAISE EXCEPTION 'fixture activation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_bulk_activation BEFORE UPDATE ON api_listings FOR EACH ROW EXECUTE FUNCTION fail_bulk_activation()`)
 paused=await next(paused);assert.equal(bulkCounts(paused).failed,1);assert.equal(paused.items[0].stage,'activation')
 assert.equal(listing(activation.id).is_active,false);assert.equal(calls.get('activation'),1)
 sql('DROP TRIGGER fail_bulk_activation ON api_listings; DROP FUNCTION fail_bulk_activation()')
 paused=await run(await retry(paused));assert.equal(bulkCounts(paused).published,1);assert.equal(calls.get('activation'),1);assert.equal(Number(listing(activation.id).price_per_call),0)
 pass('FREE publication resumes activation using completed Groq analysis, without rescoring')
 // Simulate a server crash between the atomic analysis write and its response.
 const crash=candidate('crash');let recovering=await selection([crash.id])
 sql(`CREATE FUNCTION expire_bulk_after_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='crash' AND NEW.free_worker_review IS NOT NULL THEN UPDATE free_worker_bulk_items SET lease_until=now()-interval '1 second' WHERE candidate_id=NEW.free_worker_candidate_id; END IF; RETURN NEW; END $$; CREATE TRIGGER expire_bulk_after_review AFTER UPDATE ON api_listings FOR EACH ROW EXECUTE FUNCTION expire_bulk_after_review()`)
 const expired=await advance(req('/api/admin/free-api-worker/batches/'+recovering.id,{action:'next'}),{params:Promise.resolve({id:recovering.id})});assert.equal(expired.status,503)
 assert.equal(listing(crash.id).is_active,false);assert.equal(calls.get('crash'),1)
 sql('DROP TRIGGER expire_bulk_after_review ON api_listings; DROP FUNCTION expire_bulk_after_review()')
 recovering=await run(await read(recovering.id));assert.equal(bulkCounts(recovering).published,1);assert.equal(calls.get('crash'),1)
 pass('expired/crashed request resumes from persisted review; stale request cannot publish or overwrite checkpoint')
 const concurrent=candidate('concurrent');let parallel=await selection([concurrent.id])
 const lease=await bulkRpc<any>('claim',{p_id:parallel.id,p_owner:OWNER})
 assert(lease.lease_token);assert.equal(await bulkRpc('claim',{p_id:parallel.id,p_owner:OWNER}),null)
 assert.equal(await bulkRpc('finish',{p_id:parallel.id,p_owner:OWNER,p_candidate:concurrent.id,p_token:randomUUID(),p_status:'published'}),false)
 assert.equal(bulkCounts(await read(parallel.id)).processing,1)
 sql(`UPDATE free_worker_bulk_items SET lease_until=now()-interval '1 second' WHERE batch_id=${quote(parallel.id)}`)
 parallel=await run(await read(parallel.id));assert.equal(bulkCounts(parallel).published,1);assert.equal(calls.get('concurrent'),1)
 pass('concurrent tabs share a fenced lease; abandoned request is reclaimable and wrong token is rejected')
 const changed=candidate('changed');let changedBatch=await selection([changed.id])
 sql(`UPDATE free_worker_apis SET lead=jsonb_set(lead,'{description}','"Changed after approval"') WHERE id=${quote(changed.id)}`)
 changedBatch=await run(changedBatch);assert.equal(bulkCounts(changedBatch).failed,1);assert.equal(calls.get('changed'),undefined)
 assert.match(changedBatch.items[0].last_error!,/changed since authorization/)
 pass('changed candidate cannot inherit the original owner authorization')
 const limited=candidate('limited');let waiting=await selection([limited.id])
 state.rateLimitAllowed=false;waiting=await next(waiting)
 assert.deepEqual(bulkCounts(waiting),{published:0,failed:0,processing:0,remaining:1})
 assert(waiting.retry_at);assert.match(waiting.items[0].last_error!,/rate_limited/)
 const blocked=await next(waiting);assert.equal(blocked.items[0].attempts,1,'Retry-After prevents repeated requests')
 state.rateLimitAllowed=true
 sql(`UPDATE free_worker_bulk_batches SET retry_at=now()-interval '1 second' WHERE id=${quote(waiting.id)}`)
 waiting=await run(await read(waiting.id));assert.equal(bulkCounts(waiting).published,1)
 pass('Seller rate limits persist a retry time and pause without losing work or imposing new quotas')
 const expiredHeaders=sessionHeaders({...alice,address:OWNER},{expired:true})
 const expiredSession=await advance(req('/api/admin/free-api-worker/batches/'+parallel.id,{action:'next'},expiredHeaders),{params:Promise.resolve({id:parallel.id})})
 assert.equal(expiredSession.status,401)
 const malformed=await create(new NextRequest(origin+'/api/admin/free-api-worker/batches',{method:'POST',headers,body:'{invalid'}));assert.equal(malformed.status,400)
 const unauthorized=await advance(req('/api/admin/free-api-worker/batches/'+parallel.id,{action:'next'},sessionHeaders(bob)),{params:Promise.resolve({id:parallel.id})});assert.equal(unauthorized.status,403)
 const noRights=await create(req('/api/admin/free-api-worker/batches',{id:randomUUID(),ids:[items[0].id],mode:'PAID',price:.001,confirmed:true}));assert.equal(noRights.status,409)
 const tamper=await create(req('/api/admin/free-api-worker/batches',{id:parallel.id,ids:[items[1].id],mode:'PAID',price:.001,confirmed:true,owner_rights_confirmed:true}));assert.equal(tamper.status,409)
 assert.equal(sql("SELECT has_table_privilege('anon','free_worker_bulk_items','SELECT')"),'f')
 assert.equal(sql("SELECT has_function_privilege('authenticated','free_worker_bulk_claim(uuid,text)','EXECUTE')"),'f')
 assert.equal(outbound.paidCalls,0);assert.equal(sql('SELECT count(*) FROM purchases'),'0');assert.equal(sql('SELECT count(*) FROM api_calls'),'0')
 pass('owner/session, immutable selection, PAID rights and DB grants preserved; zero purchases or financial operations')
 if(process.env.FREE_WORKER_PLAYWRIGHT_MODULE)await verifyResumeBrowser(candidate,failing,calls)
 console.log(`PASS ${cases} durable Bulk List integration cases`)
}
main().catch(error=>{console.error(error);process.exitCode=1})
