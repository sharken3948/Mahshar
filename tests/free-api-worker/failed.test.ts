import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { sql, outbound } from './phase3-adapter'
import { boundary } from './postgres-adapter'
import { OWNER, digest, usableCandidates } from '../../src/lib/free-api-worker/model'
import { Network } from '../../src/lib/free-api-worker/network'
import { databaseStore, tick } from '../../src/lib/free-api-worker/runtime'
import { groq } from '../../src/lib/groq'
import { POST as failedAction } from '../../src/app/api/admin/free-api-worker/failed/route'
import { GET as status } from '../../src/app/api/admin/free-api-worker/status/route'
import { POST as remove } from '../../src/app/api/admin/free-api-worker/remove/route'
import { POST as control } from '../../src/app/api/admin/free-api-worker/control/route'
import { POST as createBatch } from '../../src/app/api/admin/free-api-worker/batches/route'
import { POST as advance } from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import { POST as legacyBulk } from '../../src/app/api/admin/free-api-worker/list/route'
import { verifyFailedBrowser } from './failed-browser'

reset(); process.env.ADMIN_WALLETS=OWNER; process.env.GROQ_API_KEY='offline-fixture'
const headers=sessionHeaders({...alice,address:OWNER})
const req=(path:string,body?:unknown,auth:Record<string,string>=headers)=>new NextRequest(origin+path,{method:body===undefined?'GET':'POST',headers:{...auth,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
const quote=(v:unknown)=>"'"+(typeof v==='string'?v:JSON.stringify(v)).replace(/'/g,"''")+"'"
const failing=new Set<string>(), modelCalls=new Map<string,number>()
;(groq.chat.completions as any).create=async(params:any)=>{
 const host=/https:\/\/([a-z0-9]+)\.example\.org/.exec(params.messages[1].content)![1]
 modelCalls.set(host,(modelCalls.get(host)??0)+1)
 if(failing.has(host))throw Error('Synthetic Groq outage')
 return {choices:[{message:{content:JSON.stringify({score:8,suggested_price:.001,approved:true,critical_issues:[],warnings:[],positives:['Functional data'],summary:'Fixture review',suggestions:{category:'Data'}})}}]}
}
export function candidate(name:string){
 const id=digest('failed:'+name),base=`https://${name}.example.org`,endpoint=base+'/data'
 const lead={id,providerId:name+'.example.org',name,description:'Book search API',docs:base+'/docs',sources:[],auth:'none' as const}
 const result={technical:'PASSED',freeAccess:'VERIFIED',permission:'UNKNOWN',termsChecked:true,endpoint,docs:lead.docs,lastSuccess:'2026-10-28T00:00:00Z',reason:'validated',retryAt:null,evidence:[{url:lead.docs,sha256:digest(name),note:'Previous terms',checkedAt:'2026-10-28T00:00:00Z'}],tests:[{url:endpoint,status:200,reason:'Functional books',sha256:digest(name)}]}
 sql(`INSERT INTO free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at) VALUES(${quote(id)},${quote(lead.providerId)},${quote(name)},${quote(lead.docs)},${quote(lead)},${quote(result)},now())`)
 outbound.responses.set(base+'/robots.txt',{status:404,body:''})
 outbound.responses.set(lead.docs,{status:200,body:`<p>Book search API</p><pre>GET ${endpoint}</pre>`})
 outbound.responses.set(base+'/',{status:200,body:'Book search API'})
 return {id,name,base,endpoint,lead,result}
}
const row=(id:string)=>JSON.parse(sql(`SELECT row_to_json(t) FROM free_worker_apis t WHERE id=${quote(id)}`))
const listing=(id:string)=>JSON.parse(sql(`SELECT row_to_json(t) FROM api_listings t WHERE free_worker_candidate_id=${quote(id)}`)||'null')
async function action(action:string,ids:string[],auth:Record<string,string>=headers,confirmed=true){return failedAction(req('/api/admin/free-api-worker/failed',{action,ids,confirmed},auth))}
async function move(ids:string[]){const r=await action('move',ids);assert.equal(r.status,200,await r.clone().text());return r.json()}
async function recheck(id:string){const r=await action('recheck',[id]);assert.equal(r.status,200,await r.clone().text());return r.json()}
async function view(name:string){const r=await status(req('/api/admin/free-api-worker/status?view='+name));assert.equal(r.status,200);return r.json()}
async function batch(ids:string[]){const r=await createBatch(req('/api/admin/free-api-worker/batches',{id:randomUUID(),ids,mode:'PAID',price:.001,confirmed:true,owner_rights_confirmed:true}));assert.equal(r.status,201,await r.clone().text());return (await r.json()).batch}
async function step(id:string,action='next'){const r=await advance(req('/api/admin/free-api-worker/batches/'+id,{action}),{params:Promise.resolve({id})});assert.equal(r.status,200,await r.clone().text());return (await r.json()).batch}
let cases=0;function pass(s:string){cases++;console.log('PASS',s)}
async function main(){
 sql(`INSERT INTO api_listings(id,name,description,category,endpoint_url,price_per_call,payment_model,is_active,seller_wallet,auth_type) VALUES('11111111-1111-4111-8111-111111111111','Existing published fixture','Existing product','Data','https://existing.example.org/books',0.001,'pay-per-call',true,'${OWNER}','public'); INSERT INTO purchases(buyer_wallet,api_id,amount_usdc,tx_hash,seller_share_usdc) VALUES('0x1111111111111111111111111111111111111111','11111111-1111-4111-8111-111111111111',0.0011,'isolated-record-only',0.001);`)
 const protectedSnapshot=()=>sql("SELECT md5(jsonb_build_object('product',(SELECT to_jsonb(t) FROM api_listings t WHERE id='11111111-1111-4111-8111-111111111111'),'purchases',(SELECT jsonb_agg(to_jsonb(t)) FROM purchases t),'calls',(SELECT jsonb_agg(to_jsonb(t)) FROM api_calls t),'settlements',(SELECT jsonb_agg(to_jsonb(t)) FROM x402_settlement_attempts t))::text)")
 const preserved=protectedSnapshot()
 const a=candidate('retrygroq');failing.add(a.name);let b=await batch([a.id])
 for(let i=0;i<4;i++){if(i)await step(b.id,'retry_failed');b=await step(b.id);assert.equal(b.items[0].status,'failed');assert.equal(row(a.id).manual_failed_at,null);assert((await view('usable')).candidates.some((x:any)=>x.lead.id===a.id))}
 assert.equal(modelCalls.get(a.name),4);assert.equal((await view('failed')).total,0)
 const draft=listing(a.id),before=row(a.id)
 pass('Four failed Bulk List attempts remain Ready; no threshold or automatic Failed classification')
 assert.equal((await action('move',[a.id],headers,false)).status,400)
 assert.equal((await action('move',[a.id],{origin})).status,401)
 assert.equal((await action('move',[a.id],sessionHeaders(bob))).status,403)
 assert.equal((await action('move',[a.id],{...headers,origin:'https://hostile.example.org'})).status,403)
 assert.equal(row(a.id).manual_failed_at,null)
 pass('Only explicitly confirmed owner Admin actions can move candidates')
 assert.equal((await move([a.id])).moved,1);assert.equal((await move([a.id])).moved,0)
 assert(row(a.id).manual_failed_at);assert.match(row(a.id).failure_reason,/Groq/)
 assert.deepEqual(row(a.id).result,before.result);assert.deepEqual(listing(a.id),draft)
 assert.equal((await view('usable')).total,0);assert.equal((await view('failed')).total,1)
 pass('Single move is durable and idempotent; draft, endpoint, original evidence and latest Bulk List error survive reload')
 const x=candidate('brokenendpoint'),y=candidate('authrequired'),z=candidate('prohibited')
 assert.equal((await move([x.id,y.id,z.id])).moved,3)
 assert.equal((await view('failed')).total,4)
 const store=await databaseStore()
 const admitted=sql('SELECT count(*) FROM free_worker_apis')
 await store.admit([{...x.lead,id:digest('alias'),name:'Same endpoint alias',docs:x.lead.docs,endpoints:[x.endpoint]}])
 assert.equal(sql('SELECT count(*) FROM free_worker_apis'),admitted)
 sql(`UPDATE free_worker_apis SET completed_at=NULL WHERE id=${quote(x.id)}`)
 const start=await control(req('/api/admin/free-api-worker/control',{action:'start'}));assert.equal(start.status,202)
 let current=await store.state();assert.equal(current.status,'running');assert.deepEqual(await store.claim(current.generation),[])
 assert.equal((await control(req('/api/admin/free-api-worker/control',{action:'stop'}))).status,202)
 assert.equal((await control(req('/api/admin/free-api-worker/control',{action:'resume'}))).status,202)
 current=await store.state();assert.equal(current.status,'running');assert.deepEqual(await store.claim(current.generation),[])
 await control(req('/api/admin/free-api-worker/control',{action:'stop'}))
 assert.equal(boundary.starts,2)
 pass('Multi-move, identity admission and normal Start/Stop/Resume preserve manual separation; no automatic claim')
 const freshName='normalnewbooks',freshDocs='https://normalnewbooks.example.org/docs',freshEndpoint='https://normalnewbooks.example.org/books'
 const source={id:'fixture',name:'Synthetic source',url:'https://source.example.org/catalog',kind:'markdown' as const}
 const sourceNetwork=new Network(async input=>{
  const url=String(input)
  if(url.endsWith('/robots.txt'))return new Response('',{status:404})
  if(url===source.url)return new Response(`| [${freshName}](${freshDocs}) | Book search API | No |`,{headers:{'content-type':'text/plain'}})
  if(url===freshDocs)return new Response(`<pre>GET ${freshEndpoint}</pre>`,{headers:{'content-type':'text/html'}})
  if(url===freshEndpoint)return Response.json({books:[{title:'New fixture'}]})
  return new Response('Book service',{headers:{'content-type':'text/html'}})
 })
 current=await store.control('start');await tick(store,current.generation,sourceNetwork,[source]);await store.control('stop')
 assert.equal(sql(`SELECT count(*) FROM free_worker_apis WHERE name='${freshName}' AND result->>'technical'='PASSED'`),'1')
 assert(row(x.id).manual_failed_at);assert.equal(row(x.id).attempts,0)
 pass('Normal Start still admits and validates new APIs from a synthetic source without touching manually Failed candidates')

 // Re-evaluate a broken endpoint from saved official documentation using the real resolver and validator.
 outbound.responses.set(x.lead.docs,{status:200,body:`<p>Current Book search API</p><pre>GET ${x.base}/v2/books</pre>`})
 outbound.responses.set(x.endpoint,{status:404,body:'not found'})
 assert.equal((await recheck(x.id)).recovered,true)
 assert.equal(row(x.id).result.endpoint,x.base+'/v2/books');assert.equal(listing(x.id),null)
 assert(row(x.id).failure_history.some((e:any)=>e.event==='manual_move'&&e.result.endpoint===x.endpoint))
 assert((await view('usable')).candidates.some((v:any)=>v.lead.id===x.id))
 pass('Recheck follows official documentation to a working endpoint, restores Ready and preserves previous evidence without creating a draft')
 outbound.responses.set(y.lead.docs,{status:200,body:`<p>An API key is required.</p><pre>GET ${y.endpoint}</pre>`})
 const authCalls=outbound.calls.get(y.endpoint)??0
 assert.equal((await recheck(y.id)).recovered,false);assert.equal(outbound.calls.get(y.endpoint)??0,authCalls)
 assert.match(row(y.id).failure_reason,/Authentication/);assert(row(y.id).manual_failed_at)
 outbound.responses.set(z.lead.docs,{status:200,body:`<p>You must not resell access to this API service.</p><pre>GET ${z.endpoint}</pre>`})
 assert.equal((await recheck(z.id)).recovered,false);assert.equal(row(z.id).recheck_result.validation.permission,'PROHIBITED')
 assert(row(z.id).manual_failed_at);assert.equal(row(z.id).result.permission,'UNKNOWN','old evidence retained')
 pass('Authentication and commercial restrictions remain enforced; unresolved candidates retain updated reasons and old evidence')
 failing.delete(a.name)
 const outcome=await recheck(a.id);assert.equal(outcome.recovered,true,JSON.stringify(outcome))
 assert.equal(listing(a.id).id,draft.id);assert.equal(listing(a.id).is_active,false);assert.equal(Number(listing(a.id).score),8);assert.equal(listing(a.id).category,'Data')
 assert(listing(a.id).free_worker_review.approved);assert.equal(modelCalls.get(a.name),5)
 await step(b.id,'retry_failed');await step(b.id)
 assert.equal(listing(a.id).is_active,true);assert.equal(modelCalls.get(a.name),5,'Bulk reuses successful Recheck Seller analysis')
 await step(b.id);assert.equal(sql(`SELECT count(*) FROM api_listings WHERE free_worker_candidate_id=${quote(a.id)}`),'1')
 assert.equal((await action('move',[a.id])).status,409);assert.equal((await action('recheck',[a.id])).status,409)
 pass('Actual Seller/Groq analysis recovers existing draft; later explicitly authorized fixture publication reuses review exactly once')
 const hold=candidate('holdpublication');failing.add(hold.name);const hb=await batch([hold.id]);await step(hb.id);await move([hold.id])
 await step(hb.id,'retry_failed');const held=await step(hb.id);assert.equal(held.items[0].status,'failed');assert.equal(listing(hold.id).is_active,false)
 const legacy=await legacyBulk(req('/api/admin/free-api-worker/list',{ids:[hold.id],mode:'PAID',price:.001,owner_rights_confirmed:true,confirmed:true}));assert.equal((await legacy.json()).published,0)
 assert.throws(()=>sql(`UPDATE api_listings SET is_active=true WHERE free_worker_candidate_id=${quote(hold.id)}`),/held in Failed APIs/)
 pass('Failed hold blocks both new/legacy Bulk List and direct activation; existing draft remains inactive')
 outbound.responses.set(hold.lead.docs,{status:200,body:`<pre>GET ${hold.base}/new/books</pre>`})
 assert.equal((await recheck(hold.id)).recovered,true);assert.match(row(hold.id).failure_reason,/saved draft is unchanged/)
 assert.equal(listing(hold.id).endpoint_url,hold.endpoint);assert.equal(row(hold.id).result.endpoint,hold.base+'/new/books')
 await step(hb.id,'retry_failed');assert.equal((await step(hb.id)).items[0].status,'failed','old batch authorization cannot apply to a new endpoint')
 assert.equal(listing(hold.id).is_active,false)
 assert.throws(()=>sql(`UPDATE api_listings SET endpoint_url=${quote(row(hold.id).result.endpoint)} WHERE free_worker_candidate_id=${quote(hold.id)}`),/owner confirmation/)
 pass('Changed endpoint returns candidate to Ready but preserves the draft; old publication authorization and old paid rights cannot authorize the new endpoint')
 const duplicate=candidate('duplicateendpoint');await move([duplicate.id])
 outbound.responses.set(duplicate.lead.docs,{status:200,body:`<pre>GET ${a.endpoint}</pre>`})
 assert.equal((await recheck(duplicate.id)).recovered,false);assert.match(row(duplicate.id).failure_reason,/duplicate|existing candidate/)
 pass('Recovery cannot duplicate an already published endpoint')
 const marketplaceAlias=candidate('marketplacealias')
 sql(`UPDATE free_worker_apis SET result=jsonb_set(result,'{endpoint}','"https://existing.example.org/books"') WHERE id=${quote(marketplaceAlias.id)}`)
 assert.match(row(marketplaceAlias.id).lead.duplicateOf,/^marketplace:/)
 assert(!usableCandidates(await store.candidates()).some(c=>c.lead.id===marketplaceAlias.id))
 const readyAlias={...x.lead,id:digest('readyalias'),name:'Ready alias',endpoints:[row(x.id).result.endpoint]}
 await store.admit([readyAlias]);assert.equal(sql(`SELECT count(*) FROM free_worker_apis WHERE id=${quote(readyAlias.id)}`),'0')
 pass('Normal identity handling suppresses existing Ready and Marketplace endpoints as well as manually Failed records')

 const lease=candidate('interruptedrecheck');await move([lease.id])
 const claim=JSON.parse(sql(`SELECT free_worker_failed_begin(${quote(lease.id)},'${OWNER}')`))
 assert.equal((await action('recheck',[lease.id])).status,409)
 assert.equal(sql(`SELECT free_worker_failed_finish(${quote(lease.id)},'${OWNER}','00000000-0000-4000-8000-000000000000','{}',false,'stale')`),'f')
 sql(`UPDATE free_worker_apis SET recheck_until=now()-interval '1 second' WHERE id=${quote(lease.id)}`)
 const callsBefore=outbound.calls.size;await view('failed');assert.equal(outbound.calls.size,callsBefore)
 assert.equal((await recheck(lease.id)).recovered,true)
 assert.equal(sql(`SELECT free_worker_failed_finish(${quote(lease.id)},'${OWNER}','${claim.recheck_token}','{}',false,'stale')`),'f')
 pass('Concurrent and stale rechecks are fenced; interruption retains Failed state and requires another explicit action')
 const removal=await remove(req('/api/admin/free-api-worker/remove',{ids:[y.id,z.id],confirmed:true}));assert.equal(removal.status,200);assert.equal((await removal.json()).removed,2)
 assert(row(y.id).removed_at);assert(row(y.id).failure_history.length);assert(!(await view('failed')).candidates.some((v:any)=>v.lead.id===y.id))
 await store.admit([{...y.lead,id:digest('removedalias'),endpoints:[y.endpoint]}]);assert.equal(sql(`SELECT count(*) FROM free_worker_apis WHERE id=${quote(digest('removedalias'))}`),'0')
 pass('Remove Selected works for unresolved Failed candidates and preserves tombstones/history')
 for(const role of ['anon','authenticated'])assert.throws(()=>sql(`BEGIN;SET LOCAL ROLE ${role};SELECT free_worker_failed_move(ARRAY[${quote(x.id)}],'${OWNER}',true);ROLLBACK;`),/permission denied/)
 assert.equal(protectedSnapshot(),preserved);assert.equal(outbound.paidCalls,0)
 pass('Service-only RPCs, existing Marketplace product and financial records preserved; no payment call')
 const canonical=candidate('canonicalrecovery'),alias=candidate('canonicalalias')
 sql(`UPDATE free_worker_apis SET result=jsonb_set(result,'{endpoint}',${quote(JSON.stringify(canonical.endpoint))}::jsonb) WHERE id=${quote(alias.id)}`)
 assert.equal(row(alias.id).lead.duplicateOf,canonical.id)
 await move([canonical.id]);assert.equal((await recheck(canonical.id)).recovered,true)
 pass('Historical aliases of the same canonical candidate do not block valid recovery')
 const inflight=candidate('inflightmove'),ib=await batch([inflight.id])
 const claimed=JSON.parse(sql(`SELECT free_worker_bulk_claim('${ib.id}','${OWNER}')`))
 assert.equal((await action('move',[inflight.id])).status,409);assert.equal(row(inflight.id).manual_failed_at,null)
 sql(`UPDATE free_worker_bulk_items SET lease_until=now()-interval '1 second' WHERE batch_id='${ib.id}'`)
 await move([inflight.id]);await step(ib.id);assert.equal(listing(inflight.id),null)
 assert.equal(sql(`SELECT free_worker_bulk_finish('${ib.id}','${OWNER}',${quote(inflight.id)},'${claimed.lease_token}','published')`),'f')
 pass('Move refuses in-flight Bulk List; expired requests cannot publish a manually held candidate')
 const cached=candidate('cachedreview'),cb=await batch([cached.id])
 sql(`CREATE FUNCTION test_block_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.free_worker_candidate_id='${cached.id}' AND NEW.is_active THEN RAISE EXCEPTION 'fixture activation unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_block_activation BEFORE UPDATE ON api_listings FOR EACH ROW EXECUTE FUNCTION test_block_activation();`)
 await step(cb.id);assert.equal(listing(cached.id).is_active,false);assert(listing(cached.id).free_worker_review.approved)
 sql('DROP TRIGGER test_block_activation ON api_listings; DROP FUNCTION test_block_activation();')
 const scored=modelCalls.get(cached.name);await move([cached.id]);assert.equal((await recheck(cached.id)).recovered,true)
 assert.equal(modelCalls.get(cached.name),scored);assert.equal(listing(cached.id).is_active,false)
 pass('Recheck reuses an approved persisted Seller review after activation failure and never activates the draft')
 assert.equal(protectedSnapshot(),preserved);assert.equal(outbound.paidCalls,0)

 if(process.env.FREE_WORKER_PLAYWRIGHT_MODULE)await verifyFailedBrowser(candidate,outbound)
 console.log(`PASS ${cases} manual Failed APIs PostgreSQL/Worker/Seller scenarios`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
