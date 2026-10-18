import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverySourceCatalog, sourceCatalogUrl } from '../../src/lib/admin-worker/discovery/sources/catalog'
import { discoverySourceAdapters, type DiscoverySourceId, type DiscoverySourceState } from '../../src/lib/admin-worker/discovery/sources/adapter'
import { parseMarkdownCatalog, apifyCatalog, resolveApifyProvider } from '../../src/lib/admin-worker/discovery/sources/open-catalogs'
import { discoverMultiSourceRange } from '../../src/lib/admin-worker/discovery/multi-source'
import { sourceState, type DiscoverySourceStore, type SourceObservation } from '../../src/lib/admin-worker/discovery/source-repository'
import { WorkerMailInfrastructureError } from '../../src/lib/admin-worker/discovery/provider-history'
import { processDiscoveryCandidate } from '../../src/lib/admin-worker/discovery/processor'
import type { DurableCandidate } from '../../src/lib/admin-worker/discovery/types'
import { recoverPendingEmails } from '../../src/lib/admin-worker/discovery/repository'
import { boundary } from '../admin/fixture'

const active = ['apis_guru', 'public_api_lists', 'github_public_apis', 'public_apis_dev', 'apify_store']
function harness() {
  let batch = 1, now = Date.now(), running = true, known = false, loseObservation = false, quota = false
  const states = new Map<DiscoverySourceId, DiscoverySourceState>(discoverySourceAdapters.map(a => [a.id, { sourceId:a.id,version:0,
    snapshot:{entries:[],cursor:0,revision:null,fetchedAt:null,refreshAfter:null,retryAfter:null,failures:0} }]))
  const work = new Map<string, unknown>(); const requests: string[] = []; const observed: SourceObservation[] = []
  const store: DiscoverySourceStore = {
    read:async id => structuredClone(states.get(id)!), running:async () => running,
    update:async (state,snapshot) => { assert.equal(states.get(state.sourceId)!.version,state.version)
      if (!running) return null
      const saved={...state,version:state.version+1,snapshot};states.set(state.sourceId,structuredClone(saved));return saved },
    observe:async (state,result) => {
      if (!running) return null
      assert.equal(states.get(state.sourceId)!.version,state.version)
      states.set(state.sourceId,{...state,version:state.version+1,snapshot:{...state.snapshot,cursor:state.snapshot.cursor+1}})
      work.set(`${batch}:candidate:${result.ordinal}`,structuredClone(result));observed.push(result)
      if (loseObservation) {loseObservation=false;throw new WorkerMailInfrastructureError('lost_response')}
      return result
    },
    request:async key => {if(quota&&key.includes(':apify_store:'))throw new Error('discovery_source_request_limit');return true},
  }
  const input=(end=10)=>({rootRunNumber:batch,start:0,end,sourceStore:store,now:()=>now,deadlineMs:now+60_000,
    loadSourceWork:async(key:string)=>work.get(`${batch}:${key}`)??null,
    materializeSourceWork:async(key:string,_kind:unknown,value:unknown)=>{work.set(`${batch}:${key}`,structuredClone(value));return value},
    providerHistory:async(domains:string[])=>known?domains.map(domain=>({domain,providerId:null,reason:'manual_mail_pending'})):[],
    prioritizeProviders:async(domains:string[])=>domains,
    fetcher:async(url:string)=>{
      requests.push(url)
      if(url.startsWith('https://api.apify.com/v2/store')){
        const offset=Number(new URL(url).searchParams.get('offset'))
        return {url,status:200,contentType:'application/json',body:JSON.stringify({data:{offset,total:60,count:20,
          items:Array.from({length:20},(_,i)=>({id:`actor${offset+i}`,username:'acme',name:`api${offset+i}`,title:`API ${offset+i}`}))}})}
      }
      if(url==='https://api.apify.com/v2/users/acme')return {url,status:200,contentType:'application/json',body:JSON.stringify({data:{username:'acme',profile:{websiteUrl:'https://docs.acme.com/'}}})}
      if(url.endsWith('providers.json'))return {url,status:200,contentType:'application/json',body:JSON.stringify({data:['acme.com','other.example','third.example']})}
      if(url.includes('api.apis.guru'))return {url,status:200,contentType:'application/json',body:JSON.stringify({apis:{weather:{info:{title:'Acme API'},swaggerUrl:'https://acme.com/openapi.json',openapi:'3.0.0'}}})}
      if(url===sourceCatalogUrl('public_api_lists'))return {url,status:200,contentType:'application/json',body:JSON.stringify({entries:[{name:'Acme API',url:'https://acme.com/docs'},{name:'Other API',url:'https://other.example/docs'},{name:'Third API',url:'https://third.example/docs'}]})}
      assert.ok(url===sourceCatalogUrl('github_public_apis')||url===sourceCatalogUrl('public_apis_dev'))
      return {url,status:200,contentType:'text/plain',body:'| [Acme API](https://api.acme.com/docs) | Acme |\n| [Other API](https://other.example/docs) | Other |\n| [Third API](https://third.example/docs) | Third |'}
    },
  })
  return {input,store,states,requests,observed,work,
    next:()=>{batch++;running=true},stop:()=>{running=false},resume:()=>{running=true},
    known:()=>{known=true},lose:()=>{loseObservation=true},quota:()=>{quota=true},advance:()=>{now+=24*3600_000+1}}
}

test('all fifteen sources have explicit access status; only five approved adapters can dispatch',()=>{
  assert.equal(discoverySourceCatalog.length,15)
  assert.equal(new Set(discoverySourceCatalog.map(s=>s.id)).size,15)
  assert.deepEqual(discoverySourceAdapters.map(a=>a.id),active)
  assert.deepEqual(discoverySourceCatalog.filter(s=>s.status==='ACTIVE-READY').map(s=>s.id),active)
  for(const source of discoverySourceCatalog.filter(s=>s.status!=='ACTIVE-READY'))assert.throws(()=>sourceCatalogUrl(source.id),/not_authorized/)
})

test('both MIT Markdown parsers reject shared hosts and unsafe URLs without inventing contract/contact evidence',()=>{
  const entries=parseMarkdownCatalog('| [Weather](https://api.acme.com/docs) | JSON API |\n| [Weather](https://api.acme.com/docs) | duplicate |\n| [Tool](https://apify.com/a/b) | Actor |\n| [Bad](https://127.0.0.1) | bad |\n| [Wrong](http://plain.example) | insecure |')
  assert.equal(entries.length,1);assert.equal(entries[0].domain,'acme.com')
  assert.equal('candidate' in entries[0],false)
  assert.throws(()=>parseMarkdownCatalog('<html>catalog</html>'),/invalid/)
})

test('every enabled adapter uses fair shared dispatch and independent cached progress across Starts',async()=>{
  const h=harness();const first=await discoverMultiSourceRange(h.input())
  assert.deepEqual(first.items.map(i=>i.candidate?.sourceId),[...active,...active])
  const revision=h.states.get('github_public_apis')!.snapshot.revision
  h.next();const next=await discoverMultiSourceRange(h.input(5))
  assert.equal(next.items[0].candidate?.sourceId,'public_api_lists')
  assert.equal(h.states.get('github_public_apis')!.snapshot.revision,revision)
  for(const id of ['github_public_apis','public_apis_dev','public_api_lists'] as const)assert.equal(h.requests.filter(url=>url===sourceCatalogUrl(id)).length,1)
})

test('cross-portal finalized identity observations skip APIs.guru details and all expensive processing',async()=>{
  const h=harness();h.known();const result=await discoverMultiSourceRange(h.input(5))
  assert.ok(result.items.every(i=>i.candidate===null&&i.reasonCode==='provider_identity_processed'))
  assert.ok(!h.requests.some(url=>url.endsWith('/acme.com.json')))
  let expensive=0
  for(const sourceId of active){
    const candidate:DurableCandidate={id:sourceId,discoveryBatchId:'batch',ordinal:0,sourceType:'api_directory',sourceId:sourceId as DiscoverySourceId,
      sourceUrl:sourceCatalogUrl(sourceId as DiscoverySourceId),discoveredName:'Acme',discoveredDomain:'acme.com',discoveredProduct:'Weather API',
      normalizedDomain:null,normalizedProductKey:null,status:'pending',reasonCode:null,providerId:null,productId:null,leadId:null,
      retryAfter:null,processingLeaseId:null,processingLeaseExpiresAt:null}
    const outcome=await processDiscoveryCandidate('run',candidate,Date.now()+60_000,{
      preflightCandidate:async()=>({action:'duplicate',reasonCode:'provider_already_processed'}),markDiscoveryCandidate:async()=>{},
      researchCandidate:async()=>{expensive++;throw Error('forbidden')},claimDiscoveryBudget:async()=>{expensive++;return 'claimed'},
    })
    assert.equal(outcome.status,'duplicate')
  }
  assert.equal(expensive,0)
})

test('Apify pages persist across Starts; Resume reuses accepted observations and Stop makes no request',async()=>{
  const h=harness();const input=()=>({...h.input(20),adapters:discoverySourceAdapters.filter(a=>a.id==='apify_store')})
  h.lose();await assert.rejects(discoverMultiSourceRange(input()),/lost_response/)
  const calls=h.requests.length;await discoverMultiSourceRange({...input(),end:1});assert.equal(h.requests.length,calls)
  await discoverMultiSourceRange(input());assert.equal(h.states.get('apify_store')!.snapshot.nextPage,'20')
  h.next();await discoverMultiSourceRange(input());assert.equal(h.states.get('apify_store')!.snapshot.nextPage,'40')
  h.next();await discoverMultiSourceRange(input());assert.equal(h.states.get('apify_store')!.snapshot.nextPage,null)
  h.next();assert.equal((await discoverMultiSourceRange(input())).sourceExhausted,true)
  assert.deepEqual(h.requests.filter(u=>u.includes('/store?')).map(u=>new URL(u).searchParams.get('offset')),['0','20','40'])
  h.stop();const before=h.requests.length;await discoverMultiSourceRange(input());assert.equal(h.requests.length,before)
  assert.equal(h.observed.length,60)
})

test('source request caps isolate a source and preserve healthy sources and global limits',async()=>{
  const h=harness();h.quota();const result=await discoverMultiSourceRange(h.input())
  assert.ok(result.items.length>0)
  assert.ok(result.items.every(i=>i.candidate?.sourceId!=='apify_store'))
  assert.equal(h.states.get('apify_store')!.snapshot.cursor,0)
  assert.ok(h.states.get('apify_store')!.snapshot.retryAfter)
})

test('Actor marketplace identity, mismatched publishers and executable URLs never become provider evidence',async()=>{
  const entry={id:'actor',domain:'',publisher:'acme',title:'Actor'}
  const resolved=await resolveApifyProvider(entry,async url=>({url,status:200,contentType:'application/json',body:JSON.stringify({data:{username:'acme',profile:{websiteUrl:'https://apify.com/acme'}}})}))
  assert.equal(resolved.domain,'')
  await assert.rejects(resolveApifyProvider(entry,async url=>({url,status:200,contentType:'application/json',body:JSON.stringify({data:{username:'unrelated'}})})),/mismatch/)
  await assert.rejects(apifyCatalog(async()=>{throw Error('must not dispatch')},'https://evil.example/runs'),/page_invalid/)
  const h=harness();await discoverMultiSourceRange(h.input())
  assert.ok(h.requests.every(url=>!/(\/runs|run-sync|\/tasks|\/subscriptions|token=)/.test(url)))
  assert.throws(()=>sourceState({sourceId:'apify_store',version:0,snapshot:{entries:[],cursor:0,failures:0,revision:null,fetchedAt:null,refreshAfter:null,retryAfter:null,nextPage:'https://evil.example'}}),/invalid/)
})

test('missing recipient/source schema fails before reconciliation or candidate processing',async()=>{
  const calls:string[]=[]
  boundary.rpcOverride=async name=>{calls.push(name);return {data:false,error:null}}
  try {await assert.rejects(recoverPendingEmails('run'),/worker_discovery_schema_unavailable/)
    assert.deepEqual(calls,['mahshar_worker_discovery_ready'])
  } finally {boundary.rpcOverride=null}
})

function apifyPage(offset:number,total:number,returned?:number) {
  const count=Math.min(20,Math.max(0,total-offset))
  return {data:{offset,total,limit:20,desc:false,count,
    items:Array.from({length:returned??count},(_,i)=>({id:`actor${offset+i}`,username:'acme',title:`API ${offset+i}`}))}}
}

function apifyInput(h:ReturnType<typeof harness>,total:number,page=(offset:number)=>apifyPage(offset,total)) {
  const base=h.input(20)
  return {...base,adapters:discoverySourceAdapters.filter(a=>a.id==='apify_store'),fetcher:async(url:string)=>{
    if(!url.startsWith(sourceCatalogUrl('apify_store')+'?'))return base.fetcher(url)
    const query=new URL(url).searchParams
    assert.equal(query.get('includeUnrunnableActors'),'true')
    assert.equal(query.get('limit'),'20');assert.equal(query.get('sortBy'),'newest')
    return {url,status:200,contentType:'application/json',body:JSON.stringify(page(Number(query.get('offset'))))}
  }}
}

test('Apify requests complete metadata instead of accepting the exact twenty-count seventeen-item filtered response',async()=>{
  const requests:string[]=[]
  const page=await apifyCatalog(async url=>{
    requests.push(url)
    const includeAll=new URL(url).searchParams.get('includeUnrunnableActors')==='true'
    return {url,status:200,contentType:'application/json',body:JSON.stringify(apifyPage(0,45,includeAll?20:17))}
  })
  assert.equal(requests.length,1)
  assert.equal(page.entries.length,20);assert.equal(page.nextPage,'20')
  assert.ok(page.entries.every(entry=>entry.domain===''&&!('candidate' in entry)))
  assert.ok(!/(\/runs|run-sync|\/tasks|\/subscriptions|token=)/.test(requests[0]))
})

test('Apify still rejects count mismatches and invalid Actor identities with the complete-catalog option',async()=>{
  const mismatch=apifyPage(0,45,17)
  const invalidId=apifyPage(0,1);invalidId.data.items[0].id='actor/execute'
  const invalidPublisher=apifyPage(0,1);invalidPublisher.data.items[0].username='../other'
  for(const response of [mismatch,invalidId,invalidPublisher]) {
    await assert.rejects(apifyCatalog(async url=>({url,status:200,contentType:'application/json',body:JSON.stringify(response)})),/apify_catalog_invalid/)
  }
})

test('Apify accepts dotted publishers only as bounded identities and still verifies the exact public profile',async()=>{
  const response=apifyPage(0,1);response.data.items[0].username='acme.api'
  const page=await apifyCatalog(async url=>({url,status:200,contentType:'application/json',body:JSON.stringify(response)}))
  assert.equal(page.entries[0].publisher,'acme.api');assert.equal(page.entries[0].domain,'')
  const resolved=await resolveApifyProvider(page.entries[0],async url=>{
    assert.equal(url,'https://api.apify.com/v2/users/acme.api')
    return {url,status:200,contentType:'application/json',body:JSON.stringify({data:{username:'acme.api',profile:{websiteUrl:'https://docs.acme.com/'}}})}
  })
  assert.equal(resolved.domain,'acme.com')
  await assert.rejects(resolveApifyProvider(page.entries[0],async url=>({url,status:200,contentType:'application/json',body:JSON.stringify({data:{username:'acme_api'}})})),/apify_publisher_mismatch/)
  for(const publisher of ['.','..','../acme','a/b','a\\b','a?query','a#fragment','%2e%2e','https://evil.example','a'.repeat(101)]) {
    response.data.items[0].username=publisher
    await assert.rejects(apifyCatalog(async url=>({url,status:200,contentType:'application/json',body:JSON.stringify(response)})),/apify_catalog_invalid/)
    await assert.rejects(resolveApifyProvider({...page.entries[0],publisher},async()=>{throw Error('must not dispatch')}),/apify_publisher_invalid/)
  }
})

test('Apify validates short final pages and empty terminal pages without inventing a next cursor',async()=>{
  for(const [offset,total,expected] of [[20,37,17],[20,20,0],[0,0,0]]) {
    const result=await apifyCatalog(async url=>({url,status:200,contentType:'application/json',body:JSON.stringify(apifyPage(offset,total))}),String(offset))
    assert.equal(result.entries.length,expected);assert.equal(result.nextPage,null)
  }
})

test('Apify rejects nonterminal empty pages, wrong offsets and impossible totals',async()=>{
  const empty=apifyPage(20,40,0);empty.data.count=0
  await assert.rejects(apifyCatalog(async url=>({url,status:200,contentType:'application/json',body:JSON.stringify(empty)}),'20'),/apify_catalog_no_progress/)
  const wrongOffset=apifyPage(0,40)
  const impossible=apifyPage(20,40);impossible.data.total=21
  for(const response of [wrongOffset,impossible]) {
    await assert.rejects(apifyCatalog(async url=>({url,status:200,contentType:'application/json',body:JSON.stringify(response)}),'20'),/apify_catalog_invalid/)
  }
})

test('Apify continuation consumes every returned identity exactly once across twenty, twenty and five item pages',async()=>{
  const h=harness();const pages:number[]=[]
  const input=()=>apifyInput(h,45,offset=>{pages.push(offset);return apifyPage(offset,45)})
  const ids:string[]=[]
  for(let batch=0;batch<3;batch++) {
    if(batch)h.next()
    const result=await discoverMultiSourceRange(input())
    ids.push(...result.items.map(item=>item.candidate!.sourceRecordId!))
    assert.equal(h.states.get('apify_store')!.snapshot.nextPage,batch===2?null:String((batch+1)*20))
  }
  assert.deepEqual(pages,[0,20,40]);assert.equal(ids.length,45);assert.equal(new Set(ids).size,45)
  assert.deepEqual(ids,Array.from({length:45},(_,i)=>`actor${i}`))
  h.next();assert.equal((await discoverMultiSourceRange(input())).sourceExhausted,true)
  assert.deepEqual(pages,[0,20,40])
})

test('Apify empty nonterminal pages retain the durable frontier and recover after cooldown',async()=>{
  const h=harness();let empty=true;const pages:number[]=[]
  const input=()=>apifyInput(h,40,offset=>{
    pages.push(offset)
    const page=apifyPage(offset,40,offset===20&&empty?0:undefined)
    if(offset===20&&empty)page.data.count=0
    return page
  })
  await discoverMultiSourceRange(input());h.next()
  assert.equal((await discoverMultiSourceRange(input())).items.length,0)
  const held=h.states.get('apify_store')!.snapshot
  assert.equal(held.cursor,20);assert.equal(held.nextPage,'20');assert.equal(held.entries[0].id,'actor0')
  assert.ok(held.retryAfter)
  h.next();assert.equal((await discoverMultiSourceRange(input())).items.length,0)
  assert.deepEqual(pages,[0,20])
  empty=false;h.advance();h.next()
  const recovered=await discoverMultiSourceRange(input())
  assert.deepEqual(recovered.items.map(item=>item.candidate!.sourceRecordId),Array.from({length:20},(_,i)=>`actor${20+i}`))
  assert.deepEqual(pages,[0,20,20]);assert.equal(h.states.get('apify_store')!.snapshot.nextPage,null)
})

test('Apify interrupted page acceptance resumes the persisted observation and preserves Stop without skipping a page',async()=>{
  const h=harness();const pages:number[]=[]
  const input=()=>apifyInput(h,45,offset=>{pages.push(offset);return apifyPage(offset,45)})
  await discoverMultiSourceRange(input());h.next();h.lose()
  await assert.rejects(discoverMultiSourceRange(input()),/lost_response/)
  const saved=h.states.get('apify_store')!.snapshot
  assert.equal(saved.cursor,1);assert.equal(saved.nextPage,'40');assert.equal(saved.entries[0].id,'actor20')
  h.stop();const calls=pages.length
  assert.equal((await discoverMultiSourceRange(input())).items.length,0);assert.equal(pages.length,calls)
  h.resume();const resumed=await discoverMultiSourceRange(input())
  assert.deepEqual(resumed.items.map(item=>item.candidate!.sourceRecordId),Array.from({length:20},(_,i)=>`actor${20+i}`))
  assert.deepEqual(pages,[0,20]);assert.equal(h.observed.length,40)
  h.next();const last=await discoverMultiSourceRange(input())
  assert.equal(last.items.length,5);assert.deepEqual(pages,[0,20,40]);assert.equal(h.observed.length,45)
})
