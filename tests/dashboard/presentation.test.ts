import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

function cssFiles(path:string):string[]{
 return readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?cssFiles(join(path,entry.name)):entry.name.endsWith('.css')?[join(path,entry.name)]:[])
}

test('shared logo keeps its responsive scale while allowing the full artwork to render',()=>{
 const css=readFileSync('src/components/mahshar-logo.module.css','utf8')
 assert.match(css,/overflow:\s*visible/)
 assert.doesNotMatch(css,/overflow:\s*hidden/)
 for(const width of ['116px','142px','160px','184px'])assert.ok(css.includes(`width: ${width}`),width)
 assert.match(css,/height:\s*auto/)
})

test('landing navigation gets its own larger centered logo treatment',()=>{
 const logo=readFileSync('src/components/mahshar-logo.module.css','utf8')
 const navbar=readFileSync('src/components/NavBar.tsx','utf8')
 const navbarCss=readFileSync('src/components/nav-bar.module.css','utf8')
 const landing=readFileSync('src/app/page.tsx','utf8')
 for(const width of ['142px','170px','190px','215px'])assert.ok(logo.includes(`width: ${width}`),width)
 assert.match(logo,/\.landing \.image[^}]*position:\s*absolute[^}]*transform:\s*none/)
 assert.match(navbar,/landing \? styles\.landingNav : styles\.dashboardNav/)
 assert.match(navbarCss,/\.landingNavInner\s*\{[^}]*max-width:\s*1560px/)
 assert.match(landing,/<NavBar landing \/>/)
 assert.match(landing,/>MAHSHAR API MARKETPLACE<\/p>/)
 assert.doesNotMatch(landing,/h-px w-9 bg-\[#2775ca\]/)
})

test('app CSS uses readable semantic sizes instead of sub-13px text',()=>{
 const global=readFileSync('src/app/globals.css','utf8')
 assert.match(global,/--mahshar-caption-size:\s*13px/)
 assert.match(global,/--mahshar-support-size:\s*14px/)
 for(const file of [...cssFiles('src/app'),...cssFiles('src/components')]){
   const css=readFileSync(file,'utf8')
   assert.doesNotMatch(css,/font-size:\s*(?:[0-9]|1[0-2])px\b/,file)
 }
})

test('shared bridge amount control has subtle focus and a stronger MAX action',()=>{
 const css=readFileSync('src/app/dashboard/wallet/bridge/bridge.module.css','utf8')
 assert.match(css,/\.amount:focus-within[^}]*box-shadow:\s*inset/)
 assert.match(css,/\.amount input:focus[^}]*outline:\s*none/)
 assert.doesNotMatch(css,/\.amount:focus-within[^}]*0 0 0 3px/)
 assert.match(css,/\.amount button[^}]*color:\s*#135fae[^}]*font-weight:\s*800/i)
 assert.match(css,/\.amount button:hover:not\(:disabled\)/)
 assert.match(css,/\.amount button:focus-visible/)
})

test('shared dashboard card headings render once and Settings content opts out of value typography',()=>{
 const css=readFileSync('src/app/dashboard/dashboard.module.css','utf8')
 const settings=readFileSync('src/app/dashboard/settings/page.tsx','utf8')
 const headerRule=css.match(/\.headerCopy h2\s*\{[^}]*\}/)?.[0] ?? ''
 assert.ok(headerRule)
 assert.doesNotMatch(headerRule,/text-shadow/)
 assert.match(css,/\.card\s*>\s*div\.settingsCardBody:nth-child\(2\)[^}]*letter-spacing:\s*normal[^}]*line-height:\s*normal/)
 assert.equal(settings.match(/styles\.settingsCardBody/g)?.length,2)
 assert.match(css,/\.balanceValue\s*\{/)
 assert.match(css,/\.card :global\(\.font-mono\.text-2xl\)/)
})
