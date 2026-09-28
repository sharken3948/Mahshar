import Module from 'node:module'
import React from 'react'
const load = Module._load
export const world = /** @type {any} */ ({
  isConnected: true,
  sellerEarnings: null,
  myApis: [],
  sellCallGroups: [],
  earningsWithdrawAmount: '',
  setEarningsWithdrawAmount: () => {},
  earningsWithdrawStep: 'idle',
  earningsWithdrawError: null,
  earningsWithdrawResult: null,
  pendingWithdrawalRecovery: null,
  withdrawalRecoveryMessage: null,
  handleWithdrawEarnings: async () => {},
  handleCheckWithdrawalStatus: async () => {},
  privateAccess: false,
  signingIn: false,
  signInError: null,
  checkPrivateAccess: async () => false,
  openPrivateAccount: async () => {},
})
Module._load=function(id,parent,main){
 if(id.endsWith('.module.css'))return new Proxy({}, {get:(_,key)=>key==='__esModule'?false:String(key)})
 if(id==='@rainbow-me/rainbowkit')return {ConnectButton:()=>React.createElement('button',null,'Connect wallet')}
 if(id==='../dashboard-visuals')return {DashboardCardHeader:({title})=>React.createElement('h2',null,title),DashboardIcon:()=>null}
 if(id==='../dashboard-workspace')return {MIN_WITHDRAW_USDC:1,useDashboardWorkspace:()=>world}
 if(id==='@/components/ProductPreferencesProvider')return {useProductPreferences:()=>({formatUsdc:value=>Number(value).toFixed(4)})}
 if(id==='@/components/MarketplaceSessionProvider')return {useMarketplaceSession:()=>({request:async()=>Response.json({withdrawals:[]}),status:'authenticated',authenticate:async()=>true,error:null,wallet:null})}
 return load.call(this,id,parent,main)
}
