// Render a deterministic visual fixture without a wallet, RPC or transaction.
import './visual-register.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import postcss from 'postcss'
import Page from '../../src/app/dashboard/wallet/bridge/page.tsx'
import { DashboardSidebar, DashboardBackgroundFlow } from '../../src/app/dashboard/dashboard-visuals.tsx'
const root=process.cwd()
function sheet(path,prefix){
 const css=postcss.parse(readFileSync(path,'utf8'))
 css.walkRules(rule=>{rule.selector=rule.selector.replace(/\.[A-Za-z_][\w-]*/g,match=>'.'+prefix+match.slice(1))})
 return css.toString()
}
const css=`:root{--mahshar-caption-size:13px;--mahshar-support-size:14px}*,*::before,*::after{box-sizing:border-box}body,h1,h2,h3,p,ul,ol,dl,dd{margin:0}button,input{font:inherit}button{border:0;background:transparent}a{text-decoration:none;color:inherit}body{font:14px Arial,sans-serif;color:#17263d;background:#f5f7fb}`
  +sheet(root+'/src/components/mahshar-logo.module.css','db-')
  +sheet(root+'/src/app/dashboard/dashboard.module.css','db-')
  +sheet(root+'/src/app/dashboard/wallet/bridge/bridge.module.css','br-')
const sidebar=renderToStaticMarkup(React.createElement(DashboardSidebar))
const flow=renderToStaticMarkup(React.createElement(DashboardBackgroundFlow))
function Probe(){
 const BridgePage=typeof Page==='function'?Page:Page.default
 const page=BridgePage()
 function inspect(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(inspect);return}if('type'in node){if(typeof node.type==='object'&&node.type!==null&&node.type!==React.Fragment)process.stderr.write(`Invalid page type ${Object.keys(node.type)} props ${Object.keys(node.props??{})}\n`);inspect(node.props?.children)}}
 inspect(page)
 return page
}
const page=renderToStaticMarkup(React.createElement(Probe))
const logo='data:image/png;base64,'+readFileSync(root+'/public/logo.png').toString('base64')
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Offline Bridge layout preview</title><style>${css}</style></head><body><div class="db-shell">${sidebar}<div class="db-topbar"><nav><div><div><span>Mahshar Balance: <b>0.032423 USDC</b></span><a href="#">Dashboard</a><div>Base &nbsp;⌄ &nbsp;&nbsp; 0x54...16de</div></div></div></nav></div><main class="db-main">${flow}${page}</main></div></body></html>`.replaceAll('src="/logo.png"',`src="${logo}"`).replace(/src="\/chain-logos\/([a-z_]+\.svg)"/g,(_,name)=>`src="data:image/svg+xml;base64,${readFileSync(root+'/public/chain-logos/'+name).toString('base64')}"`)
mkdirSync(root+'/.next/bridge-preview',{recursive:true})
const output=root+'/.next/bridge-preview/reference-preview.html'
writeFileSync(output,html)
process.stdout.write(output+'\n')
