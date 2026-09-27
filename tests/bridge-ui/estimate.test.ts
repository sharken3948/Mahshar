import { state,reset } from '../mainnet/register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useBridge } from '../../src/hooks/useBridge'
function render(){state.cursor=0;return useBridge()}
test('EVM and Solana estimates call only Circle estimate without switching or executing',async()=>{
 for(const source of ['Base','Solana']){
  reset();const quote=await render().estimate(source,'1')
  assert.equal(quote.fees[0].amount,'0.01');assert.equal(state.switched.length,0)
  assert.equal(state.calls.filter(call=>'bridge' in call||'retry' in call).length,0)
  const call=state.calls.find(call=>'estimate' in call)!.estimate
  assert.equal(call.to.chain,'Arc');assert.equal(call.to.recipientAddress,state.owner);assert.equal(call.to.useForwarder,true)
 }
})
test('unsupported routes cannot estimate and non-forwarded routes retain Arc adapter',async()=>{
 reset();state.disabledSource='Base';await assert.rejects(()=>render().estimate('Base','1'));assert.equal(state.calls.length,0)
 reset();state.forwarding=false;await render().estimate('Base','1');assert.equal(state.switched.length,0)
 const call=state.calls.find(call=>'estimate' in call)!.estimate
 assert.equal(call.to.useForwarder,false);assert.ok(call.to.adapter)
})
