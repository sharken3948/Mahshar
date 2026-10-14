import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import * as approve from '../../src/app/api/admin/outreach/drafts/[id]/approve/route'
import { getApprovedOutreachMessage } from '../../src/lib/admin-outreach/repository'
import * as send from '../../src/app/api/admin/outreach/drafts/[id]/send/route'

const id = '11111111-1111-4111-8111-111111111111'
const threadId = '22222222-2222-4222-8222-222222222222'
const context = { params: Promise.resolve({ id }) }
let reserved = false; let blocked = false; let calls = 0; let uncertain = false
beforeEach(() => {
  reset(); reserved=false; blocked=false; calls=0; uncertain=false
  process.env.ADMIN_WALLETS=alice.address; process.env.MAINNET_MODE='true'; process.env.BREVO_API_KEY='synthetic-only'
  state.tables.admin_outreach_messages=[{ id,thread_id:threadId,direction:'outbound',status:'ready_to_send',recipient_email:'team@fixture.example',sender_email:'support@mahshar.xyz',subject:'Fixture',body:'Fixture only',provider_message_id:null,reference_ids:[],reply_to_message_id:null,processing_state:'not_applicable',approved_at:new Date().toISOString(),created_at:new Date().toISOString(),updated_at:new Date().toISOString() }]
  boundary.rpcOverride=async (name,args) => {
    if (name==='mahshar_admin_outreach_approve_draft') return { data: {}, error: null }
    if (name==='mahshar_admin_outreach_reserve_send') {
      if (blocked || reserved) return { data:null,error:{message:'admin_outreach_lead_blocked'} }
      reserved=true; return { data:true,error:null }
    }
    if (name==='mahshar_admin_outreach_finish_send') {
      uncertain=args.p_provider_message_id===null
      if (uncertain) state.tables.admin_outreach_messages[0].send_uncertain_at=new Date().toISOString()
      return { data:{status:uncertain?'ready_to_send':'sent'},error:null }
    }
    throw new Error('Unexpected RPC')
  }
  globalThis.fetch=async () => { calls++; return new Response(JSON.stringify({messageId:'fixture-only-id'}),{status:201}) }
})
function request(path: string) { return new NextRequest(origin+path,{method:'POST',headers:sessionHeaders(alice)}) }

test('both manual approval and send reject a fresh suppression before transport', async () => {
  blocked=true
  assert.equal((await approve.POST(request('/api/admin/outreach/drafts/'+id+'/approve'),context)).status,409)
  assert.equal((await send.POST(request('/api/admin/outreach/drafts/'+id+'/send'),context)).status,503)
  assert.equal(calls,0); assert.equal(reserved,false)
})
test('concurrent approved sends dispatch once', async () => {
  const results=await Promise.all([send.POST(request('/api/admin/outreach/drafts/'+id+'/send'),context),send.POST(request('/api/admin/outreach/drafts/'+id+'/send'),context)])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,503]); assert.equal(calls,1)
})
test('accepted request with lost transport response persists uncertainty and cannot be resent', async () => {
  globalThis.fetch=async () => { calls++; throw new Error('Fixture response lost after acceptance') }
  assert.equal((await send.POST(request('/api/admin/outreach/drafts/'+id+'/send'),context)).status,503)
  assert.equal(uncertain,true); assert.equal(reserved,true)
  const projected = await getApprovedOutreachMessage(id)
  assert.equal(projected.delivery_uncertain,true)
  assert.equal((await send.POST(request('/api/admin/outreach/drafts/'+id+'/send'),context)).status,503)
  assert.equal(calls,1)
})
test('unconfigured transport preserves approved message without reservation', async () => {
  delete process.env.BREVO_API_KEY
  assert.equal((await send.POST(request('/api/admin/outreach/drafts/'+id+'/send'),context)).status,503)
  assert.equal(calls,0); assert.equal(reserved,false)
})
