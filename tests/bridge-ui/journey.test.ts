import { state, reset, effects, unmount } from './register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Arc, Base, Solana, type BridgeResult } from '@circle-fin/bridge-kit'
import type { useBridge } from '../../src/hooks/useBridge'
import { useBridgeJourney } from '../../src/app/dashboard/wallet/bridge/useBridgeJourney'
import type { WalletRefreshAction } from '../../src/lib/wallet-refresh'
const owner='0x'+'11'.repeat(20)
const result={amount:'1',token:'USDC',provider:'CCTPV2BridgingProvider',state:'success',source:{address:owner,chain:Base},destination:{address:owner,chain:Arc},steps:[{name:'burn',state:'success',txHash:'0x'+'ab'.repeat(32)}]} as BridgeResult
function render(run:()=>Promise<BridgeResult|undefined>=async()=>result,schedule:(action:WalletRefreshAction)=>void=()=>{}){state.cursor=0;return useBridgeJourney({bridge:run,pending:false,isLoading:false} as unknown as ReturnType<typeof useBridge>,schedule)}
test('mount and restored display history never trigger a wallet operation',()=>{
 reset();localStorage.setItem('mahshar:bridge-activity:v1:'+owner,JSON.stringify([{id:'saved',date:new Date().toISOString(),source:'Base',amount:'1',deposit:'current',result}]))
 render();effects();assert.equal(state.reads,0);assert.equal(state.writes,0);assert.equal(state.switches,0)
})
test('bridge completion exposes the measured Arc receipt without automatic deposit',async()=>{
 reset();const scheduled:WalletRefreshAction[]=[];const journey=render(undefined,action=>scheduled.push(action));effects();await journey.start('Base','1')
 const completed=render()
 assert.equal(state.writes,0);assert.equal(completed.activity[0].result?.state,'success')
 assert.equal(completed.activity[0].deposit,'available');assert.equal(completed.activity[0].receivedAmount,'0.9')
 assert.ok(completed.activity[0].date)
 assert.deepEqual(scheduled,[{kind:'bridge',source:'evm'}])
})
test('explicit deposit uses the measured net receipt, never input or prior balance',async()=>{
 reset();const scheduled:WalletRefreshAction[]=[];let journey=render(undefined,action=>scheduled.push(action));effects();await journey.start('Base','1')
 journey=render(undefined,action=>scheduled.push(action));await journey.deposit()
 assert.equal(state.writes,1,render().error ?? 'Deposit should execute');assert.equal((state.deposited[0] as {amount:string}).amount,'0.9')
 assert.equal(render().activity[0].deposit,'completed')
  assert.deepEqual(scheduled,[{kind:'bridge',source:'evm'},{kind:'gatewayDeposit'}])
})
test('successful Solana bridge keeps the optional Arc deposit on the EVM connector',async()=>{
 reset();const scheduled:WalletRefreshAction[]=[]
 const solanaResult={...result,source:{address:'So11111111111111111111111111111111111111112',chain:Solana}}
 let journey=render(async()=>solanaResult,action=>scheduled.push(action));effects();await journey.start('Solana','1')
 journey=render(undefined,action=>scheduled.push(action))
 assert.equal(journey.active?.result?.state,'success');assert.equal(journey.active?.deposit,'available')
 assert.equal(state.writes,0,'Bridge completion must not auto-deposit')
 await journey.deposit()
 assert.equal(state.evmProviderCalls,1);assert.deepEqual(state.evmRequests,['eth_accounts'])
 assert.deepEqual(state.switchedChainIds,[Arc.chainId]);assert.equal(state.solanaProviderCalls,0)
 assert.equal((state.deposited[0] as {from:{chain:string}}).from.chain,'Arc')
 assert.deepEqual(scheduled,[{kind:'bridge',source:'solana'},{kind:'gatewayDeposit'}])
})
test('failed bridge and unknown submission cannot start a deposit',async()=>{
 for(const value of [undefined,{...result,state:'error' as const}]){reset();const journey=render(async()=>value);effects();await journey.start('Base','1');assert.equal(state.writes,0)}
})
test('pre-broadcast failure remains in Recent Activity as failed',async()=>{
 reset();const journey=useBridgeJourney({bridge:async()=>undefined,pending:false,isLoading:false,lastFailure:()=>({terminal:true,message:'The wallet declined the bridge transaction. No USDC was bridged.'})} as unknown as ReturnType<typeof useBridge>,async()=>{});effects()
 await journey.start('Solana','0.01')
 state.cursor=0;const restored=render();effects()
 assert.equal(restored.activity[0].deposit,'unavailable')
 assert.equal(restored.activity[0].source,'Solana')
 assert.equal(state.writes,0)
})
test('restored failed result without burn is retained in Recent Activity before replacement',()=>{
 reset()
 const failed={...result,state:'error' as const,steps:[{name:'burn',state:'error' as const,errorMessage:'MaxFeeMustBeLessThanAmount'}]}
 state.cursor=0
 useBridgeJourney({bridge:async()=>failed,pending:false,isLoading:false,result:failed} as unknown as ReturnType<typeof useBridge>,async()=>{})
 effects()
 state.cursor=0;const restored=render();effects()
 assert.equal(restored.activity.length,1)
 assert.equal(restored.activity[0].deposit,'unavailable')
 assert.equal(state.writes,0)
})
test('ambiguous receipt balance never guesses the deposited amount',async()=>{
 for(const after of [BigInt(1000000),BigInt(3000000)]){reset();state.balances=[BigInt(1000000),after];const journey=render();effects();await journey.start('Base','1');assert.equal(state.writes,0)}
})
test('account change or page unmount never starts a deposit',async()=>{
 reset();const journey=render(async()=>{state.address='0x'+'22'.repeat(20);render();return result});effects();await journey.start('Base','1');assert.equal(state.writes,0)
 reset();const next=render(async()=>{unmount();return result});effects();await next.start('Base','1');assert.equal(state.writes,0)
})
test('double clicks do not duplicate bridge or explicit deposit execution',async()=>{
 reset();state.failDeposit=true;let runs=0;let journey=render(async()=>{runs++;return result});effects()
 await Promise.all([journey.start('Base','1'),journey.start('Base','1')]);assert.equal(runs,1);assert.equal(state.writes,0)
 journey=render();await Promise.all([journey.deposit(),journey.deposit()]);assert.equal(state.writes,1)
 assert.equal(render().activity[0].result?.state,'success');assert.equal(render().activity[0].deposit,'failed');render();effects();assert.equal(state.writes,1)
})
