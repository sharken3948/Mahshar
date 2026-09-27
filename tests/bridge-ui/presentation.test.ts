import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Arc, Base, type BridgeResult, type EstimateResult } from '@circle-fin/bridge-kit'
import { amountIssue, bridgeEstimateDetails, bridgeStepName, bridgeStepStatus, distribution, displayUnits, progressStages, shortTransactionHash, transactionLinks, units } from '../../src/app/dashboard/wallet/bridge/presentation'
import { discoverCircleRoutes } from '../../src/lib/circle-bridge'
import { readFileSync } from 'node:fs'
const result = {amount:'1',token:'USDC',provider:'CCTPV2BridgingProvider',state:'success',source:{address:'0x'+'11'.repeat(20),chain:Base},destination:{address:'0x'+'11'.repeat(20),chain:Arc},steps:[{name:'burn',state:'success',txHash:'0xabc'},{name:'mint',state:'success',txHash:'0xdef'}]} as BridgeResult

test('all dynamically discovered source balances contribute exactly to chart and total',async()=>{
 const {routes}=await discoverCircleRoutes()
 assert.ok(routes.length>4)
 const rows=routes.map(({source},i)=>({key:source.chain,name:source.name,balance:i===0?'0.000001':'0.123456',loading:false}))
 const chart=distribution(rows)
 const expected=rows.reduce((sum,row)=>sum+units(row.balance)!,BigInt(0))
 assert.equal(chart.total,expected)
 assert.equal(chart.slices.reduce((sum,row)=>sum+row.value,BigInt(0)),expected)
 assert.equal(chart.slices.length,6);assert.equal(chart.slices[5].name,'Others')
 assert.ok(!rows.some(row=>row.key==='Arc'));assert.ok(routes.some(route=>route.source.type==='solana'))
})
test('unknown balances are excluded and marked partial; single funded chain works',()=>{
 const data=distribution([{key:'a',name:'A',balance:'1.25',loading:false},{key:'b',name:'B',balance:'?',loading:false}])
 assert.equal(data.partial,true);assert.equal(data.total,BigInt(1250000));assert.equal(data.slices.length,1)
 assert.equal(displayUnits(data.total),'1.2500')
 assert.equal(distribution([]).total,BigInt(0))
})
test('amount validation uses six-decimal units and refuses unknown/insufficient balance',()=>{
 assert.equal(amountIssue('0.000001',BigInt(1)),null)
 assert.match(amountIssue('1.000001',BigInt(1000000))!,/Insufficient/)
 for(const amount of ['0','-1','NaN','1e5','1.0000001'])assert.ok(amountIssue(amount,BigInt(1000000)))
 assert.match(amountIssue('1',null)!,/unavailable/)
})
test('progress ends at the Arc wallet and never infers a Gateway deposit',()=>{
 assert.deepEqual(progressStages(result,false,'done',null),['completed','completed','completed','completed'])
 const failed={...result,state:'error' as const,steps:[{name:'burn',state:'success' as const},{name:'mint',state:'error' as const}]}
 assert.equal(progressStages(failed,false,'failed','error')[3],'failed')
 assert.equal(progressStages(null,true,'working',null,[{name:'approve',state:'success'}])[0],'completed')
 assert.ok(!progressStages(null,false,'Ready',null).includes('completed'))
})
test('source and Arc explorer links use official metadata and reject unsafe URLs',()=>{
 const links=transactionLinks(result)
 assert.match(links[0].href,/basescan/);assert.match(links[1].href,/explorer.arc.io/)
 assert.match(transactionLinks(null,[{name:'burn',state:'success',txHash:'0xabc'}],Base,Arc)[0].href,/basescan/)
 assert.equal(transactionLinks({...result,steps:[{name:'mint',state:'success',txHash:'0xabc',explorerUrl:'javascript:alert(1)'}]}).length,0)
})
test('technical bridge details use support-friendly labels without changing recorded values',()=>{
 assert.equal(bridgeStepName('approve'),'Approve')
 assert.equal(bridgeStepName('FetchAttestation'),'Fetch Attestation')
 assert.equal(bridgeStepName('providerSpecificStep'),'providerSpecificStep')
 assert.deepEqual(['noop','success','error','failed','pending'].map(bridgeStepStatus),['Not required','Completed','Failed','Failed','Pending'])
 assert.equal(shortTransactionHash('0xa05c1234567890af13'),'0xa05c...af13')
})
test('estimate details preserve SDK decimal gas values and expose only reported fee rows',()=>{
 const quote={fees:[{type:'provider',token:'USDC',amount:'0.01'},{type:'forwarder',token:'USDC',amount:'0.02'}],gasFees:[
  {name:'approve',token:'ETH',blockchain:Base.chain,fees:{gas:BigInt(21000),gasPrice:BigInt(1),fee:'0.001'}},
  {name:'burn',token:'ETH',blockchain:Base.chain,fees:{gas:BigInt(21000),gasPrice:BigInt(1),fee:'0.0025'}},
 ]} as EstimateResult
 assert.deepEqual(bridgeEstimateDetails(quote),{
  providerFee:'0.01 USDC',forwardingFee:'0.02 USDC',approvalGasReserve:'0.001 ETH',burnGasReserve:'0.0025 ETH',
 })
 assert.equal(bridgeEstimateDetails(null),null)
 assert.deepEqual(bridgeEstimateDetails({...quote,fees:[{type:'provider',token:'USDC',amount:null}],gasFees:[{...quote.gasFees[0],fees:{...quote.gasFees[0].fees!,fee:'invalid'}}]}),{})
})
test('EVM and Solana pages share one amount-control component and focus treatment',()=>{
 const evm=readFileSync('src/app/dashboard/wallet/bridge/page.tsx','utf8')
 const solana=readFileSync('src/app/dashboard/solana/page.tsx','utf8')
 const control=readFileSync('src/app/dashboard/wallet/bridge/BridgeAmountControl.tsx','utf8')
 const css=readFileSync('src/app/dashboard/wallet/bridge/bridge.module.css','utf8')
 assert.match(evm,/<BridgeAmountControl/)
 assert.match(solana,/<BridgeAmountControl/)
 assert.equal((control.match(/<input/g)??[]).length,1)
 assert.equal((control.match(/>MAX<\/button>/g)??[]).length,1)
 assert.match(css,/\.amount:focus-within[^}]*box-shadow:\s*inset/)
 assert.match(css,/\.amount \.amountInput[^}]*border:\s*0/)
 assert.match(css,/\.amount button\.amountMax[^}]*min-height:\s*30px/)
})
