/** Browser integration boundary uses fixture wallet sessions; production auth stays unchanged. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { buildSync } from 'esbuild'
import { writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { alice, origin, sessionHeaders } from '../marketplace/fixtures'
import { sql } from './postgres-adapter'
import { databaseStore } from '../../src/lib/free-api-worker/runtime'
import { OWNER, usableCandidates } from '../../src/lib/free-api-worker/model'
import * as status from '../../src/app/api/admin/free-api-worker/status/route'
import * as control from '../../src/app/api/admin/free-api-worker/control/route'
import * as removal from '../../src/app/api/admin/free-api-worker/remove/route'
import * as bulk from '../../src/app/api/admin/free-api-worker/list/route'

export async function verifyBulkBrowser(makeFixture: (name: string, permission?: string) => { id: string; endpoint: string }) {
  const stage = (message: string) => appendFileSync('/tmp/mahshar-phase3-browser-progress.log', new Date().toISOString() + ' ' + message + '\n')
  stage('browser verification entered')
  const { chromium } = require(process.env.FREE_WORKER_PLAYWRIGHT_MODULE!)
  const store = await databaseStore()
  const output = 'isolated-validation/free-api-worker-replacement/owner-publication-control'
  stage('bundle started')
  const temporary = mkdtempSync('/tmp/mahshar-worker-browser-')
  writeFileSync(temporary + '/wallet.js', `export const useAccount=()=>({address:'${OWNER}'});`)
  writeFileSync(temporary + '/session.js', `const request=(...args)=>fetch(...args);export const useMarketplaceSession=()=>({wallet:'${OWNER}',request});`)
  const bundle = buildSync({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { FreeApiWorkerClient } from './src/app/admin/free-api-worker/worker-client';
    createRoot(document.getElementById('root')).render(<FreeApiWorkerClient />);`, resolveDir: process.cwd(), loader: 'tsx' },
    outfile: '/tmp/mahshar-phase3-browser.js', bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, alias: {
      wagmi: temporary + '/wallet.js', '@/components/MarketplaceSessionProvider': temporary + '/session.js',
    } })
  rmSync(temporary, { recursive: true, force: true })
  stage('bundle completed')
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
  const headers = sessionHeaders({ ...alice, address: OWNER })
  let publicationRequests = 0
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/app.js') { outgoing.setHeader('content-type', 'application/javascript'); outgoing.end(js); return }
      if (incoming.url === '/app.css') { outgoing.setHeader('content-type', 'text/css'); outgoing.end(css); return }
      if (!incoming.url?.startsWith('/api/')) { outgoing.setHeader('content-type', 'text/html'); outgoing.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="background:#0b111b"><div id="root"></div><script src="/app.js"></script></body></html>'); return }
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      if (incoming.url.includes('/list')) publicationRequests++
      const request = new NextRequest(origin + incoming.url, { method: incoming.method, headers, ...(body ? { body } : {}) })
      const response = incoming.url.includes('/status') ? await status.GET(request)
        : incoming.url.includes('/control') ? await control.POST(request) : incoming.url.includes('/list') ? await bulk.POST(request) : await removal.POST(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text())
    } catch (error) { outgoing.statusCode = 500; outgoing.end(String(error)) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  let browser: any
  try {
  stage('chromium launch')
  browser = await chromium.launch({ headless: true, timeout: 15000, env: { ...process.env,
    LD_LIBRARY_PATH: [process.env.FREE_WORKER_BROWSER_LIBRARY_PATH, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } })
  stage('chromium ready')
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = [], httpErrors: string[] = []
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('response', (response: any) => { if (response.status() >= 400) httpErrors.push(response.url() + ':' + response.status()) })
  // Browser is prohibited from reaching third-party endpoints, including accidental links.
  await page.route('**/*', (route: any) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    const first = makeFixture('Browser Free One'), second = makeFixture('Browser Free Two')
    const paid = makeFixture('Browser Paid One', 'UNKNOWN'), paidTwo = makeFixture('Browser Paid Two', 'REVIEW_REQUIRED')
    const originalCount = usableCandidates(await store.candidates()).length
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByPlaceholder('API or provider').fill('Browser Free')
    await page.getByText('Page 1 · 2 results', { exact: true }).waitFor()
    await page.getByLabel('Select all visible filtered candidates').check()
    await page.getByRole('button', { name: 'Bulk List', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(publicationRequests, 0, 'Cancel must not publish')
    await page.getByRole('button', { name: 'Bulk List', exact: true }).click()
    assert.equal(await page.getByRole('dialog').getByRole('checkbox').count(),0,'FREE requires no PAID rights confirmation')
    await page.getByRole('button', { name: 'Confirm publication', exact: true }).click()
    await page.getByRole('dialog').getByText('Published ·', {exact:false}).first().waitFor()
    await page.getByRole('dialog').getByRole('status').filter({hasText:'2 published'}).waitFor()
    assert.equal(sql(`SELECT count(*) FROM public.free_worker_apis WHERE id IN ('${first.id}','${second.id}') AND published_at IS NOT NULL`),'2')
    await page.screenshot({ path: resolve(output, 'bulk-free.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByPlaceholder('API or provider').fill('Browser Paid')
    await page.getByText('Page 1 · 2 results', { exact: true }).waitFor()
    await page.getByLabel('Select all visible filtered candidates').check()
    await page.getByRole('button', { name: 'Bulk List', exact: true }).click()
    await page.getByLabel('Publication', {exact:true}).selectOption('PAID')
    assert.equal(await page.getByRole('button', {name:'Confirm publication',exact:true}).isDisabled(),true)
    await page.getByLabel('USDC per API call', {exact:true}).fill('0.001')
    const confirmation = page.getByLabel('I have reviewed and established the necessary rights', {exact:false})
    assert.equal(await page.getByRole('dialog').getByRole('checkbox').count(),1,'One rights checkbox covers the entire PAID selection')
    assert.equal(await confirmation.isChecked(),false)
    assert.equal(await page.getByRole('button', {name:'Confirm publication',exact:true}).isDisabled(),true)
    assert.equal(publicationRequests,1,'Choosing PAID and entering a price never publishes automatically')
    await confirmation.check()
    await confirmation.uncheck()
    assert.equal(await page.getByRole('button', {name:'Confirm publication',exact:true}).isDisabled(),true)
    await confirmation.check()
    await page.getByRole('button', { name: 'Confirm publication', exact: true }).click()
    await page.getByRole('dialog').getByRole('status').filter({hasText:'2 published'}).waitFor()
    assert.equal(sql(`SELECT price_per_call::text FROM public.api_listings WHERE free_worker_candidate_id='${paid.id}'`),'0.001000')
    await page.screenshot({ path: resolve(output, 'bulk-paid.png'), fullPage: true })
    assert.equal(sql(`SELECT result->>'permission' FROM public.free_worker_apis WHERE id='${paid.id}'`),'UNKNOWN')
    assert.equal(sql(`SELECT owner_rights_confirmation->>'owner' FROM public.api_listings WHERE free_worker_candidate_id='${paid.id}'`),OWNER)
    assert.equal(sql(`SELECT result->>'permission' FROM public.free_worker_apis WHERE id='${paidTwo.id}'`),'REVIEW_REQUIRED')
    const receipts=JSON.parse(sql(`SELECT json_agg(owner_rights_confirmation) FROM public.api_listings WHERE free_worker_candidate_id IN ('${paid.id}','${paidTwo.id}')`))
    assert.equal(receipts.length,2)
    for (const candidate of [paid,paidTwo]) {
      const receipt=receipts.find((row:any)=>row.candidateId===candidate.id)
      assert.equal(receipt.owner,OWNER);assert.equal(receipt.endpoint,candidate.endpoint);assert.equal(receipt.confirmed,true)
    }
    assert.equal(usableCandidates(await store.candidates()).length,originalCount-4)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    const removed=makeFixture('Browser Remove')
    await page.getByPlaceholder('API or provider').fill('Browser Remove')
    await page.getByText('Page 1 · 1 results', {exact:true}).waitFor()
    await page.getByLabel('Select Browser Remove', {exact:true}).check()
    await page.getByRole('button', {name:'Remove selected',exact:true}).click()
    await page.getByRole('button', {name:'Cancel',exact:true}).click()
    assert.equal(sql(`SELECT removed_at IS NULL FROM public.free_worker_apis WHERE id='${removed.id}'`),'t')
    await page.getByRole('button', {name:'Remove selected',exact:true}).click()
    await page.getByRole('button', {name:'Confirm removal',exact:true}).click()
    await page.getByText('Page 1 · 0 results', {exact:true}).waitFor()
    assert.equal(sql(`SELECT removed_at IS NOT NULL FROM public.free_worker_apis WHERE id='${removed.id}'`),'t')
    assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[])
    assert.equal(publicationRequests,2)
    console.log('PASS browser: selection, cancellation, FREE multi, PAID multi with one owner confirmation per selection and individual receipts, persisted visibility/removal, one fixture session')
  } finally {
    await browser?.close()
    await new Promise<void>(resolve => server.close(()=>resolve()))
  }
}
