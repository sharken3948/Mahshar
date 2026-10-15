/** Disposable-PostgreSQL integration runner. All HTTP is mocked; no env file is read. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import Module from 'node:module'
const config=JSON.parse(readFileSync(0,'utf8')) as {psql:string;socket:string;run:string;epoch:string;outcome:'success'|'rejected'|'ambiguous'}
const types: Record<string,Record<string,string>>={
  mahshar_acquisition_reserve_brevo:{p_run_id:'uuid',p_epoch:'uuid'},
  mahshar_admin_outreach_begin_transport:{p_message_id:'uuid',p_recipient:'text',p_subject:'text',p_body:'text',p_acquisition_enabled:'boolean'},
  mahshar_admin_outreach_finish_send:{p_message_id:'uuid',p_provider_message_id:'text'},
  mahshar_acquisition_reject_brevo:{p_message_id:'uuid',p_code:'text'},
}
function client(){return {rpc:async(name:string,args:Record<string,unknown>)=>{
  const spec=types[name];assert.ok(spec,'Unexpected database side effect: '+name)
  assert.deepEqual(Object.keys(args).sort(),Object.keys(spec).sort())
  const values=Object.entries(args).map(([key,value])=>`${key}=>${value===null?'NULL':"'"+String(value).replaceAll("'","''")+"'"}::${spec[key]}`)
  const query=`SET ROLE service_role; SELECT to_jsonb(public.${name}(${values.join(',')}));`
  const r=spawnSync(config.psql,['-X','-qAt','-v','ON_ERROR_STOP=1','-h',config.socket,'-p','55462','-U','worker_test','-d','postgres'],{input:query,encoding:'utf8'})
  return r.status===0?{data:r.stdout.trim()?JSON.parse(r.stdout):null,error:null}:{data:null,error:{message:r.stderr}}
}}}
const common=Module as unknown as {_load:(name:string,parent:unknown,isMain:unknown)=>unknown}
const load=common._load
common._load=function(name,parent,isMain){
  if(name==='server-only')return {}
  if(name==='@/lib/supabase/server')return {createServiceClient:client}
  return load.call(this,name,parent,isMain)
}
let requests=0
for(const key of ['ADMIN_ACQUISITION_BREVO_ENABLED','ADMIN_ACQUISITION_MODE','ADMIN_ACQUISITION_CONTINUOUS','MAINNET_MODE'])process.env[key]='true'
process.env.ADMIN_ACQUISITION_CANARY='false';process.env.BREVO_API_KEY='synthetic-never-sent'
globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.brevo.com/v3/smtp/email');assert.equal(++requests,1,'No HTTP replay is allowed')
  const body=JSON.parse(String(init?.body));assert.match(body.textContent,/listing one of your APIs on Mahshar/)
  assert.equal(body.subject,'Invitation to list your API on Mahshar');assert.match(body.headers.idempotencyKey,/^[0-9a-f-]{36}$/)
  if(config.outcome==='ambiguous')throw new Error('Mock response lost after possible acceptance')
  return config.outcome==='success'?new Response(JSON.stringify({messageId:'fixture-pg-brevo-id'}),{status:201})
    :new Response(JSON.stringify({code:'invalid_parameter'}),{status:400})
}
async function main(){
  const {deliverPreparedAcquisition}=await import('../../src/lib/admin-worker/acquisition-delivery')
  const expected=config.outcome==='success'?'sent':config.outcome==='rejected'?'provider_failed':'ambiguous_delivery'
  assert.deepEqual(await deliverPreparedAcquisition(config.run,config.epoch,1),[expected])
  assert.deepEqual(await deliverPreparedAcquisition(config.run,config.epoch,1),[])
  assert.equal(requests,1);process.stdout.write(JSON.stringify({outcome:expected,requests}))
}
main().catch(error=>{console.error(error);process.exitCode=1})
