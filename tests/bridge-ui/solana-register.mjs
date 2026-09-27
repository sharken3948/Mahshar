import Module from 'node:module'
import React from 'react'
const load = Module._load
export const calls = []
export const state = { successful: false }
const owner = '0x'+'11'.repeat(20)
const route = { source: { chain: 'Solana', name: 'Solana', type: 'solana' }, useForwarder: true }
const result = { amount:'1', token:'USDC', provider:'CCTPV2BridgingProvider', state:'success', source:{address:'So11111111111111111111111111111111111111112',chain:route.source}, destination:{address:owner,recipientAddress:owner,chain:{chain:'Arc',name:'Arc Mainnet',type:'evm'}}, steps:[] }
Module._load=function(id,parent,main){
 if(id.endsWith('.module.css'))return new Proxy({}, {get:(_,key)=>key==='__esModule'?false:String(key)})
 if(id==='next/link')return {__esModule:true,default:'a'}
 if(id==='../dashboard-visuals')return {DashboardCardHeader:({title})=>title,DashboardIcon:()=>null,UsdcUnit:()=> 'USDC'}
 if(id==='@/components/ProductPreferencesProvider')return {useProductPreferences:()=>({preferences:{notifications:{bridgeCompleted:false}}}),sendLocalNotification:()=>calls.push('notification')}
 if(id==='../wallet/bridge/useBridgeJourney')return {useBridgeJourney:()=>({active:state.successful?{id:'solana-success',amount:'1',source:'Solana',deposit:'unavailable',result}:null,activity:[],working:false,bridging:false,depositing:false,error:null,start:()=>calls.push('start'),deposit:()=>calls.push('deposit')})}
 if(id==='../dashboard-workspace')return {useDashboardWorkspace:()=>({
   isConnected:true,address:owner,scheduleWalletRefresh:()=>{},solanaPubkey:{toBase58:()=> 'So11111111111111111111111111111111111111112'},
   solanaConnected:true,solanaDisconnect:async()=>calls.push('disconnect'),setSolanaModalVisible:()=>calls.push('modal'),solanaBalance:{usdcBalance:'2.5',isLoading:false,error:null},
   circleBridge:{catalog:{routes:[route]},result:state.successful?result:null,pending:false,resumable:false,isLoading:false,liveSteps:[],stepLabel:state.successful?'USDC confirmed in Arc wallet':'Ready to bridge',error:null,technicalError:null,recoveryNotice:null,adapterReady:()=>true,estimate:()=>calls.push('estimate'),retry:()=>calls.push('retry'),reset:()=>calls.push('reset')},
 })}
 return load.call(this,id,parent,main)
}
