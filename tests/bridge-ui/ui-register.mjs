import Module from 'node:module'
import React from 'react'
const load=Module._load
export const calls=[]
globalThis.fetch=async()=>{throw Error('Network forbidden')}
const balances=[{chainName:'Base',usdcBalance:'1.28',isLoading:false},{chainName:'Ethereum',usdcBalance:'0.85',isLoading:false},{chainName:'Polygon',usdcBalance:'1.10',isLoading:false}]
Module._load=function(id,parent,main){
 if(id.endsWith('.module.css'))return new Proxy({}, {get:(_,key)=>key==='__esModule'?false:String(key)})
 if(id==='@rainbow-me/rainbowkit')return {ConnectButton:()=>null}
 if(id==='next/link')return {__esModule:true,default:'a'}
 if(id==='next/image')return {__esModule:true,default:({unoptimized,...props})=>React.createElement('img',props)}
 if(id==='../../dashboard-visuals')return {DashboardIcon:()=>null,UsdcUnit:()=> 'USDC',DashboardCardHeader:({title})=>title}
 if(id==='@/components/ProductPreferencesProvider')return {useProductPreferences:()=>({preferences:{usdcDecimals:4,showSmallBalances:true,fundedChainsFirst:true,autoRefreshBalances:true,notifications:{bridgeCompleted:false,bridgeFailed:false,sellerSale:false,withdrawalCompleted:false}},formatUsdc:(value,atomic=false)=>(Number(value)/(atomic?1e6:1)).toFixed(4)}),sendLocalNotification:()=>{}}
 if(id==='./useBridgeJourney')return {useBridgeJourney:()=>({active:null,activity:[],working:false,bridging:false,depositing:false,error:null,storageError:null,start:()=>calls.push('start'),deposit:()=>calls.push('deposit')})}
 if(id==='../../dashboard-workspace')return {useDashboardWorkspace:()=>({isConnected:true,address:'0x'+'11'.repeat(20),walletUsdcRaw:2500000n,gatewayStats:{gatewayAvailable:'12.5'},bridgeBalances:balances,solanaConnected:true,solanaBalance:{usdcBalance:'0.75',isLoading:false},circleBridge:{catalog:{routes:[...balances.map(row=>({source:{chain:row.chainName,name:row.chainName,type:'evm'},useForwarder:true})),{source:{chain:'Solana',name:'Solana',type:'solana'},useForwarder:true}]},result:null,liveSteps:[],stepLabel:'Ready to bridge',error:null,bridge:()=>calls.push('bridge'),estimate:()=>calls.push('estimate')},scheduleWalletRefresh:action=>calls.push(action),balanceUpdatedAt:Date.now()})}
 return load.call(this,id,parent,main)
}
