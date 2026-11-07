import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { databaseStore } from '../../src/lib/free-api-worker/runtime'
import { digest, summary, usableCandidates } from '../../src/lib/free-api-worker/model'
import { boundary, sql } from './postgres-adapter'

const quote=(value:unknown)=>"'"+(typeof value==='string'?value:JSON.stringify(value)).replace(/'/g,"''")+"'"

async function main() {
  const { importReleaseInventory, loadReleaseInventory } = await import('../../scripts/free-api-worker-import.mjs')
  const store = await databaseStore(), base=resolve('isolated-validation/free-api-worker-replacement')
  const before=sql("SELECT md5(row_to_json(t)::text) FROM public.api_listings t")
  const first=await importReleaseInventory(store,base)
  assert.equal(first.ready,672);assert.equal(first.inventory,3925);assert.deepEqual(first.conflicts,[])
  const hash=sql("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.free_worker_apis t")
  const again=await importReleaseInventory(store,base)
  assert.deepEqual(again,first)
  assert.equal(sql("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.free_worker_apis t"),hash)
  assert.equal(sql("SELECT md5(row_to_json(t)::text) FROM public.api_listings t"),before)
  assert.equal((await store.state()).status,'stopped')
  const {rows}=await loadReleaseInventory(base)
  await store.admit(rows.map(row=>row.lead))
  const complete = await store.candidates()
  assert.equal(complete.length,3925)
  assert.equal(usableCandidates(complete).length,672)
  const oldInventoryBytes = Buffer.byteLength(JSON.stringify(complete))
  boundary.queries = []
  const [state, page] = await Promise.all([
    store.adminState(true), store.candidatePage({ view: 'usable', search: '', page: 1, pageSize: 25 }),
  ])
  const routineDatabaseBytes = boundary.queries.reduce((total, query) => total + query.responseBytes, 0)
  const routineDatabaseRequests = boundary.queries.length
  const routineResponseBytes = Buffer.byteLength(JSON.stringify({ state, ...page }))
  assert.equal(page.total,672);assert.equal(page.candidates.length,25);assert.deepEqual(page.summary,summary(complete))
  assert.ok(page.candidates.every(row => !row.result || !('evidence' in row.result) && !('tests' in row.result)))
  assert.ok(!boundary.queries.some(query => /(^|,)result(,|$)/.test(query.columns)))
  assert.ok(boundary.queries.some(query => query.rows===25));assert.ok(routineDatabaseBytes<oldInventoryBytes)
  const [detail] = await store.candidateDetails([page.candidates[0].lead.id])
  assert.ok(detail.result?.tests.length && Array.isArray(detail.result.evidence))
  const searched = await store.candidatePage({ view: 'all', search: page.candidates[0].lead.name, page: 1, pageSize: 25 })
  assert.ok(searched.total>=1 && searched.candidates.some(row=>row.lead.id===page.candidates[0].lead.id))

  // Insert deliberately overlapping rows without the admission trigger so this exercises
  // the Admin query's canonical deduplication itself, including historical preference.
  const inserted:string[]=[]
  const add=(name:string,endpoint:string,options:{historical?:boolean;permission?:string;removed?:boolean;published?:boolean;failed?:boolean;duplicateOf?:string}={})=>{
    const id=digest(`egress-dedup:${name}`),lead={id,providerId:`${name}.example`,name:`egress-dedup-${name}`,
      description:'Canonical dedup fixture',docs:'https://docs.example/dedup',sources:[],auth:'none',...(options.duplicateOf?{duplicateOf:options.duplicateOf}:{})}
    const result={technical:'PASSED',freeAccess:'VERIFIED',permission:options.permission??'ALLOWED',termsChecked:true,endpoint,
      docs:lead.docs,lastSuccess:'2026-11-07T00:00:00Z',reason:'Fixture',retryAt:null,evidence:[{url:lead.docs,sha256:digest(name),note:'fixture',checkedAt:'2026-11-07T00:00:00Z'}],
      tests:[{url:endpoint,status:200,reason:'Fixture',sha256:digest(endpoint)}]}
    const saved=options.historical?{original:{lead,result}}:null
    sql(`INSERT INTO free_worker_apis(id,provider_id,name,documentation_url,lead,result,completed_at,saved_inventory,removed_at,published_at,manual_failed_at)
      VALUES(${quote(id)},${quote(lead.providerId)},${quote(lead.name)},${quote(lead.docs)},${quote(lead)}::jsonb,${quote(result)}::jsonb,now(),${saved?`${quote(saved)}::jsonb`:'NULL'},
      ${options.removed?'now()':'NULL'},${options.published?'now()':'NULL'},${options.failed?'now()':'NULL'})`)
    inserted.push(id);return id
  }
  sql('ALTER TABLE free_worker_apis DISABLE TRIGGER free_worker_identity')
  try {
    const ordinary=add('ordinary','https://api.example/items?b=2&utm_source=catalog&a=1#section')
    const historical=add('historical','https://api.example/items?a=1&b=2',{historical:true})
    add('distinct-one','https://api.example/items?a=one')
    add('distinct-two','https://api.example/items?a=two')
    const explicit=add('explicit-duplicate','https://explicit.example/data',{duplicateOf:ordinary})
    for(const [kind,options] of [
      ['prohibited',{permission:'PROHIBITED'}],['removed',{removed:true}],['published',{published:true}],['failed',{failed:true}],
    ] as const){
      add(`${kind}-ready`,`https://${kind}.example/data?b=2&a=1`)
      add(`${kind}-excluded`,`https://${kind}.example/data?a=1&utm_medium=test&b=2#fragment`,options)
    }
    const full=(await store.candidates()).filter(row=>inserted.includes(row.lead.id))
    const expected=usableCandidates(full).map(row=>row.lead.id).sort()
    const compact=await store.candidatePage({view:'usable',search:'egress-dedup-',page:1,pageSize:100})
    assert.deepEqual(compact.candidates.map(row=>row.lead.id).sort(),expected)
    assert(expected.includes(historical)&&!expected.includes(ordinary),'historical record must win canonical endpoint identity')
    assert(!expected.includes(explicit),'lead duplicateOf must remain excluded')
    assert.equal(expected.filter(id=>inserted.slice(2,4).includes(id)).length,2,'meaningful query values must remain distinct')
    assert.equal(expected.length,3,'only historical winner and two distinct query values remain Ready')
  } finally { sql('ALTER TABLE free_worker_apis ENABLE TRIGGER free_worker_identity') }
  console.log('PASS release import:',JSON.stringify({inventory:3925,ready:672,oldInventoryBytes,routineDatabaseBytes,routineResponseBytes,
    routineDatabaseRequests,checks:['exact summary','25-row database page','search','compact preview','details on demand','canonical query dedup','historical preference','exclusions']}))
}
main().catch(error=>{console.error(error);process.exitCode=1})
