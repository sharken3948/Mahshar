import Module from 'node:module'
const original = Module._load
export const state = {
  slots: [], cursor: 0, calls: /** @type {any[]} */ ([]), switched: [], sdkState: 'success', hardError: false, errorMessage: 'submission unknown', estimatedFee: '0.01', sdkSteps: /** @type {any[] | null} */ (null),
  owner: '0x' + '11'.repeat(20), account: '0x' + '11'.repeat(20),
  solanaOwner: '11111111111111111111111111111111', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  forwarding: true, disabledSource: '', memoChain: 5042, memoStatus: 'success', memoCalls: /** @type {any[]} */ ([]), effects: /** @type {Array<() => void>} */ ([]),
}
const storage = new Map()
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) }
globalThis.fetch = async () => { throw Error('NETWORK FORBIDDEN IN OFFLINE TESTS') }
export function reset() { state.slots=[];state.cursor=0;state.calls=[];state.switched=[];state.sdkState='success';state.hardError=false;state.errorMessage='submission unknown';state.estimatedFee='0.01';state.sdkSteps=null;state.forwarding=true;state.disabledSource='';state.account=state.owner;state.genesis='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';state.memoChain=5042;state.memoStatus='success';state.memoCalls=[];state.effects=[];storage.clear() }
export function flushEffects() { for (const effect of state.effects.splice(0)) effect() }
function slot(initial) { const i=state.cursor++;if(!(i in state.slots))state.slots[i]=typeof initial==='function'?initial():initial;return [state.slots[i],v=>{state.slots[i]=typeof v==='function'?v(state.slots[i]):v}] }
Module._load = function(id, parent, main) {
  if(id==='react')return {useState:slot,useRef:v=>slot({current:v})[0],useEffect:effect=>{state.effects.push(effect)}}
  if(id==='wagmi')return {useAccount:()=>({address:state.owner,connector:{getProvider:async()=>({request:async()=>[state.account]})}}),useSwitchChain:()=>({switchChainAsync:async p=>state.switched.push(p.chainId)})}
  if(id==='@solana/wallet-adapter-react')return {useConnection:()=>({connection:{getGenesisHash:async()=>state.genesis}}),useWallet:()=>({publicKey:{toBase58:()=>state.solanaOwner,toString:()=>state.solanaOwner},signTransaction:async()=>{throw Error('SIGNING FORBIDDEN')},disconnect:async()=>{}})}
  if(id==='@circle-fin/adapter-viem-v2')return {createViemAdapterFromProvider:async()=>({kind:'evm'})}
  if(id==='@circle-fin/adapter-solana')return {createSolanaAdapterFromProvider:async p=>{state.calls.push({solanaAdapter:p});return {kind:'solana'}}}
  if(id==='@circle-fin/bridge-kit') {
    const sdk=original.call(this,id,parent,main)
    return {...sdk,BridgeKit:class extends sdk.BridgeKit {
      constructor() {
        super()
        for (const provider of this.providers) {
          const supports = provider.supportsRoute.bind(provider)
          provider.supportsRoute = (source, destination, token, forward) => source.chain === state.disabledSource ? false : forward && !state.forwarding ? false : supports(source,destination,token,forward)
        }
      }
      on() {}
      async estimate(p) {state.calls.push({estimate:p});return {amount:p.amount,token:'USDC',source:{address:state.owner,chain:p.from.chain.chain},destination:{address:p.to.recipientAddress,chain:p.to.chain},gasFees:[],fees:[{type:'provider',token:'USDC',amount:state.estimatedFee}]}}
      async bridge(p) {
        state.calls.push({bridge:p});if(state.hardError)throw Error(state.errorMessage)
        return {amount:p.amount,token:'USDC',state:state.sdkState,provider:'CCTPV2BridgingProvider',source:{address:p.from.chain.type==='solana'?state.solanaOwner:state.owner,chain:p.from.chain},destination:{address:p.to.recipientAddress,chain:{chain:'Arc',chainId:5042,isTestnet:false},...(p.to.useForwarder ? {useForwarder:true} : {})},steps:state.sdkSteps??[{name:'burn',state:'success',txHash:'0x'+'aa'.repeat(32)}]}
      }
      async retry(result,context) {state.calls.push({retry:result,context});return {...result,state:'success'}}
    }}
  }
  if(id==='@/lib/gateway')return {PLATFORM_PRIVATE_KEY:'0x'+'ab'.repeat(32)}
  if(id==='viem/accounts')return {privateKeyToAccount:()=>({address:state.owner})}
  if(id==='viem') {
    const sdk=original.call(this,id,parent,main)
    return {...sdk,createPublicClient:()=>({getChainId:async()=>state.memoChain,waitForTransactionReceipt:async()=>({status:state.memoStatus})}),createWalletClient:()=>({writeContract:async p=>{state.memoCalls.push(p);return '0x'+'bb'.repeat(32)}})}
  }
  return original.call(this,id,parent,main)
}
