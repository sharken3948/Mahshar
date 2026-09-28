import Module from 'node:module'
const load = Module._load
const listing = {id:'public',seller_wallet:'0x'+'11'.repeat(20),name:'Public API',description:'Description',endpoint_url:'https://seller.example',auth_type:'public',auth_param_name:null,example_request:null,example_response:null,category:'Data',price_per_call:.5,payment_model:'pay-per-call',method:'GET',score:9,uptime:100,created_at:'2026-01-01',is_active:true,verified_at:'2026-01-01'}
const sellerStatistics = () => ({
  total_earnings:2.5,accumulated_share:2.25,in_flight_withdrawals:.25,withdrawable_balance:2,
  earnings_by_api:[{api_id:'public',api_name:'Public API',total:2.5,calls:5}],total_calls:5,
  listings:[{...listing,seller_wallet:state.address}],
})
/** @type {{
 * address:string, slots:any[], cursor:number, effects:Array<()=>unknown>, requests:string[], signatures:number, writes:number,
 * now:number, gatewayOk:boolean, gatewayAvailable:string, sellerOk:boolean, sellerStatistics:any,
 * buyerCallsOk:boolean, buyerCalls:any[], balanceReadsOk:boolean, bridgeRefreshOk:boolean, solanaRefreshOk:boolean,
 * allowWalletActions:boolean, bridgeRefreshes:number, solanaRefreshes:number, contractRefreshes:Record<string,number>,
 * evmSwitches:number[], evmProviderRequests:string[], gatewayDeposits:any[], solanaWalletActions:number,
 * deferredWallets:Set<string>, deferredResponses:Array<{wallet:string,url:string,resolve:(response:Response)=>void}>, walletFixtures:Record<string,any>
 * }} */
export const state = globalThis.__mahsharDashboardState ??= {
  address: '0x'+'11'.repeat(20), slots: [], cursor: 0, effects: [], requests: [], signatures: 0, writes: 0,
  now: 1_000, gatewayOk: true, gatewayAvailable: '12.5', sellerOk: true, sellerStatistics: null,
  buyerCallsOk: true, buyerCalls: [], balanceReadsOk: true, bridgeRefreshOk: true, solanaRefreshOk: true,
  allowWalletActions: false, bridgeRefreshes: 0, solanaRefreshes: 0,
  contractRefreshes: { balanceOf: 0, withdrawingBalance: 0, withdrawalBlock: 0 },
  evmSwitches: [], evmProviderRequests: [], gatewayDeposits: [], solanaWalletActions: 0,
  deferredWallets: new Set(), deferredResponses: [], walletFixtures: {},
}
Date.now=()=>state.now
export function renderStart() { state.cursor=0 }
function slot(initial) { const slots=state.slots;const i=state.cursor++; if(!(i in slots)) slots[i]=typeof initial==='function'?initial():initial; return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}] }
function ref(initial) { return slot({current:initial})[0] }
function memo(fn,deps) {const i=state.cursor++;const old=state.slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j]))state.slots[i]={value:fn(),deps};return state.slots[i].value}
const forbidden = async()=>{ state.writes++;throw Error('Wallet operation forbidden during dashboard reads') }
const authorizedRead = async(input,init)=>{ state.signatures++; return globalThis.fetch(input,init) }
const walletAction = async value => { state.writes++; if(!state.allowWalletActions)throw Error('Wallet operation forbidden during dashboard reads');return value }
const solanaWalletAction = async()=>{state.solanaWalletActions++;return forbidden()}
function responseFor(url) {
 const wallet=Object.keys(state.walletFixtures).find(candidate=>url.toLowerCase().includes(candidate))
 const fixture=wallet?state.walletFixtures[wallet]:null
 if(url.startsWith('/api/gateway/balance?'))return state.gatewayOk
   ? Response.json({gatewayAvailable:fixture?.gatewayAvailable??state.gatewayAvailable,...(url.includes('include_history')?{totalCalls:fixture?.totalCalls??0,totalSpent:fixture?.totalSpent??0,purchasesByApiId:fixture?.purchasesByApiId??{}}:{})})
   : Response.json({error:'temporary gateway failure'},{status:503})
 if(url.startsWith('/api/apis?seller_wallet='))return Response.json({apis:[{id:'public',seller_wallet:state.address,name:'Public API',description:'Description',endpoint_url:'https://seller.example',auth_type:'public',category:'Data',price_per_call:.5,payment_model:'pay-per-call',method:'GET',score:9,uptime:100,created_at:'2026-01-01',is_active:true,verified_at:'2026-01-01'}]})
 if(url.startsWith('/api/seller/calls?'))return Response.json({groups:fixture?.sellCallGroups??[]})
 if(url.startsWith('/api/calls?'))return state.buyerCallsOk ? Response.json({calls:fixture?.buyerCalls??state.buyerCalls}) : Response.json({error:'temporary calls failure'},{status:503})
 if(url.startsWith('/api/seller/statistics/'))return state.sellerOk ? Response.json(fixture?.sellerStatistics??state.sellerStatistics??sellerStatistics()) : Response.json({error:'temporary seller failure'},{status:503})
 if(url==='/api/seller/withdraw')return state.allowWalletActions ? Response.json({withdrawal_id:'withdrawal-1',requested_amount_usdc:1,net_amount_usdc:.99,gas_cost_usdc:.01,mint_tx_hash:'0x'+'ef'.repeat(32),status:'minted'}) : Response.json({error:'forbidden'},{status:403})
 throw Error('Unexpected or private request: '+url)
}
globalThis.fetch=async(input)=>{
 const url=String(input);state.requests.push(url)
 const wallet=[...state.deferredWallets].find(candidate=>url.toLowerCase().includes(candidate))
 if(wallet)return new Promise(resolve=>state.deferredResponses.push({wallet,url,resolve}))
 return responseFor(url)
}
export function completeDeferredWallet(wallet) {
 const normalized=wallet.toLowerCase();const pending=state.deferredResponses.filter(item=>item.wallet===normalized)
 state.deferredResponses=state.deferredResponses.filter(item=>item.wallet!==normalized)
 state.deferredWallets.delete(normalized)
 for(const item of pending)item.resolve(responseFor(item.url))
}
// Intervals and fee-estimation timers are manually driven; no background processes.
export const timers=/** @type {Array<()=>unknown>} */(globalThis.__mahsharDashboardTimers ??= [])
export const timerDelays=/** @type {number[]} */(globalThis.__mahsharDashboardTimerDelays ??= [])
export const visibilityHandlers=/** @type {Array<()=>unknown>} */(globalThis.__mahsharDashboardVisibilityHandlers ??= [])
globalThis.setInterval=fn=>{timers.push(fn);return 1};globalThis.clearInterval=()=>{}
globalThis.setTimeout=(fn,delay)=>{timers.push(fn);timerDelays.push(delay);return 1};globalThis.clearTimeout=()=>{}
globalThis.document={visibilityState:'visible',addEventListener:(name,fn)=>{if(name==='visibilitychange')visibilityHandlers.push(fn)},removeEventListener:()=>{}}
Module._load=function(id,parent,main){
 if(id==='react/jsx-runtime')return {jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})}
 if(id==='react')return {createContext:()=>({Provider:()=>null}),useContext:()=>null,useState:slot,useRef:ref,useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),useEffect:(fn,deps)=>{memo(()=>{state.effects.push(fn)},deps)}}
 if(id==='@/components/MarketplaceSessionProvider')return {useMarketplaceSession:()=>({request:authorizedRead,status:'authenticated',authenticate:async()=>true,error:null,wallet:state.address?.toLowerCase()??null})}
 if(id==='@/components/ProductPreferencesProvider')return {useProductPreferences:()=>({preferences:{autoRefreshBalances:true,notifications:{sellerSale:false,withdrawalCompleted:false}},formatUsdc:value=>String(value)}),sendLocalNotification:()=>{}}
 if(id==='wagmi')return {useAccount:()=>({address:state.address,isConnected:!!state.address,connector:{id:'fixture',getProvider:async()=>({request:async({method})=>{state.evmProviderRequests.push(method);return method==='eth_accounts'?[state.address]:null}})}}),useWriteContract:()=>({writeContractAsync:()=>walletAction('0x'+'ab'.repeat(32))}),useSwitchChain:()=>({switchChainAsync:({chainId})=>{state.evmSwitches.push(chainId);return walletAction(undefined)}}),useSignMessage:()=>({signMessageAsync:()=>walletAction('0x'+'cd'.repeat(65))}),usePublicClient:()=>({readContract:async()=>BigInt(10000000),waitForTransactionReceipt:async()=>({status:'success'})}),useBlockNumber:()=>({data:100n}),useReadContract:p=>({data:p.functionName==='balanceOf'?2500000n:0n,refetch:async()=>{state.contractRefreshes[p.functionName]=(state.contractRefreshes[p.functionName]??0)+1;return {isSuccess:state.balanceReadsOk}}})}
 if(id==='@solana/wallet-adapter-react')return {useWallet:()=>({publicKey:null,connected:false,disconnect:solanaWalletAction})}
 if(id==='@solana/wallet-adapter-react-ui')return {useWalletModal:()=>({setVisible:solanaWalletAction})}
 if(id==='@/hooks/useSolanaBridgeBalance')return {useSolanaBridgeBalance:()=>({usdcBalance:'0',isLoading:false,error:null,refresh:async()=>{state.solanaRefreshes++;return state.solanaRefreshOk}})}
 if(id==='@/hooks/useBridgeBalances')return {useBridgeBalances:()=>({balances:[{chainName:'Base',usdcBalance:'3',isLoading:false}],refresh:async()=>{state.bridgeRefreshes++;return state.bridgeRefreshOk}})}
 if(id==='@/hooks/useBridge')return {useBridge:()=>({catalog:{routes:[{source:{chain:'Base'}}]},bridge:forbidden})}
 if(id==='@/lib/circle-bridge')return {usdcAmount:s=>s}
 if(id==='@circle-fin/adapter-viem-v2')return {createViemAdapterFromProvider:async()=>({})}
 if(id==='@circle-fin/app-kit')return {UnifiedBalanceChain:{Arc:'Arc'},AppKit:class {unifiedBalance={estimateSpend:async()=>({fees:[]}),deposit:async params=>{state.gatewayDeposits.push(params);return walletAction({txHash:'0x'+'ef'.repeat(32)})},spend:async()=>walletAction({})}}}
 return load.call(this,id,parent,main)
}
