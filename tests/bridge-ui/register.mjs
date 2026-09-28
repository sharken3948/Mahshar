import Module from 'node:module'
const load = Module._load
export const state = { slots:[], cursor:0, effects:[], cleanups:[], address:'0x'+'11'.repeat(20), providerChainId:5042, connectorChainId:5042, reads:0, writes:0, switches:0, switchedChainIds:/** @type {number[]} */([]), evmProviderCalls:0, evmRequests:/** @type {string[]} */([]), solanaProviderCalls:0, balances:[1000000n,1900000n,1900000n], deposited:[], failDeposit:false, receiptReads:0, receiptStatus:'success', focusHandlers:/** @type {Array<()=>unknown>} */([]), visibilityHandlers:/** @type {Array<()=>unknown>} */([]) }
const storage = new Map()
globalThis.localStorage = {getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}
globalThis.fetch = async()=>{throw Error('Network forbidden')}
globalThis.document={visibilityState:'visible',addEventListener:(name,handler)=>{if(name==='visibilitychange')state.visibilityHandlers.push(handler)},removeEventListener:(name,handler)=>{if(name==='visibilitychange')state.visibilityHandlers=state.visibilityHandlers.filter(item=>item!==handler)}}
globalThis.window={addEventListener:(name,handler)=>{if(name==='focus')state.focusHandlers.push(handler)},removeEventListener:(name,handler)=>{if(name==='focus')state.focusHandlers=state.focusHandlers.filter(item=>item!==handler)}}
export function reset() {state.slots=[];state.cursor=0;state.effects=[];state.cleanups=[];state.address='0x'+'11'.repeat(20);state.providerChainId=5042;state.connectorChainId=5042;state.reads=0;state.writes=0;state.switches=0;state.switchedChainIds=[];state.evmProviderCalls=0;state.evmRequests=[];state.solanaProviderCalls=0;state.balances=[1000000n,1900000n,1900000n];state.deposited=[];state.failDeposit=false;state.receiptReads=0;state.receiptStatus='success';state.focusHandlers=[];state.visibilityHandlers=[];storage.clear()}
export function effects() {for(const fn of state.effects.splice(0)){const cleanup=fn();if(cleanup)state.cleanups.push(cleanup)}}
export function unmount() {for(const fn of state.cleanups)fn()}
function slot(initial){const i=state.cursor++;if(!(i in state.slots))state.slots[i]=typeof initial==='function'?initial():initial;return[state.slots[i],v=>{state.slots[i]=typeof v==='function'?v(state.slots[i]):v}]}
Module._load=function(id,parent,main){
 if(id==='react')return {useState:slot,useRef:v=>slot({current:v})[0],useEffect:fn=>{state.effects.push(fn)}}
 if(id==='wagmi')return {
  useAccount:()=>({address:state.address,chainId:state.connectorChainId,connector:{getProvider:async()=>{
   state.evmProviderCalls++
   return {request:async({method})=>{state.evmRequests.push(method);if(method==='eth_accounts')return [state.address];if(method==='eth_chainId')return `0x${state.providerChainId.toString(16)}`;return null}}
  },getChainId:async()=>state.connectorChainId}}),
  useSwitchChain:()=>({switchChainAsync:async({chainId})=>{state.switches++;state.switchedChainIds.push(chainId)}}),
  usePublicClient:()=>({readContract:async()=>state.balances[state.reads++],waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async()=>{state.receiptReads++;return {status:state.receiptStatus}}}),
 }
 if(id==='@solana/wallet-adapter-react')return {useWallet:()=>{state.solanaProviderCalls++;return {}}}
 if(id==='@/lib/arc-balance-client')return {readArcWalletUsdc:async()=>{const value=state.balances[state.reads++];return {wallet:state.address,value,status:value===undefined?'unknown':'fresh',source:'official-rpc'}}}
 if(id==='@circle-fin/adapter-viem-v2')return {createViemAdapterFromProvider:async()=>({})}
 if(id==='@circle-fin/bridge-kit'){
  const arc={chain:'Arc',chainId:5042,name:'Arc',type:'evm',isTestnet:false,usdcAddress:'0x3600000000000000000000000000000000000000',explorerUrl:'https://explorer.arc.io/tx/{hash}'}
  const base={chain:'Base',chainId:8453,name:'Base',type:'evm',isTestnet:false,usdcAddress:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',explorerUrl:'https://basescan.org/tx/{hash}'}
  const solana={chain:'Solana',name:'Solana',type:'solana',isTestnet:false,usdcAddress:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',explorerUrl:'https://solscan.io/tx/{hash}'}
  return {Arc:arc,Base:base,Solana:solana,Blockchain:{Arc:'Arc'},BridgeChain:{Arc:'Arc',Base:'Base',Solana:'Solana'},BridgeKit:class{providers=[];getSupportedChains(){return [base,solana,arc]}}}
 }
 if(id==='viem')return {
  erc20Abi:[],
  parseUnits:(value,decimals)=>{const [whole='0',fraction='']=String(value).split('.');return BigInt(whole)*BigInt(10**decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals))},
  formatUnits:(value,decimals)=>{const scale=BigInt(10**decimals);const whole=value/scale;const fraction=(value%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:String(whole)},
 }
 if(id==='@circle-fin/app-kit')return {UnifiedBalanceChain:{Arc:'Arc'},AppKit:class {unifiedBalance={deposit:async params=>{state.writes++;state.deposited.push(params);if(state.failDeposit)throw Error('Submission uncertain');return {txHash:'0x'+'ab'.repeat(32)}}}}}
 return load.call(this,id,parent,main)
}
