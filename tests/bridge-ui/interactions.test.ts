import { state, world, documentStub, renderStart, runEffects, reset } from './interaction-register.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Page from '../../src/app/dashboard/wallet/bridge/page'
type Node = {type:unknown;props:Record<string,any>}
let tree:Node
function all(node:unknown):Node[]{
 if(Array.isArray(node))return node.flatMap(all)
 if(!node||typeof node!=='object'||!('props' in node))return []
 const element=node as Node
 const children=typeof element.type==='function'&&element.type.name==='BridgeAmountControl'
   ? (element.type as (props:Record<string,any>)=>unknown)(element.props)
   : element.props.children
 return [element,...all(children)]
}
function find(predicate:(node:Node)=>boolean){const item=all(tree).find(predicate);assert.ok(item,'Expected element missing');return item!}
function render(){renderStart();tree=Page() as unknown as Node;const dropdown=find(node=>node.type==='div'&&node.props.className==='dropdown');dropdown.props.ref.current={contains:(target:unknown)=>target==='inside',querySelector:()=>null,querySelectorAll:()=>[]};const trigger=find(node=>node.type==='button'&&node.props['aria-haspopup']==='listbox');trigger.props.ref.current={focus:()=>{documentStub.activeElement='trigger'}};return tree}
function selector(){return find(node=>node.type==='button'&&node.props['aria-haspopup']==='listbox')}
function input(){return find(node=>node.type==='input'&&node.props.id==='bridge-amount')}
function primary(){return find(node=>node.type==='button'&&all(node).some(child=>child.props.children==='Bridge to Arc'))}
function option(name:string){return find(node=>node.props.role==='option'&&all(node).some(child=>child.type==='strong'&&child.props.children===name))}
function max(){return find(node=>node.type==='button'&&node.props.children==='MAX')}
function selectedName(){return find(node=>node.type==='strong'&&node.props.id==='source-value').props.children}
function selectedBalance(){return find(node=>node.type==='button'&&node.props['aria-haspopup']==='listbox').props.children[2].props.row.balance}
function selectedLogoChain(){return selector().props.children[0].props.chain}
function textContent(node:unknown):string{
 if(node===null||node===undefined||typeof node==='boolean')return ''
 if(typeof node==='string'||typeof node==='number'||typeof node==='bigint')return String(node)
 if(Array.isArray(node))return node.map(textContent).join(' ')
 if(typeof node==='object'&&'props' in node)return textContent((node as Node).props.children)
 return ''
}
function routeSummary(){return find(node=>node.type==='section'&&all(node).some(child=>child.type==='h2'&&child.props.children==='Route Summary'))}
function settle(){runEffects();render();runEffects();render()}
test('click, outside pointer and Escape open and close overlay without signing',()=>{
 reset();render();settle();assert.equal(selector().props['aria-expanded'],false)
 selector().props.onClick();render();assert.equal(selector().props['aria-expanded'],true)
 assert.equal(all(tree).filter(node=>node.props.role==='option').length,3)
 assert.equal(all(tree).some(node=>node.props.role==='option'&&all(node).some(child=>child.props.children==='Solana')),false)
 runEffects();documentStub.emit('pointerdown',{target:'outside'});render();assert.equal(selector().props['aria-expanded'],false)
 selector().props.onClick();render();const wrapper=find(node=>node.type==='div'&&node.props.className==='dropdown')
 wrapper.props.onKeyDown({key:'Escape',preventDefault(){}});render();assert.equal(selector().props['aria-expanded'],false)
 assert.equal(state.transfers,0);assert.equal(state.signatures,0)
})
test('selection, typing, clearing, MAX and refreshed balances update controlled UI',()=>{
 reset();render();settle();assert.equal(selectedName(),'Base');assert.equal(selectedBalance(),'1.2800')
 assert.equal(selectedLogoChain(),'Base')
 selector().props.onClick();render();option('Ethereum').props.onClick();render();runEffects();render()
 assert.equal(selectedName(),'Ethereum');assert.equal(selectedBalance(),'0.8500');assert.equal(selectedLogoChain(),'Ethereum');assert.equal(selector().props['aria-expanded'],false)
 input().props.onChange({target:{value:'0.1000'}});render();assert.equal(input().props.value,'0.1000');assert.equal(primary().props.disabled,false)
 input().props.onChange({target:{value:''}});render();assert.equal(input().props.value,'');assert.equal(primary().props.disabled,true)
 max().props.onClick();render();assert.equal(input().props.value,'0.8500');assert.equal(primary().props.disabled,false)
 world.bridgeBalances=world.bridgeBalances.map(row=>row.chainName==='Ethereum'?{...row,usdcBalance:'0.2500'}:row)
 render();runEffects();render();assert.equal(selectedName(),'Ethereum');assert.equal(selectedBalance(),'0.2500');assert.equal(primary().props.disabled,true)
 max().props.onClick();render();assert.equal(input().props.value,'0.2500');assert.equal(primary().props.disabled,false)
 assert.equal(state.transfers,0);assert.equal(state.signatures,0)
})
test('invalid amounts and pending recovery disable execution, while fields remain editable',()=>{
 reset();render();settle()
 input().props.onChange({target:{value:'1.280001'}});render();assert.equal(primary().props.disabled,true)
 input().props.onChange({target:{value:'0.5'}});render();assert.equal(primary().props.disabled,false)
 world.circleBridge.pending=true;render();assert.equal(primary().props.disabled,true);assert.equal(input().props.disabled,false);assert.equal(selector().props.disabled,false)
 input().props.onChange({target:{value:'0.1'}});render();assert.equal(input().props.value,'0.1')
 world.circleBridge.pending=false;render();assert.equal(primary().props.disabled,false)
 world.circleBridge.adapterReady=()=>false;render();assert.equal(primary().props.disabled,true)
 world.circleBridge.adapterReady=()=>true;render();assert.equal(primary().props.disabled,false)
 input().props.onChange({target:{value:'0'}});render();assert.equal(primary().props.disabled,true)
 assert.equal(state.transfers,0)
})
test('amount and chain changes invalidate old quote; estimates are read-only',async()=>{
 reset();render();settle();input().props.onChange({target:{value:'0.1000'}});render()
 const estimate=find(node=>node.type==='button'&&node.props.children==='Get Circle estimate ↻')
 await estimate.props.onClick();render();assert.equal(state.requests.length,1)
 assert.deepEqual(state.requests[0],{source:'Base',amount:'0.1000'})
 input().props.onChange({target:{value:'0.2000'}});render();runEffects();render()
 assert.equal(state.requests.length,1);assert.equal(state.signatures,0);assert.equal(state.transfers,0)
 selector().props.onClick();render();option('Ethereum').props.onClick();render();runEffects();render()
 assert.equal(selectedName(),'Ethereum');assert.equal(input().props.value,'0.2000')
})
test('Route Summary shows reliable pre-estimate fields and appends reported estimate details',async()=>{
 reset();render();settle();input().props.onChange({target:{value:'0.1000'}});render()
 let summary=textContent(routeSummary())
 for(const value of ['Route','Base','Arc Mainnet','You send','0.1000 USDC','Recipient','0x1111…1111','CCTP v2 · FAST','Circle Forwarding Service','Supported by Circle Bridge Kit'])assert.ok(summary.includes(value),value)
 for(const value of ['CCTP/provider fee','Forwarding fee','approval gas reserve','burn gas reserve','Destination mint gas','Estimated completion time','Total estimated cost','You receive','Unavailable','Not provided by Circle'])assert.ok(!summary.includes(value),value)
 const estimate=find(node=>node.type==='button'&&node.props.children==='Get Circle estimate ↻')
 estimate.props.onClick();await Promise.resolve();await Promise.resolve();render()
 summary=textContent(routeSummary())
 for(const value of ['CCTP/provider fee','0.01 USDC','Forwarding fee','0.02 USDC','Source-chain approval gas reserve','0.001 ETH','Source-chain burn gas reserve','0.0025 ETH','Destination mint gas','Paid and submitted by Circle','Estimate retrieved successfully'])assert.ok(summary.includes(value),value)
 for(const value of ['Estimated completion time','Total estimated cost','You receive','Unavailable','Not provided by Circle','supported and verified'])assert.ok(!summary.includes(value),value)
 assert.equal(state.transfers,0);assert.equal(state.signatures,0)
})
test('terminal failed Solana journey leaves valid Base button enabled; known small fee disables it',async()=>{
 reset();render();settle()
 world.circleBridge.result={amount:'0.01',state:'error',source:{chain:{name:'Solana',chain:'Solana'}},destination:{chain:{name:'Arc',chain:'Arc'}},steps:[{name:'burn',state:'error',errorMessage:'MaxFeeMustBeLessThanAmount'}]}
 world.circleBridge.pending=false;world.circleBridge.resumable=false
 input().props.onChange({target:{value:'0.1'}});render()
 assert.equal(primary().props.disabled,false)
 assert.equal(all(tree).some(node=>node.type==='button'&&node.props.children==='Resume with Circle'),false)
 input().props.onChange({target:{value:'0.01'}});render()
 const estimate=find(node=>node.type==='button'&&node.props.children==='Get Circle estimate ↻')
 await estimate.props.onClick();render()
 assert.equal(primary().props.disabled,true)
 assert.equal(state.transfers,0);assert.equal(state.signatures,0)
})
