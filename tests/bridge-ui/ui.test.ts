import { calls } from './ui-register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import Page from '../../src/app/dashboard/wallet/bridge/page'
test('Bridge page renders dashboard layout and balances without automatic execution',()=>{
 const html=renderToStaticMarkup(createElement(Page))
 for(const label of ['Arc Wallet USDC','Total USDC Across Chains','Mahshar Balance','Route Summary','Bridge Progress','Recent bridge activity','Bridge to Arc'])assert.ok(html.includes(label),label)
 assert.match(html,/3\.9800/);assert.match(html,/2\.5000/);assert.match(html,/12\.5/)
 assert.doesNotMatch(html,/role="option"[^>]*>.*Solana/)
 assert.match(html,/aria-expanded="false"/);assert.doesNotMatch(html,/role="listbox"/)
 assert.match(html,/No recorded bridge activity yet/)
 for(const label of ['Route','You send','Recipient','Transfer mode','CCTP v2 · FAST','Delivery','Route status'])assert.ok(html.includes(label),label)
 for(const misleading of ['Not provided by Circle','Unavailable','Total estimated cost','Estimated completion time','You receive (estimated)','This route is supported and verified by Circle'])assert.ok(!html.includes(misleading),misleading)
 assert.deepEqual(calls,[])
 const source=readFileSync('src/app/dashboard/wallet/bridge/page.tsx','utf8')
 for(const label of ['Technical Details','Detailed execution steps for this bridge transaction.','View technical details','View on Explorer'])assert.ok(source.includes(label),label)
 assert.doesNotMatch(source,/All recorded steps/)
 assert.match(source,/<details id="recorded-steps"/)
 const css=readFileSync('src/app/dashboard/wallet/bridge/bridge.module.css','utf8')
 assert.match(css,/\.options \{ position: absolute/);assert.match(css,/@media \(max-width: 680px\)/)
})
