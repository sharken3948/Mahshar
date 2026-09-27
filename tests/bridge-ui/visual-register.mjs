import Module from 'node:module'
import React from 'react'
const load = Module._load
let stateSlot = 0
const key='0x'+'11'.repeat(20)
const balances = [
  ['Base','1.2800'],['Ethereum','0.8500'],['Arbitrum','0.4001'],['Solana','0.7503'],['Polygon','1.1000'],
  ['Optimism','0.5030'],['Avalanche','0.3000'],['Cronos','0.2501'],['Linea','0.1500'],['Unichain','0.1201'],
]
const routeBalances = balances.map(([name,value])=>({chainName:name,displayName:name,usdcBalance:value,isLoading:false}))
const routes = balances.map(([name])=>({source:{chain:name,name,type:name==='Solana'?'solana':'evm'},useForwarder:true}))
export const previewWorkspace = {
  isConnected:true,address:key,walletUsdcRaw:2364000n,gatewayStats:{gatewayAvailable:'0.032423'},bridgeBalances:routeBalances,
  solanaPubkey:{toBase58:()=> 'So11111111111111111111111111111111111111112'},solanaConnected:true,
  solanaBalance:{usdcBalance:'0.7503',isLoading:false},setSolanaModalVisible:()=>{},scheduleWalletRefresh:()=>{},balanceUpdatedAt:Date.now(),
  circleBridge:{catalog:{routes},isLoading:false,pending:false,result:null,liveSteps:[{name:'approve',state:'success'},{name:'burn',state:'success'},{name:'fetchAttestation',state:'pending'}],stepLabel:'Processing bridge transaction...',error:null,estimate:async()=>{},bridge:async()=>{},retry:async()=>{},reset:()=>{}},
}
export const previewJourney = {
  working:false,bridging:false,depositing:false,error:null,storageError:null,active:null,start:async()=>{},deposit:async()=>{},activity: [
    {id:'1',date:'2026-09-20T14:32:00Z',source:'Base',amount:'1.0000',deposit:'pending'},
    {id:'2',date:'2026-09-19T21:11:00Z',source:'Ethereum',amount:'0.2500',deposit:'completed'},
    {id:'3',date:'2026-09-18T10:24:00Z',source:'Arbitrum',amount:'0.7500',deposit:'completed'},
    {id:'4',date:'2026-09-17T18:03:00Z',source:'Solana',amount:'1.2000',deposit:'completed'},
  ],
}
Module._load=function(id,parent,main) {
 if(id==='react')return {...React,useState(initial){ const slot=stateSlot++;return React.useState(slot===0?'Base':slot===1?'0.1000':slot===2?true:initial) }}
 if(id==='react/jsx-runtime') { const runtime=load.call(this,id,parent,main);return {...runtime,jsx(type,props,key){if(type&&typeof type==='object'&&type!==React.Fragment)process.stderr.write(`invalid JSX: ${Object.keys(type)} ${Object.keys(props??{})}\n`);return runtime.jsx(type,props,key)},jsxs(type,props,key){if(type&&typeof type==='object'&&type!==React.Fragment)process.stderr.write(`invalid JSX: ${Object.keys(type)} ${Object.keys(props??{})}\n`);return runtime.jsxs(type,props,key)}} }
 if(id.endsWith('.module.css')) {const prefix=id.includes('bridge.module.css')?'br-':'db-';return new Proxy({}, {get:(_,key)=>key==='__esModule'?false:prefix+String(key)})}
 if(id==='@rainbow-me/rainbowkit')return {ConnectButton:()=>React.createElement('button',null,'Wallet connected')}
 if(id==='next/link')return 'a'
 if(id==='next/image')return {__esModule:true,default:({unoptimized,...props})=>React.createElement('img',props)}
 if(id==='next/navigation')return {usePathname:()=>'/dashboard/wallet/bridge'}
 if(id==='../../dashboard-workspace'||id==='./dashboard-workspace')return {useDashboardWorkspace:()=>previewWorkspace}
 if(id==='@/components/NavBar')return {NavBar:()=>null}
 if(id==='@/components/ProductPreferencesProvider')return {useProductPreferences:()=>({preferences:{usdcDecimals:4,showSmallBalances:true,fundedChainsFirst:true,autoRefreshBalances:true,notifications:{bridgeCompleted:false,bridgeFailed:false,sellerSale:false,withdrawalCompleted:false}},formatUsdc:(value,atomic=false)=>(Number(value)/(atomic?1e6:1)).toFixed(4)}),sendLocalNotification:()=>{}}
 if(id==='./useBridgeJourney')return {useBridgeJourney:()=>previewJourney}
 return load.call(this,id,parent,main)
}
