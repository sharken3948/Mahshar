import Module from 'node:module'
const load = Module._load
export const state = { slots:[], cursor:0, effects:[], cleanups:[], address:'0x'+'11'.repeat(20), reads:0, writes:0, switches:0, switchedChainIds:[], evmProviderCalls:0, evmRequests:[], solanaProviderCalls:0, balances:[1000000n,1900000n,1900000n], deposited:[], failDeposit:false }
const storage = new Map()
globalThis.localStorage = {getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}
globalThis.fetch = async()=>{throw Error('Network forbidden')}
export function reset() {state.slots=[];state.cursor=0;state.effects=[];state.cleanups=[];state.address='0x'+'11'.repeat(20);state.reads=0;state.writes=0;state.switches=0;state.switchedChainIds=[];state.evmProviderCalls=0;state.evmRequests=[];state.solanaProviderCalls=0;state.balances=[1000000n,1900000n,1900000n];state.deposited=[];state.failDeposit=false;storage.clear()}
export function effects() {for(const fn of state.effects.splice(0)){const cleanup=fn();if(cleanup)state.cleanups.push(cleanup)}}
export function unmount() {for(const fn of state.cleanups)fn()}
function slot(initial){const i=state.cursor++;if(!(i in state.slots))state.slots[i]=typeof initial==='function'?initial():initial;return[state.slots[i],v=>{state.slots[i]=typeof v==='function'?v(state.slots[i]):v}]}
Module._load=function(id,parent,main){
 if(id==='react')return {useState:slot,useRef:v=>slot({current:v})[0],useEffect:fn=>{state.effects.push(fn)}}
 if(id==='wagmi')return {
  useAccount:()=>({address:state.address,connector:{getProvider:async()=>{
   state.evmProviderCalls++
   return {request:async({method})=>{state.evmRequests.push(method);return [state.address]}}
  }}}),
  useSwitchChain:()=>({switchChainAsync:async({chainId})=>{state.switches++;state.switchedChainIds.push(chainId)}}),
  usePublicClient:()=>({readContract:async()=>state.balances[state.reads++],waitForTransactionReceipt:async()=>({status:'success'})}),
 }
 if(id==='@solana/wallet-adapter-react')return {useWallet:()=>{state.solanaProviderCalls++;return {}}}
 if(id==='@circle-fin/adapter-viem-v2')return {createViemAdapterFromProvider:async()=>({})}
 if(id==='@circle-fin/app-kit')return {UnifiedBalanceChain:{Arc:'Arc'},AppKit:class {unifiedBalance={deposit:async params=>{state.writes++;state.deposited.push(params);if(state.failDeposit)throw Error('Submission uncertain');return {txHash:'0x'+'ab'.repeat(32)}}}}}
 return load.call(this,id,parent,main)
}
