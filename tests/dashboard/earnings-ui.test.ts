import './earnings-register.mjs'
import { world } from './earnings-register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Page from '../../src/app/dashboard/earnings/page'

test('connected wallet always sees the normal earnings cards without a sign-in wall',()=>{
 world.privateAccess=false;world.sellerEarnings=null
 const html=renderToStaticMarkup(createElement(Page))
 for(const label of ['Withdrawable Earnings','Lifetime Earned','Reserved by Withdrawals','Withdraw earnings','Earnings by API'])assert.ok(html.includes(label),label)
 assert.doesNotMatch(html,/Verify seller wallet|Verify your seller wallet|Private seller earnings|Sign in to Marketplace|Marketplace sign-in/)
 assert.ok(html.match(/<input[^>]*aria-label="Seller earnings withdrawal amount in USDC"[^>]*>/)?.[0].includes('disabled=""'))
 assert.match(html,/Unavailable/)
})

test('read-only earnings reveal values without Marketplace access',()=>{
 world.privateAccess=false
 world.sellerEarnings={withdrawable_balance:1.25,total_earnings:2.5,in_flight_withdrawals:.25,earnings_by_api:[]}
 const html=renderToStaticMarkup(createElement(Page))
 for(const value of ['1.2500','2.5000','0.2500'])assert.ok(html.includes(value),value)
 assert.doesNotMatch(html,/Verify|Sign in to Marketplace|Marketplace sign-in/)
 assert.ok(!html.match(/<input[^>]*aria-label="Seller earnings withdrawal amount in USDC"[^>]*>/)?.[0].includes('disabled=""'))
})
