import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { NextRequest } from 'next/server'
import { alice, origin, sessionHeaders } from '../marketplace/fixtures'
import { OWNER } from '../../src/lib/free-api-worker/model'
import type { BulkProgress } from '../../src/lib/free-api-worker/bulk-progress'
import * as batches from '../../src/app/api/admin/free-api-worker/batches/route'
import * as items from '../../src/app/api/admin/free-api-worker/batches/[id]/route'
import * as worker from '../../src/app/api/admin/free-api-worker/status/route'

export async function verifyGroqPauseBrowser(
 candidate:(name:string)=>{id:string}, selection:(ids:string[])=>Promise<BulkProgress>,
 action:(batch:BulkProgress,action?:string)=>Promise<Response>, expire:(batch:BulkProgress)=>Promise<BulkProgress>,
 read:(id:string)=>Promise<BulkProgress>, failing:Map<string,string|null>, calls:Map<string,number>,
){
 const entries=Array.from({length:3},(_,i)=>candidate('browserpause'+i));let batch=await selection(entries.map(x=>x.id))
 const [first,second,third]=batch.items;failing.set(first.name,'605')
 batch=(await (await action(batch)).json()).batch
 const temp=mkdtempSync('/tmp/mahshar-groq-pause-browser-')
 writeFileSync(temp+'/wallet.js',`export const useAccount=()=>({address:'${OWNER}'});`)
 writeFileSync(temp+'/session.js',`const request=(...args)=>fetch(...args);export const useMarketplaceSession=()=>({wallet:'${OWNER}',request});`)
 const bundle=buildSync({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FreeApiWorkerClient} from './src/app/admin/free-api-worker/worker-client';createRoot(document.getElementById('root')).render(<FreeApiWorkerClient/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic',outfile:temp+'/app.js',define:{'process.env.NODE_ENV':'"development"'},alias:{wagmi:temp+'/wallet.js','@/components/MarketplaceSessionProvider':temp+'/session.js'}})
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text
 const headers=sessionHeaders({...alice,address:OWNER}),actions:string[]=[],errors:string[]=[]
 const server=createServer(async(incoming,outgoing)=>{
  try{
   if(incoming.url==='/app.js'){outgoing.setHeader('content-type','application/javascript');outgoing.end(js);return}
   if(!incoming.url?.startsWith('/api/')){outgoing.setHeader('content-type','text/html');outgoing.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');return}
   const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk))
   const body=Buffer.concat(chunks).toString(),request=new NextRequest(origin+incoming.url,{method:incoming.method,headers,...(body?{body}:{})})
   let response:Response;const match=/\/batches\/([a-f0-9-]+)$/.exec(incoming.url)
   if(match){if(body)actions.push(JSON.parse(body).action);response=incoming.method==='POST'?await items.POST(request,{params:Promise.resolve({id:match[1]})}):await items.GET(request,{params:Promise.resolve({id:match[1]})})}
   else if(incoming.url.includes('/batches'))response=await batches.GET(request)
   else if(incoming.url.includes('/status'))response=await worker.GET(request)
   else throw Error('Unexpected request')
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text())
  }catch(error){outgoing.statusCode=500;outgoing.end(JSON.stringify({error:String(error)}))}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const {chromium}=require(process.env.FREE_WORKER_PLAYWRIGHT_MODULE!);let browser:any
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.FREE_WORKER_CHROMIUM,env:{...process.env,LD_LIBRARY_PATH:[process.env.FREE_WORKER_BROWSER_LIBRARY_PATH,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}})
  const context=await browser.newContext();await context.route('**/*',(r:any)=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort())
  const page=await context.newPage();page.on('pageerror',(e:Error)=>errors.push(e.message));await page.goto(base)
  const panel=page.getByRole('region',{name:'Saved Bulk List progress'}),resume=panel.getByRole('button',{name:'Resume remaining'})
  await panel.getByText(/Groq rate limit reached\. Resume available after/).waitFor()
  assert(await resume.isDisabled());assert.deepEqual(actions,[])
  await page.reload();await panel.getByText(/Groq rate limit reached\. Resume available after/).waitFor()
  assert(await resume.isDisabled());assert.deepEqual(actions,[])
  batch=await expire(batch)
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Resume remaining'&&!b.disabled),{},{timeout:15000})
  assert.deepEqual(actions,[],'Elapsed pause plus polling must not auto-resume')
  failing.delete(first.name);failing.set(second.name,'605');await resume.click()
  await page.waitForFunction(()=>document.body.innerText.includes('Published: 1 · Failed: 0 · Processing: 0 · Remaining: 2')&&document.body.innerText.includes('Groq rate limit reached. Progress saved'),{},{timeout:20000})
  assert.deepEqual(actions,['resume','next','next']);assert(await resume.isDisabled())
  assert.equal(calls.get(third.name),undefined);assert.equal(calls.get(first.name),2)
  batch=await expire(await read(batch.id));failing.delete(second.name)
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Resume remaining'&&!b.disabled),{},{timeout:15000})
  assert.deepEqual(actions,['resume','next','next']);await resume.click()
  await panel.getByText('Published: 3 · Failed: 0 · Processing: 0 · Remaining: 0',{exact:true}).waitFor({timeout:20000})
  assert.deepEqual(actions,['resume','next','next','resume','next','next'])
  assert.equal(calls.get(first.name),2);assert.equal(calls.get(second.name),2);assert.equal(calls.get(third.name),1)
  assert.deepEqual(errors,[])
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(temp,{recursive:true,force:true})}
}
