import Module from 'node:module'
const load=Module._load
export const state={slots:[],cursor:0,effects:[],requests:[],signatures:0,transfers:0,world:null}
const chains=[['Ethereum','0.8500'],['Base','1.2800'],['Arbitrum','0.4001']]
export const world={
  isConnected:true,address:'0x'+'11'.repeat(20),walletUsdcRaw:2500000n,gatewayStats:{gatewayAvailable:'12.5'},
  bridgeBalances:chains.map(([chainName,usdcBalance])=>({chainName,displayName:chainName,usdcBalance,isLoading:false})),
  solanaPubkey:null,solanaConnected:false,solanaBalance:{usdcBalance:'0',isLoading:false},setSolanaModalVisible:()=>{},scheduleWalletRefresh:()=>{},balanceUpdatedAt:Date.now(),
  circleBridge:{catalog:{routes:[...chains.map(([chain])=>({source:{chain,name:chain,type:'evm'},useForwarder:true})),{source:{chain:'Solana',name:'Solana',type:'solana'},useForwarder:true}]},pending:false,resumable:false,isLoading:false,result:/** @type {any} */ (null),liveSteps:[],error:null,recoveryNotice:null,stepLabel:'Ready to bridge',adapterReady:()=>true,reset:()=>{},retry:async()=>{},bridge:async()=>{state.transfers++},estimate:async(source,amount)=>{state.requests.push({source,amount});return {amount,token:'USDC',fees:[{type:'provider',amount:'0.01',token:'USDC'},{type:'forwarder',amount:'0.02',token:'USDC'}],gasFees:[{name:'approve',token:'ETH',blockchain:source,fees:{gas:21000n,gasPrice:1n,fee:'0.001'}},{name:'burn',token:'ETH',blockchain:source,fees:{gas:21000n,gasPrice:1n,fee:'0.0025'}}]}}},
}
state.world=world
const listeners=new Map()
export const documentStub={activeElement:/** @type {unknown} */ (null),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)},emit:(name,event)=>listeners.get(name)?.(event)}
globalThis.document=documentStub
globalThis.setInterval=()=>0
globalThis.clearInterval=()=>{}
export function reset(){state.slots=[];state.cursor=0;state.effects=[];state.requests=[];state.signatures=0;state.transfers=0;world.bridgeBalances=chains.map(([chainName,usdcBalance])=>({chainName,displayName:chainName,usdcBalance,isLoading:false}));world.circleBridge.pending=false;world.circleBridge.resumable=false;world.circleBridge.result=null;world.circleBridge.adapterReady=()=>true;listeners.clear()}
export function renderStart(){state.cursor=0}
export function runEffects(){for(const fn of state.effects.splice(0))fn()}
function nextSlot(initial){const i=state.cursor++;if(!(i in state.slots))state.slots[i]=initial;return i}
function useState(initial){const i=nextSlot(typeof initial==='function'?initial():initial);return[state.slots[i],value=>{state.slots[i]=typeof value==='function'?value(state.slots[i]):value}]}
function useRef(value){const i=nextSlot({current:value});return state.slots[i]}
function memo(fn,deps){const i=state.cursor++;const old=state.slots[i];if(!old||deps.some((dep,j)=>dep!==old.deps[j]))state.slots[i]={deps,value:fn()};return state.slots[i].value}
function useEffect(fn,deps){const i=state.cursor++;const old=state.slots[i];if(!old||deps.some((dep,j)=>dep!==old.deps[j]))state.effects.push(()=>{old?.cleanup?.();state.slots[i]={deps,cleanup:fn()}})}
const jsx=(type,props,key)=>({type,props:props??{},key})
Module._load=function(id,parent,main){
 if(id==='react')return {useState,useRef,useMemo:memo,useEffect}
 if(id==='react/jsx-runtime')return {jsx,jsxs:jsx}
 if(id.endsWith('.module.css'))return new Proxy({}, {get:(_,key)=>key==='__esModule'?false:String(key)})
 if(id==='@rainbow-me/rainbowkit')return {ConnectButton:()=>null}
 if(id==='next/link')return {__esModule:true,default:'a'}
 if(id==='next/image')return {__esModule:true,default:'img'}
 if(id==='../../dashboard-visuals')return {DashboardIcon:()=>null,UsdcUnit:()=>null,DashboardCardHeader:()=>null}
 if(id==='../../dashboard-workspace')return {useDashboardWorkspace:()=>world}
 if(id==='@/components/ProductPreferencesProvider')return {useProductPreferences:()=>({preferences:{usdcDecimals:4,showSmallBalances:true,fundedChainsFirst:true,autoRefreshBalances:true,notifications:{bridgeCompleted:false,bridgeFailed:false,sellerSale:false,withdrawalCompleted:false}},formatUsdc:(value,atomic=false)=>(Number(value)/(atomic?1e6:1)).toFixed(4)}),sendLocalNotification:()=>{}}
 if(id==='./useBridgeJourney')return {useBridgeJourney:()=>({working:false,bridging:false,depositing:false,active:null,activity:[],error:null,storageError:null,start:async()=>{state.transfers++},deposit:async()=>{}})}
 return load.call(this,id,parent,main)
}
