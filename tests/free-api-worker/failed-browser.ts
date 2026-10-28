import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { NextRequest } from 'next/server'
import { alice, origin, sessionHeaders } from '../marketplace/fixtures'
import { OWNER } from '../../src/lib/free-api-worker/model'
import { sql } from './phase3-adapter'
import * as failed from '../../src/app/api/admin/free-api-worker/failed/route'
import * as status from '../../src/app/api/admin/free-api-worker/status/route'
import * as batches from '../../src/app/api/admin/free-api-worker/batches/route'
import * as remove from '../../src/app/api/admin/free-api-worker/remove/route'

export async function verifyFailedBrowser(candidate:(name:string)=>{id:string;endpoint:string;lead:{docs:string}}, outbound:{responses:Map<string,{status:number;body:string}>}) {
 const good=candidate('browserfailedgood'),bad=candidate('browserfailedauth')
 outbound.responses.set(bad.lead.docs,{status:200,body:`<p>An API key is required.</p><pre>GET ${bad.endpoint}</pre>`})
 const listings=sql('SELECT count(*) FROM api_listings')
 const temp=mkdtempSync('/tmp/mahshar-worker-browser-failed-')
 writeFileSync(temp+'/wallet.js',`export const useAccount=()=>({address:'${OWNER}'});`)
 writeFileSync(temp+'/session.js',`const request=(...args)=>fetch(...args);export const useMarketplaceSession=()=>({wallet:'${OWNER}',request});`)
 const bundle=buildSync({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FreeApiWorkerClient} from './src/app/admin/free-api-worker/worker-client';createRoot(document.getElementById('root')).render(<FreeApiWorkerClient/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic',outfile:temp+'/app.js',define:{'process.env.NODE_ENV':'"development"'},alias:{wagmi:temp+'/wallet.js','@/components/MarketplaceSessionProvider':temp+'/session.js'}})
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text??''
 const headers=sessionHeaders({...alice,address:OWNER});let moves=0,rechecks=0
 const server=createServer(async(incoming,outgoing)=>{
  try {
   if(incoming.url==='/app.js'){outgoing.setHeader('content-type','application/javascript');outgoing.end(js);return}
   if(incoming.url==='/app.css'){outgoing.setHeader('content-type','text/css');outgoing.end(css);return}
   if(!incoming.url?.startsWith('/api/')){outgoing.setHeader('content-type','text/html');outgoing.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');return}
   const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk))
   const body=Buffer.concat(chunks).toString(),r=new NextRequest(origin+incoming.url,{method:incoming.method,headers,...(body?{body}:{})})
   let response:Response
   if(incoming.url.includes('/failed')){const action=JSON.parse(body).action;if(action==='move')moves++;if(action==='recheck')rechecks++;response=await failed.POST(r)}
   else if(incoming.url.includes('/status')&&incoming.method==='GET')response=await status.GET(r)
   else if(incoming.url.includes('/batches')&&incoming.method==='GET')response=await batches.GET(r)
   else if(incoming.url.includes('/remove'))response=await remove.POST(r)
   else throw Error('Unexpected publication/discovery request')
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text())
  } catch(error){outgoing.statusCode=500;outgoing.end(JSON.stringify({error:String(error)}))}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const {chromium}=require(process.env.FREE_WORKER_PLAYWRIGHT_MODULE!);let browser:any
 try {
  browser=await chromium.launch({headless:true,executablePath:process.env.FREE_WORKER_CHROMIUM,env:{...process.env,LD_LIBRARY_PATH:[process.env.FREE_WORKER_BROWSER_LIBRARY_PATH,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}})
  const context=await browser.newContext();await context.route('**/*',(route:any)=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
  let page=await context.newPage();const errors:string[]=[];const capture=(p:any)=>p.on('pageerror',(e:Error)=>errors.push(e.message));capture(page)
  await page.goto(base);await page.getByPlaceholder('API or provider').fill('browserfailed')
  await page.getByText('Page 1 · 2 results',{exact:true}).waitFor()
  await page.getByLabel('Select all visible filtered candidates').check();await page.getByRole('button',{name:'Move to Failed',exact:true}).click()
  await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(moves,0)
  await page.getByRole('button',{name:'Move to Failed',exact:true}).click();await page.getByRole('button',{name:'Confirm move to Failed',exact:true}).click()
  await page.getByText('Page 1 · 0 results',{exact:true}).waitFor();assert.equal(moves,1)
  await page.getByLabel('View',{exact:true}).selectOption('failed');await page.getByText('Page 1 · 2 results',{exact:true}).waitFor()
  await page.close();page=await context.newPage();capture(page);await page.goto(base)
  await page.getByLabel('View',{exact:true}).selectOption('failed');await page.getByPlaceholder('API or provider').fill('browserfailed')
  await page.getByText('Page 1 · 2 results',{exact:true}).waitFor();assert.equal(rechecks,0,'reload must never recheck automatically')
  await page.getByLabel('Select all visible filtered candidates').check();await page.getByRole('button',{name:'Recheck Failed',exact:true}).click()
  await page.getByText(/Recheck complete: 2 checked · 1 recovered · 1 unresolved/).waitFor({timeout:45000})
  await page.getByText('Page 1 · 1 results',{exact:true}).waitFor();assert.equal(rechecks,2)
  await page.getByText('Saved evidence',{exact:true}).click();await page.getByText(/Latest saved error \/ outcome: Authentication is required/).waitFor()
  await page.getByLabel('View',{exact:true}).selectOption('usable');await page.getByText('Page 1 · 1 results',{exact:true}).waitFor();await page.getByText('browserfailedgood',{exact:true}).waitFor()
  await page.getByLabel('View',{exact:true}).selectOption('failed');await page.getByText('browserfailedauth',{exact:true}).waitFor()
  await page.getByLabel('Select all visible filtered candidates').check();await page.getByRole('button',{name:'Remove Selected',exact:true}).click();await page.getByRole('button',{name:'Confirm removal',exact:true}).click()
  await page.getByText('Page 1 · 0 results',{exact:true}).waitFor()
  assert.deepEqual(errors,[]);assert.equal(sql('SELECT count(*) FROM api_listings'),listings)
  assert.equal(rechecks,2);assert.equal(moves,1)
  console.log('PASS Chromium: explicit multi-move/cancel, reload persistence, manual recheck, recovered Ready, saved unresolved error and removal; zero publications')
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(temp,{recursive:true,force:true})}
}
