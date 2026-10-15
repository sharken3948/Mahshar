import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { boundary } from '../admin/fixture'
import { reset } from '../marketplace/fixtures'
import { brevoAcquisitionEnabled } from '../../src/lib/admin-worker/acquisition-delivery-config'
import { deliverPreparedAcquisition } from '../../src/lib/admin-worker/acquisition-delivery'
import { sendOutreachEmail } from '../../src/lib/admin-outreach/transport'
import { acquisitionInvitation, outreachInvitation, providerActivity } from '../../src/lib/admin-worker/dashboard-repository'
import { renderInvitationTemplate } from '../../src/lib/admin-worker/invitation-template'

const template=renderInvitationTemplate({company:null,product:null,companyVerified:false,productVerified:false})
assert.ok(template.ok)
const message={id:'11111111-1111-4111-8111-111111111111',recipient:'team@fixture.example',...template.draft}
const flags=['ADMIN_ACQUISITION_BREVO_ENABLED','ADMIN_ACQUISITION_MODE','ADMIN_ACQUISITION_CONTINUOUS','MAINNET_MODE','BREVO_API_KEY']
let calls: string[]=[]; let reserved=false; let begun=false; let allowed=true; let http=0
let finishFailures=0; let failClaim=false; let receipt: unknown; let failure: unknown
beforeEach(()=>{
  reset();calls=[];reserved=false;begun=false;allowed=true;http=0;finishFailures=0;failClaim=false;receipt=undefined;failure=undefined
  flags.forEach(key=>{process.env[key]=key==='BREVO_API_KEY'?'synthetic-only':'true'})
  process.env.ADMIN_ACQUISITION_CANARY='false'
  boundary.rpcOverride=async(name,args)=>{
    calls.push(name)
    if(name==='mahshar_acquisition_reserve_brevo'){
      assert.equal(args.p_run_id,'run');assert.equal(args.p_epoch,'epoch')
      if(reserved)return {data:null,error:null}
      reserved=true
      return failClaim?{data:null,error:{message:'lost claim response'}}:{data:message,error:null}
    }
    if(name==='mahshar_admin_outreach_begin_transport'){
      assert.equal(args.p_acquisition_enabled,brevoAcquisitionEnabled())
      const match=args.p_recipient===message.recipient&&args.p_subject===message.subject&&args.p_body===message.body
      if(!allowed||!match||!args.p_acquisition_enabled)return {data:null,error:{message:'gate rejected'}}
      if(begun)return {data:false,error:null}
      begun=true;return {data:true,error:null}
    }
    if(name==='mahshar_admin_outreach_finish_send'){
      if(finishFailures-->0)return {data:null,error:{message:'fixture checkpoint failure'}}
      receipt=args.p_provider_message_id;return {data:{status:receipt===null?'ready_to_send':'sent'},error:null}
    }
    if(name==='mahshar_acquisition_reject_brevo'){failure=args.p_code;return {data:true,error:null}}
    throw new Error('Unexpected RPC: '+name)
  }
  globalThis.fetch=async(input,init)=>{
    http++;assert.equal(String(input),'https://api.brevo.com/v3/smtp/email')
    const payload=JSON.parse(String(init?.body))
    assert.equal(payload.textContent,message.body);assert.equal(payload.subject,message.subject)
    assert.deepEqual(payload.headers,{idempotencyKey:message.id});assert.deepEqual(payload.to,[{email:message.recipient}])
    assert.deepEqual(payload.sender,{name:'Mahshar',email:'support@mahshar.xyz'})
    return new Response(JSON.stringify({messageId:'fixture-brevo-id'}),{status:201})
  }
})

test('default off, each required flag, missing credentials and canary cause zero claims or HTTP',async()=>{
  for(const flag of flags){const saved=process.env[flag];delete process.env[flag];assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),[]);process.env[flag]=saved}
  process.env.ADMIN_ACQUISITION_CANARY='true';assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),[])
  assert.deepEqual(calls,[]);assert.equal(http,0)
})
test('successful delivery is separate, exact, bounded, receipt-persisted and never replayed',async()=>{
  assert.deepEqual(await deliverPreparedAcquisition('run','epoch',1),['sent']);assert.equal(receipt,'fixture-brevo-id')
  assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),[]);assert.equal(http,1)
  await assert.rejects(sendOutreachEmail(message),/invitation_integrity_required/);assert.equal(http,1)
  assert.equal(calls.filter(x=>x==='mahshar_admin_outreach_begin_transport').length,2)
})
for(const [status,code] of [[400,'invalid_parameter'],[401,'unauthorized'],[402,'not_enough_credits'],[403,'permission_denied'],[422,'invalid_parameter'],[429,'too_many_requests']] as const){
  test(`explicit Brevo rejection ${status}/${code} is checkpointed without resend`,async()=>{
    globalThis.fetch=async()=>{http++;return new Response(JSON.stringify({code}),{status})}
    assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['provider_failed'])
    assert.equal(failure,`brevo_${status}_${code}`);assert.equal(receipt,undefined)
    assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),[]);assert.equal(http,1)
  })
}
for(const [label,status,payload] of [
  ['duplicate idempotency key',400,{code:'duplicate_parameter'}],['server error',500,{code:'invalid_parameter'}],
  ['timeout response',408,{code:'invalid_parameter'}],['unknown rejection',400,{code:'unknown'}],
  ['conflicting receipt',400,{code:'invalid_parameter',messageIds:['already-accepted']}],
  ['missing receipt',201,{}],['blank receipt',201,{messageId:' '}],['simulated receipt',201,{messageId:'<simulated:fake'}],
  ['unexpected success status',200,{messageId:'fixture-brevo-id'}],
] as const){
  test(`${label} remains uncertain and cannot cause HTTP replay`,async()=>{
    globalThis.fetch=async()=>{http++;return new Response(JSON.stringify(payload),{status})}
    assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['ambiguous_delivery']);assert.equal(receipt,null)
    assert.equal(failure,undefined);await deliverPreparedAcquisition('run','epoch',10);assert.equal(http,1)
  })
}
test('network loss after possible acceptance is uncertain; no automatic transport retry',async()=>{
  globalThis.fetch=async()=>{http++;throw new Error('mock lost response')}
  assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['ambiguous_delivery']);assert.equal(receipt,null)
  await deliverPreparedAcquisition('run','epoch',10);assert.equal(http,1)
})
test('malformed JSON is uncertain',async()=>{
  globalThis.fetch=async()=>{http++;return new Response('not JSON',{status:201})}
  assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['ambiguous_delivery']);assert.equal(http,1);assert.equal(receipt,null)
})
test('final revoked approval or changed evidence blocks before HTTP, preserving reservation',async()=>{
  allowed=false;assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['provider_failed'])
  assert.equal(failure,'dispatch_blocked');assert.equal(http,0);assert.equal(reserved,true);assert.equal(begun,false)
})
test('lost committed claim response is never sent or reclaimed',async()=>{
  failClaim=true;assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),[])
  failClaim=false;assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),[]);assert.equal(http,0)
})
test('retrying receipt persistence makes one HTTP request only',async()=>{
  finishFailures=1;assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['sent'])
  assert.equal(http,1);assert.equal(receipt,'fixture-brevo-id')
  assert.equal(calls.filter(x=>x==='mahshar_admin_outreach_finish_send').length,2)
})
test('failed receipt checkpoints retain an uncertain permanent barrier',async()=>{
  finishFailures=2;assert.deepEqual(await deliverPreparedAcquisition('run','epoch',10),['ambiguous_delivery'])
  assert.equal(receipt,null);await deliverPreparedAcquisition('run','epoch',10);assert.equal(http,1)
})
test('invalid limits never touch database or transport',async()=>{
  for(const limit of [0,51,1.5,NaN])await assert.rejects(deliverPreparedAcquisition('run','epoch',limit),/batch_limit_invalid/)
  assert.deepEqual(calls,[]);assert.equal(http,0)
})
test('read-only dashboard distinguishes immutable, simulated, real accepted, rejection and uncertainty',()=>{
  const at='2026-10-15T10:00:00Z'
  const draft={id:'draft',status:'prepared',subject:message.subject,body:message.body,draft_generator:'template',draft_template_version:'mahshar-provider-invitation-v2',draft_prepared_at:at,draft_variables:{}}
  const base={...message,recipient_email:message.recipient,status:'ready_to_send',acquisition_attempt_id:'draft',send_reserved_at:at,admin_acquisition_attempts:draft}
  assert.equal(acquisitionInvitation(draft)?.delivery,'Not sent')
  assert.equal(acquisitionInvitation({...draft,status:'simulated_sent'})?.status,'Simulated')
  const accepted=outreachInvitation({...base,status:'sent',sent_at:at,provider_message_id:'real-fixture-id'})
  assert.equal(accepted.transport,'brevo');assert.equal(accepted.generator,'template');assert.equal(accepted.template_version,'mahshar-provider-invitation-v2')
  assert.equal(accepted.status,'Sent');assert.equal(accepted.delivery,'Accepted · delivery unconfirmed')
  assert.equal(outreachInvitation({...base,acquisition_failure_at:at,acquisition_failure_code:'brevo_400_invalid_parameter'}).status,'Brevo rejected')
  assert.equal(outreachInvitation({...base,acquisition_dispatch_started_at:at}).delivery,'Uncertain · do not resend')
  const p=providerActivity({id:'p',canonical_name:'Fixture',canonical_domain:'fixture.example',worker_leads:[]},draft,[{...base,acquisition_failure_at:at}])
  assert.equal(p.invitation,'Brevo rejected');assert.match(p.delivery,/no automatic retry/)
})
