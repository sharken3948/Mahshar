import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { state, reset } from './register.mjs'
import { useBridge } from '../../src/hooks/useBridge'
import { usdcAmount, bridgeSource, discoverCircleRoutes, MAINNET_CHAINS, validateBridgeResult } from '../../src/lib/circle-bridge'
import { writeMemo } from '../../src/lib/memo'

function render() { state.cursor = 0; return useBridge() }
for (const chain of MAINNET_CHAINS.filter(chain => chain.type === 'evm' && chain.chain !== 'Arc')) {
  const source = chain.chain
  const id = chain.type === 'evm' ? chain.chainId : 0
  test(`${source} uses official Bridge Kit to the connected Arc wallet`, async () => {
    reset();await render().bridge(source,'1.123456')
    const call=state.calls.find(c=>'bridge' in c)!.bridge
    assert.equal(call.from.chain.chain,source);assert.deepEqual(state.switched,[id])
    assert.deepEqual(call.to,{chain:'Arc',recipientAddress:state.owner,useForwarder:true})
    assert.equal(call.token,'USDC');assert.equal(call.amount,'1.123456')
    assert.equal(render().result?.state,'success')
  })
}
test('Solana uses the official provider adapter with only Mainnet capabilities',async()=>{
  reset();await render().bridge('Solana','2')
  const adapter=state.calls.find(c=>'solanaAdapter' in c)!.solanaAdapter
  assert.deepEqual(adapter.capabilities.supportedChains.map((c:{chain:string})=>c.chain),['Solana'])
  assert.equal(state.calls.find(c=>'bridge' in c)!.bridge.from.adapter.kind,'solana')
})
test('wrong Solana network and changed EVM account fail before SDK execution',async()=>{
  reset();state.genesis='wrong';await render().bridge('Solana','1');assert.equal(state.calls.length,0)
  reset();state.account='0x'+'22'.repeat(20);await render().bridge('Base','1');assert.equal(state.calls.length,0)
})
test('partial success resumes the saved SDK result instead of starting a new burn',async()=>{
  reset();state.sdkState='error';await render().bridge('Base','1');await render().retry()
  assert.equal(state.calls.filter(c=>'bridge' in c).length,1)
  assert.equal(state.calls.filter(c=>'retry' in c).length,1)
  assert.equal(render().result?.state,'success')
})
test('unknown submission blocks new transfer and cannot be reset as success',async()=>{
  reset();state.hardError=true;await render().bridge('Base','1');render().reset();await render().bridge('Base','1')
  assert.equal(state.calls.filter(c=>'bridge' in c).length,1)
})
test('USDC precision and unsupported sources reject before a transaction',async()=>{
  for(const value of ['0','-1','NaN','1e3','1.0000001'])assert.throws(()=>usdcAmount(value))
  assert.equal(usdcAmount('001.200000'),'1.2');assert.throws(()=>bridgeSource('NotAChain'))
  reset();await render().bridge('Base','1.0000001');assert.equal(state.calls.length,0)
})
test('SDK recovery rejects changed destination, token or network',async()=>{
  reset();await render().bridge('Base','1');const result=render().result!
  assert.throws(()=>validateBridgeResult({...result,token:'EURC'} as never,state.owner))
  assert.throws(()=>validateBridgeResult(result,'0x'+'22'.repeat(20)))
  assert.throws(()=>validateBridgeResult({...result,source:{...result.source,chain:{...result.source.chain,isTestnet:true}}},state.owner))
})
test('Memo uses verified Mainnet deployment and rejects wrong network or reverted receipt',async()=>{
  reset();await writeMemo('fixture',state.owner,'purchase-fixture')
  assert.equal(state.memoCalls[0].address,'0x5294E9927c3306DcBaDb03fe70b92e01cCede505')
  assert.equal(state.memoCalls[0].functionName,'memo')
  reset();state.memoChain=1;await assert.rejects(writeMemo('fixture',state.owner,'purchase-fixture'));assert.equal(state.memoCalls.length,0)
  reset();state.memoStatus='reverted';await assert.rejects(writeMemo('fixture',state.owner,'purchase-fixture'))
})
test('production source contains no legacy network or custom bridge executor',()=>{
  assert.equal(existsSync('archive/pre-official-circle'), false)
  assert.equal(existsSync('src/lib/bridge'), false)
  assert.equal(existsSync('src/app/api/bridge'), false)
  function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)])}
  for(const path of files('src').filter(p=>/\.(ts|tsx)$/.test(p)&&!p.endsWith('.test.ts'))){
    const content=readFileSync(path,'utf8')
    assert.doesNotMatch(content,/5042002|Arc_Testnet|arcTestnet|ARC_TESTNET|rejectLegacyBridgeExecution|STRICT_FULL_HISTORY|depositForBurnWithHook|CERTIFIED_EXECUTION_ROUTE|@\/lib\/bridge\//,path)
  }
})

test('route catalog checks the entire SDK universe and excludes only Arc today',async()=>{
  const catalog=await discoverCircleRoutes()
  assert.equal(catalog.routes.length,MAINNET_CHAINS.length-1)
  assert.deepEqual(catalog.excluded.map(c=>c.name),['Arc'])
  assert.ok(catalog.routes.length>4)
  assert.ok(catalog.routes.every(r=>!r.source.isTestnet && r.source.usdcAddress && r.useForwarder))
})

for (const source of ['Base','Solana']) test(`${source} non-forwarded path supplies official EVM destination adapter and preserves it on retry`,async()=>{
  reset();state.forwarding=false;state.sdkState='error'
  await render().bridge(source,'2')
  const call=state.calls.find(c=>'bridge' in c)!.bridge
  assert.equal(call.to.useForwarder,false)
  assert.equal(call.to.adapter.kind,'evm')
  assert.equal(call.to.recipientAddress,state.owner)
  await render().retry()
  assert.equal(state.calls.find(c=>'retry' in c)!.context.to.kind,'evm')
  assert.equal(state.calls.filter(c=>'bridge' in c).length,1)
})
test('removed SDK route cannot execute even if previously shown',async()=>{
  reset();state.disabledSource='Base'
  const catalog=await discoverCircleRoutes()
  assert.ok(!catalog.routes.some(r=>r.source.chain==='Base'))
  await render().bridge('Base','1')
  assert.equal(state.calls.length,0)
})
test('new SDK chain is discovered without an application chain allowlist',async()=>{
  reset()
  const source={...MAINNET_CHAINS.find(c=>c.type==='evm')!,chain:'Future_Mainnet',name:'Future Mainnet',chainId:987654}
  const calls: unknown[][]=[]
  const catalog=await discoverCircleRoutes({getSupportedChains:()=>[source],providers:[{supportsRoute:(...args:unknown[])=>{calls.push(args);return true}}]} as never)
  assert.equal(catalog.routes[0].source.chain,'Future_Mainnet')
  assert.equal(calls.length,2)
  assert.equal(calls[0][2],'USDC');assert.equal(calls[1][3],true)
})
