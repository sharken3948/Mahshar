import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourcePage, DISCOVERY_SOURCES } from '../../src/lib/free-api-worker/sources'
import { usableCandidates, emptyResult, type Candidate } from '../../src/lib/free-api-worker/model'
import { functional } from '../../src/lib/free-api-worker/pipeline'
import { documentation } from '../../src/lib/free-api-worker/discovery'
import { Network } from '../../src/lib/free-api-worker/network'
const page = (body: string, url: string) => ({ body, url, type: 'text/html', status: 200, sha256: 'fixture' })
test('Mixed Analytics uses the labelled link and ignores directory/tool rows', () => {
  const source = DISCOVERY_SOURCES.find(s => s.id === 'mixed-analytics')!
  const rows = sourcePage(source,page('<tr><td>1</td><td>Books</td><td><a href="https://books.example.org/docs"></a><a href="https://books.example.org/docs">Books</a></td><td>Book data API</td><td><a href="https://books.example.org/books?q=test">sample</a></td></tr>',source.url))
  assert.equal(rows.leads.length,1); assert.equal(rows.leads[0].name,'Books')
  assert.deepEqual(rows.leads[0].endpoints,['https://books.example.org/books?q=test'])
  const hosted=sourcePage(source,page('<tr><td>1</td><td>Books</td><td><a href="https://github.com/books/service">Books</a></td><td>Book data API</td><td><a href="https://books.example.org/books?q=test">sample</a></td></tr>',source.url)).leads[0]
  assert.equal(hosted.id,rows.leads[0].id,'A documentation host must not change the documented API provider identity')
  assert.equal(hosted.docs,'https://github.com/books/service')
})
test('a JSON documentation article is not favicon functionality', () => {
  const article = { ...page(JSON.stringify({id:880058,title:'Get favicons using an API',body_html:null,created_at:'2021-10-28'}),'https://dev.to/author/article'),type:'application/json' }
  assert.equal(functional(article,"Google Favicons Google's unofficial favicon fetcher").reason,'documentation_article_not_api_functionality')
  assert.equal(functional(article,'Blog articles API').ok,true)
})
test('forecast configuration and location catalogues are not weather results', () => {
  const json=(body:unknown,url='https://weather.example.org/locations')=>({...page(JSON.stringify(body),url),type:'application/json'})
  assert.equal(functional(json({type:'FeatureCollection',features:[{geometry:{type:'Point',coordinates:[10,60]},properties:{id:'a',name:'Oslo',type:'IGA',resources:[]}}]}),'Ocean current maps').ok,false)
  assert.equal(functional(json({radar:{area:['norway'],content:['image']}}),'Radar images').ok,false)
  assert.equal(functional(json({meta:{type:'Exercise'},layergroups:[{layers:[{timesteps:[{time:'2026-10-13',url:'./forecast.png'}]}]}]}),'Volcanic ash forecast').ok,false)
  assert.equal(functional(json(['ENHF-ENUJ'],'https://weather.example.org/routes'),'Vertical cross sections for flight routes').ok,false)
  assert.equal(functional(json(['2026-10-13T16:00:00Z'],'https://weather.example.org/reftimes'),'Volcanic ash forecast').ok,false)
  assert.equal(functional(json({reftimes:['2026-10-13T16:00:00Z']},'https://weather.example.org/reftimes'),'Volcanic ash forecast').ok,false)
  assert.equal(functional(json(['forecasts/exercise/image.png'],'https://weather.example.org/resources'),'Volcanic ash forecast').ok,false)
  assert.equal(functional(json({type:'FeatureCollection',features:[{geometry:{type:'Point',coordinates:[10,60]},properties:{text:'Rain in Oslo',temperature:9}}]}),'Weather forecast').ok,true)
  assert.equal(functional({...page('','https://weather.example.org/map'),type:'image/png',binary:{bytes:280000,prefix:'89504e470d0a1a0a'}},'Current maps for Oslofjord').ok,true)
})
test('shared reference navigation follows its linked overview without crawling every operation', async () => {
  const calls: string[]=[]
  const network = new Network(async input => {
    const url=String(input);calls.push(url)
    if(url.endsWith('/robots.txt'))return new Response('',{status:404})
    if(url.endsWith('/docs')) return new Response('<a href="/reference">Reference</a>'+Array.from({length:200},(_,i)=>`<a href="/reference/operation${i}">Operation</a>`).join('')+'<a href="/documentation/unused">Other guide</a>',{headers:{'content-type':'text/html'}})
    return new Response('GET https://books.example.org/books',{headers:{'content-type':'text/plain'}})
  })
  const result=await documentation({id:'fixture',providerId:'example.org',name:'Books',description:'Book API',docs:'https://books.example.org/docs',sources:[],auth:'none'},network)
  assert.ok(result.endpoints.includes('https://books.example.org/books'))
  assert.ok(!calls.some(url=>url.includes('/operation')))
  assert.ok(!calls.some(url=>url.endsWith('/unused')))
  assert.equal(result.pages.length,2)
})
test('independent markdown table parses services and rejects standalone SDKs', () => {
  const source = DISCOVERY_SOURCES.find(s => s.id === 'n0shake')!
  const rows = sourcePage(source,page('| [**Books API**](https://books.example.org/docs) | Search for books. | N/A |\n| [**SDK**](https://sdk.example.org/) | Standalone SDK for Android. | N/A |\n| [**OpenAPI**](https://www.openapis.org/) | Standard, language-agnostic interface to REST APIs. | N/A |',source.url))
  assert.equal(rows.leads.length,1); assert.equal(rows.leads[0].name,'Books API')
})
test('APIs.guru selects one preferred version with stable provider/service identity', () => {
  const source = DISCOVERY_SOURCES.find(s => s.id === 'apis-guru')!
  const entry = (version: string) => ({ 'books.example.org:catalog': { preferred: version, versions: {
    [version]: { swaggerUrl: `https://api.apis.guru/v2/specs/books.example.org/catalog/${version}/openapi.json`, info: { title: 'Books', description: 'Book search API' } },
    old: { swaggerUrl: 'https://api.apis.guru/old.json', info: { title: 'Books' } },
  } } })
  const a = sourcePage(source,page(JSON.stringify(entry('v1')),'https://api.apis.guru/v2/books.example.org.json')).leads
  const b = sourcePage(source,page(JSON.stringify(entry('v2')),'https://api.apis.guru/v2/books.example.org.json')).leads
  assert.equal(a.length,1); assert.equal(a[0].providerId,'books.example.org'); assert.equal(a[0].id,b[0].id)
  assert.equal(a[0].endpoints,undefined, 'A schema link must not become a claimed functional endpoint')
  const flattened = sourcePage(source,page(JSON.stringify({apis:{'books.example.org:catalog':entry('v1')['books.example.org:catalog'].versions.v1}}),'https://api.apis.guru/v2/books.example.org.json')).leads
  assert.equal(flattened.length,1);assert.equal(flattened[0].id,a[0].id)
})
test('new endpoint alias cannot replace a frozen Ready to List candidate', () => {
  const result = { ...emptyResult('https://books.example.org/docs'), technical: 'PASSED' as const, freeAccess: 'VERIFIED' as const,
    endpoint:'https://books.example.org/books',lastSuccess:new Date().toISOString(),termsChecked:true,tests:[{url:'https://books.example.org/books',status:200,reason:'functional',sha256:'proof'}] }
  const original: Candidate = { historical:true, lead:{id:'f'.repeat(64),name:'Books',description:'Book API',docs:result.docs,providerId:'example.org',sources:[],auth:'none'},result,attempts:1,retryAt:null }
  assert.equal(usableCandidates([original,{...original,historical:false,lead:{...original.lead,id:'0'.repeat(64)}}])[0].lead.id,original.lead.id)
})
