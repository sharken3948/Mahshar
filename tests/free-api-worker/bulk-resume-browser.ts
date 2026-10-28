import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { NextRequest } from 'next/server'
import { alice, origin, sessionHeaders } from '../marketplace/fixtures'
import { OWNER } from '../../src/lib/free-api-worker/model'
import { sql } from './phase3-adapter'
import * as batchRoutes from '../../src/app/api/admin/free-api-worker/batches/route'
import * as itemRoutes from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import * as workerStatus from '../../src/app/api/admin/free-api-worker/status/route'

export async function verifyResumeBrowser(candidate: (name:string)=>{id:string}, failing:Set<string>, calls:Map<string,number>) {
 const entries=Array.from({length:25},(_,i)=>({...candidate('browserbulk'+i),name:'browserbulk'+i}))
 const failedName=[...entries].sort((a,b)=>a.id.localeCompare(b.id))[4].name
 failing.add(failedName)
 const temp=mkdtempSync('/tmp/mahshar-worker-browser-bulk-')
 writeFileSync(temp+'/wallet.js',`export const useAccount=()=>({address:'${OWNER}'});`)
 writeFileSync(temp+'/session.js',`const request=(...args)=>fetch(...args);export const useMarketplaceSession=()=>({wallet:'${OWNER}',request});`)
 const bundle=buildSync({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FreeApiWorkerClient} from './src/app/admin/free-api-worker/worker-client';createRoot(document.getElementById('root')).render(<FreeApiWorkerClient/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic',outfile:temp+'/app.js',define:{'process.env.NODE_ENV':'"development"'},alias:{wagmi:temp+'/wallet.js','@/components/MarketplaceSessionProvider':temp+'/session.js'}})
 const js=bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??''
 const headers=sessionHeaders({...alice,address:OWNER})
 let nextRequests=0,releaseResponse=()=>{},reachedCheckpoint=()=>{}
 const checkpoint=new Promise<void>(resolve=>{reachedCheckpoint=resolve})
 const release=new Promise<void>(resolve=>{releaseResponse=resolve})
 const server=createServer(async(incoming,outgoing)=>{
  try {
   if(incoming.url==='/app.js'){outgoing.setHeader('content-type','application/javascript');outgoing.end(js);return}
   if(incoming.url==='/app.css'){outgoing.setHeader('content-type','text/css');outgoing.end(css);return}
   if(!incoming.url?.startsWith('/api/')){outgoing.setHeader('content-type','text/html');outgoing.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');return}
   const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk))
   const body=Buffer.concat(chunks).toString()
   const request=new NextRequest(origin+incoming.url,{method:incoming.method,headers,...(body?{body}:{})})
   let response:Response
   const match=/\/batches\/([a-f0-9-]+)$/.exec(incoming.url)
   if(match){
    const action=body?JSON.parse(body).action:null
    if(action==='next')nextRequests++
    response=incoming.method==='POST'?await itemRoutes.POST(request,{params:Promise.resolve({id:match[1]})}):await itemRoutes.GET(request,{params:Promise.resolve({id:match[1]})})
    if(action==='next'&&nextRequests===10){reachedCheckpoint();await release}
   }else if(incoming.url.includes('/batches'))response=incoming.method==='POST'?await batchRoutes.POST(request):await batchRoutes.GET(request)
   else if(incoming.url.includes('/status'))response=await workerStatus.GET(request)
   else throw Error('Unexpected browser mutation')
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text())
  }catch(error){outgoing.statusCode=500;outgoing.end(JSON.stringify({error:String(error)}))}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const {chromium}=require(process.env.FREE_WORKER_PLAYWRIGHT_MODULE!)
 let browser:any
 try {
  browser=await chromium.launch({headless:true,executablePath:process.env.FREE_WORKER_CHROMIUM,env:{...process.env,LD_LIBRARY_PATH:[process.env.FREE_WORKER_BROWSER_LIBRARY_PATH,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}})
  const context=await browser.newContext()
  await context.route('**/*',(route:any)=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
  let page=await context.newPage();const errors:string[]=[]
  const capture=(p:any)=>p.on('pageerror',(error:Error)=>errors.push(error.message));capture(page)
  await page.goto(base)
  await page.getByPlaceholder('API or provider').fill('browserbulk')
  await page.getByText('Page 1 · 25 results',{exact:true}).waitFor()
  await page.getByLabel('Select all visible filtered candidates').check()
  await page.getByRole('button',{name:'Bulk List',exact:true}).click()
  await page.getByLabel('Publication',{exact:true}).selectOption('PAID')
  await page.getByRole('spinbutton').fill('0.001')
  assert.equal(await page.getByRole('button',{name:'Confirm publication',exact:true}).isDisabled(),true)
  await page.getByRole('dialog').getByRole('checkbox').check()
  await page.getByRole('button',{name:'Confirm publication',exact:true}).click()
  await Promise.race([checkpoint,new Promise((_,reject)=>setTimeout(()=>reject(Error('Browser checkpoint timed out')),45000).unref())])
  await page.close();releaseResponse()
  assert.equal(nextRequests,10)
  page=await context.newPage();capture(page);await page.goto(base)
  const panel=page.getByRole('region',{name:'Saved Bulk List progress'})
  await panel.getByText('Published: 9 · Failed: 1 · Processing: 0 · Remaining: 15',{exact:true}).waitFor()
  assert.equal(nextRequests,10,'reopening must not publish without Resume')
  await panel.getByRole('button',{name:'Resume remaining'}).click()
  await panel.getByText('Published: 24 · Failed: 1 · Processing: 0 · Remaining: 0',{exact:true}).waitFor({timeout:60000})
  for(let i=0;i<25;i++)assert.equal(calls.get('browserbulk'+i),1,'completed reviews are not repeated')
  failing.delete(failedName)
  await panel.getByRole('button',{name:'Retry failed APIs'}).click()
  await panel.getByText('Published: 25 · Failed: 0 · Processing: 0 · Remaining: 0',{exact:true}).waitFor({timeout:30000})
  assert.equal(calls.get(failedName),2);assert.equal(nextRequests,26);assert.deepEqual(errors,[])
  assert.equal(sql(`SELECT count(*) FROM api_listings WHERE free_worker_candidate_id IN (${entries.map(x=>"'"+x.id+"'").join(',')}) AND is_active AND category='Data' AND score=8`),'25')
  console.log('PASS Chromium: 25 PAID APIs, rights confirmation, tab closure after 10, restored counts, explicit Resume, retry only failed API, zero duplicates')
 }finally{releaseResponse();await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(temp,{recursive:true,force:true})}
}
