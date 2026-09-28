import { calls, state } from './solana-register.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Page from '../../src/app/dashboard/solana/page'
import { shouldAutoConnectSolanaWallet } from '../../src/lib/solana-wallet-routing'

test('Solana workspace renders the official route controls without automatic execution',()=>{
 state.successful=false;calls.length=0
 const html=renderToStaticMarkup(createElement(Page))
 for(const label of ['Bridge USDC from Solana to Arc','Solana Wallet','SPL USDC','Solana → Arc','Connected EVM wallet','Get Circle estimate ↻','Bridge to Arc','Solana → Arc progress'])assert.ok(html.includes(label),label)
 assert.match(html,/Move supported SPL USDC from Solana to your connected wallet on Arc Mainnet/)
 assert.match(html,/Connected as the source wallet for this Solana-to-Arc transfer/)
 assert.match(html,/2\.5/)
 assert.equal((html.match(/id="solana-bridge-amount"/g)??[]).length,1)
 assert.match(html,/class="amountInput"/)
 assert.match(html,/class="amountMax"[^>]*>MAX<\/button>/)
 assert.doesNotMatch(html,/Open Bridge/)
 assert.deepEqual(calls,[])
})

test('Solana summary keeps a readable address and standard card spacing',()=>{
 const css=readFileSync('src/app/dashboard/solana/solana.module.css','utf8')
 assert.match(css,/\.walletValue[^}]*font-size:\s*clamp\(18px,1\.05vw,22px\)[^}]*line-height:\s*1\.35/)
 assert.match(css,/\.workspace[^}]*margin-top:\s*var\(--card-gap\)/)
})

test('successful Solana bridge hands optional deposit review to the Wallet route without invoking Solana',()=>{
 state.successful=true;calls.length=0
 const html=renderToStaticMarkup(createElement(Page))
 assert.match(html,/USDC is confirmed in your Arc wallet/)
 assert.match(html,/href="\/dashboard\/wallet#deposit"[^>]*>Review deposit in Wallet →<\/a>/)
 assert.deepEqual(calls,[],'Review handoff must not execute either bridge or deposit wallet operations')
  state.successful=false
})

test('Wallet deposit routes never auto-connect Phantom or another Solana adapter',()=>{
 assert.equal(shouldAutoConnectSolanaWallet('/dashboard/wallet'),false)
 assert.equal(shouldAutoConnectSolanaWallet('/dashboard/earnings'),false)
 assert.equal(shouldAutoConnectSolanaWallet('/dashboard/solana'),true)
 assert.equal(shouldAutoConnectSolanaWallet('/dashboard/wallet/bridge'),true)
})
