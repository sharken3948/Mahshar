"""Disabled-by-default Brevo acquisition; disposable database + mocked HTTP only."""
brevo_tables=json.loads(sql("""SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'
 AND (tablename LIKE 'worker_%' OR tablename LIKE 'admin_acquisition_%' OR tablename LIKE 'admin_outreach_%');"""))
new_fields=['acquisition_attempt_id','acquisition_run_id','acquisition_epoch','acquisition_dispatch_started_at','acquisition_failure_at','acquisition_failure_code',
 'permission_basis','permission_reference','reviewed_by','reviewed_at']
def brevo_snapshot(table):
    projection='to_jsonb(r)'+''.join('-'+quoted(c) for c in new_fields)
    return sql(f"SELECT md5(coalesce(string_agg(p::text,'' ORDER BY p::text),'')) FROM (SELECT {projection} p FROM {table} r) x;")
brevo_history={t:brevo_snapshot(t) for t in brevo_tables}
brevo_functions=json.loads(sql("""SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname LIKE 'mahshar_worker_%' OR p.proname LIKE 'mahshar_acquisition_%' OR p.proname LIKE 'mahshar_admin_outreach_%');"""))
expect_failure('BEGIN;\n'+BREVO_DELIVERY.read_text()+"\nDO $$ BEGIN RAISE EXCEPTION 'rollback_brevo'; END $$;COMMIT;",'rollback_brevo')
assert sql("SELECT to_regclass('admin_acquisition_delivery_control');") == ''
try:sql('BEGIN;\n'+BREVO_DELIVERY.read_text()+'\nCOMMIT;')
except subprocess.CalledProcessError as error:raise AssertionError(error.stderr) from error
for t,snapshot in brevo_history.items():assert brevo_snapshot(t)==snapshot,t
for signature,definition in brevo_functions.items():
    if signature not in ['mahshar_acquisition_reserve(uuid,uuid,text,text,text)','mahshar_acquisition_metrics()']:
        assert sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);")==definition.strip(),signature
assert sql('SELECT enabled FROM admin_acquisition_delivery_control;')=='f'
assert sql("SELECT count(*) FROM admin_acquisition_eligibility WHERE channel='brevo';")=='0'
public_fns=['mahshar_acquisition_reserve_brevo(uuid,uuid)','mahshar_admin_outreach_begin_transport(uuid,text,text,text,boolean)','mahshar_acquisition_reject_brevo(uuid,text)']
private_fns=['mahshar_acquisition_brevo_eligible(uuid)','mahshar_acquisition_assert_brevo(uuid)','mahshar_acquisition_daily_reserved()','mahshar_acquisition_immutable_delivery()']
for fn in public_fns+private_fns:
    for role in ['anon','authenticated']:assert sql(f"SELECT has_function_privilege('{role}','public.{fn}','EXECUTE');")=='f'
    assert sql(f"SELECT has_function_privilege('service_role','public.{fn}','EXECUTE');")==('t' if fn in public_fns else 'f')
for role in ['anon','authenticated','service_role']:
    for privilege in ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']:
        assert sql(f"SELECT has_table_privilege('{role}','admin_acquisition_delivery_control','{privilege}');")==('t' if role=='service_role' and privilege=='SELECT' else 'f')
assert sql("SELECT relrowsecurity FROM pg_class WHERE oid='admin_acquisition_delivery_control'::regclass;")=='t'
expect_failure('SET ROLE service_role; UPDATE admin_acquisition_delivery_control SET enabled=true;','permission denied')
expect_failure("SET ROLE service_role; UPDATE admin_acquisition_eligibility SET channel='brevo';",'permission denied')
expect_failure('UPDATE admin_acquisition_delivery_control SET enabled=true;','check constraint')
old_unsafe=json.loads(sql("""SELECT to_jsonb(m) FROM admin_outreach_messages m JOIN admin_outreach_threads t ON t.id=m.thread_id
 JOIN worker_providers p ON p.id=t.provider_id WHERE p.canonical_domain='legacy-send.example' LIMIT 1;"""))
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_begin_transport('{old_unsafe['id']}',{quoted(old_unsafe['recipient_email'])},{quoted(old_unsafe['subject'])},{quoted(old_unsafe['body'])},true);",'invitation_integrity_unverified_names')
for old in template_items:
    assert sql(f"SELECT mahshar_acquisition_brevo_eligible(id) FROM admin_acquisition_attempts WHERE provider_id='{old['provider']}';")=='f'
print('PASS: additive Brevo migration rollback, history preservation, existing lifecycle/dispatch/naming functions unchanged, disabled defaults, RLS and service-only least privilege',flush=True)

# All state changes below are isolated fixtures, never Production commands.
sql("UPDATE worker_runs SET status='stopped'; UPDATE worker_control SET desired_state='stopped'; UPDATE admin_acquisition_control SET desired_state='stopped'; UPDATE worker_providers SET status='rejected';")
draft_run=rpc_json('mahshar_worker_create_target_run(false)')['id']
rpc_json(f"mahshar_worker_claim_run('{draft_run}')")
draft_epoch=rpc_json('mahshar_acquisition_set_state(true,false,NULL)')['epoch']
reviewer='0x1111111111111111111111111111111111111111'
def brevo_enable():
    sql(f"""UPDATE admin_acquisition_delivery_control SET enabled=true,sender_verified_at=clock_timestamp(),policy_reviewed_at=clock_timestamp(),
      policy_reference='Disposable fixture policy review',reviewed_by='{reviewer}',expires_at=clock_timestamp()+interval '1 day';""")
def permission(item,channel='brevo'):
    sql(f"""INSERT INTO admin_acquisition_eligibility(provider_id,recipient_email,channel,basis,expires_at,permission_basis,permission_reference,reviewed_by,reviewed_at)
      VALUES('{item['provider']}','team@{item['domain']}',{quoted(channel)},'Disposable test authorization',clock_timestamp()+interval '1 day',
      'requested_invitation','Disposable consent fixture','{reviewer}',clock_timestamp());""")
def brevo_draft(label,named=False):
    item=name_fixture('brevo-'+label)
    if named:add_names(item,[proof('Acme','company'),proof('Developer Tools API')])
    claim=claim_draft();assert claim and claim['providerId']==item['provider'],(label,claim)
    assert name_checkpoint(item,claim)=='t'
    item['attempt']=claim['attemptId']
    item['snapshot']=sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{item['attempt']}';")
    return item
def reserve_brevo():
    value=sql(f"SET ROLE service_role; SELECT mahshar_acquisition_reserve_brevo('{draft_run}','{draft_epoch}');")
    return json.loads(value) if value else None
def begin_brevo(message,enabled=True,body=None):
    return sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_begin_transport('{message['id']}',{quoted(message['recipient'])},{quoted(message['subject'])},{quoted(body or message['body'])},{str(enabled).lower()});")
def message_row(message):return json.loads(sql(f"SELECT to_jsonb(m) FROM admin_outreach_messages m WHERE id='{message['id']}';"))
item=brevo_draft('default')
permission(item,'mock');assert reserve_brevo() is None
permission(item);assert reserve_brevo() is None,'recipient permission alone cannot activate channel'
brevo_enable()
# Reset only fixture simulated slots so the real/shared quota checks are independent.
sql("UPDATE admin_acquisition_attempts SET reserved_at=date_trunc('day',clock_timestamp(),'UTC')-interval '1 hour' WHERE NOT draft_only;")
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:claims=list(pool.map(lambda _:reserve_brevo(),range(3)))
assert sum(bool(c) for c in claims)==1
message=next(c for c in claims if c);row=message_row(message)
assert row['send_reserved_at'] and row['acquisition_attempt_id']==item['attempt'] and row['approved_by']==reviewer
assert sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{item['attempt']}';")==item['snapshot']
expect_failure(f"UPDATE admin_outreach_messages SET body='replacement' WHERE id='{message['id']}';",'acquisition_delivery_immutable')
expect_failure(f"DELETE FROM admin_outreach_messages WHERE id='{message['id']}';",'acquisition_delivery_immutable')
expect_failure(f"UPDATE admin_outreach_messages SET send_reserved_at=NULL WHERE id='{message['id']}';",'acquisition_delivery_immutable')
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_finish_send('{message['id']}','fake-before-transport');",'acquisition_delivery_invalid_receipt')
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_begin_transport('{message['id']}',{quoted(message['recipient'])},{quoted(message['subject'])},{quoted(message['body'])},false);",'acquisition_delivery_disabled')
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_begin_transport('{message['id']}',{quoted(message['recipient'])},{quoted(message['subject'])},'altered',true);",'invitation_integrity_payload_changed')
for mutation,restore in [
 ("UPDATE admin_acquisition_delivery_control SET enabled=false;","UPDATE admin_acquisition_delivery_control SET enabled=true;"),
 (f"UPDATE admin_acquisition_eligibility SET expires_at=clock_timestamp()-interval '1 second',reviewed_at=clock_timestamp()-interval '1 day' WHERE provider_id='{item['provider']}' AND channel='brevo';",f"UPDATE admin_acquisition_eligibility SET expires_at=clock_timestamp()+interval '1 day' WHERE provider_id='{item['provider']}' AND channel='brevo';"),
 (f"UPDATE worker_providers SET status='do_not_contact' WHERE id='{item['provider']}';",f"UPDATE worker_providers SET status='active' WHERE id='{item['provider']}';"),
 (f"UPDATE worker_leads SET status='closed' WHERE id='{item['lead']}';",f"UPDATE worker_leads SET status='qualified' WHERE id='{item['lead']}';"),
 (f"UPDATE worker_contacts SET email_ready=false WHERE lead_id='{item['lead']}';",f"UPDATE worker_contacts SET email_ready=true WHERE lead_id='{item['lead']}';"),
 (f"UPDATE admin_outreach_threads SET status='do_not_contact' WHERE id='{row['thread_id']}';",f"UPDATE admin_outreach_threads SET status='draft' WHERE id='{row['thread_id']}';"),
 ("UPDATE worker_control SET desired_state='stopped';","UPDATE worker_control SET desired_state='running';"),
 ("UPDATE admin_acquisition_control SET desired_state='stopped';","UPDATE admin_acquisition_control SET desired_state='running';"),
 ("UPDATE admin_acquisition_control SET epoch=gen_random_uuid();",f"UPDATE admin_acquisition_control SET epoch='{draft_epoch}';"),
 ("UPDATE admin_acquisition_control SET operating_mode='canary';","UPDATE admin_acquisition_control SET operating_mode='continuous';"),
 (f"UPDATE worker_runs SET status='stopped' WHERE id='{draft_run}';",f"UPDATE worker_runs SET status='running' WHERE id='{draft_run}';"),
 (f"UPDATE worker_contacts SET verified_at=clock_timestamp()-interval '31 days' WHERE lead_id='{item['lead']}';",f"UPDATE worker_contacts SET verified_at=clock_timestamp() WHERE lead_id='{item['lead']}';"),
 (f"UPDATE worker_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id='{draft_run}';",f"UPDATE worker_runs SET deadline_at=clock_timestamp()+interval '15 minutes' WHERE id='{draft_run}';"),
]:
    sql(mutation)
    try:begin_brevo(message);raise AssertionError('gate accepted revoked fixture')
    except subprocess.CalledProcessError as error:assert 'acquisition_delivery_not_authorized' in error.stderr,error.stderr
    assert message_row(message)['acquisition_dispatch_started_at'] is None
    sql(restore)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:begins=list(pool.map(lambda _:begin_brevo(message),range(3)))
assert begins.count('t')==1 and begins.count('f')==2
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_finish_send('{message['id']}','<simulated:fake');",'acquisition_delivery_invalid_receipt')
for _ in range(2):sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_finish_send('{message['id']}','real-disposable-receipt');")
assert message_row(message)['status']=='sent' and reserve_brevo() is None
assert sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{item['attempt']}';")==item['snapshot']
print('PASS: current V2 exact immutable payload, channel/recipient separation, concurrent provider reservation and one-shot dispatch, recheck DNC/contact/thread/expiry/Stop/deadline, no simulated receipt, idempotent real receipt without rewriting draft',flush=True)

# Rejection/uncertainty preserve immutable reservations; newly discovered email is not consent.
missing=brevo_draft('no-consent');assert reserve_brevo() is None
expect_failure(f"INSERT INTO admin_acquisition_eligibility(provider_id,recipient_email,channel,basis,expires_at) VALUES('{missing['provider']}','team@{missing['domain']}','brevo','Published email address',clock_timestamp()+interval '1 day');",'check constraint')
permission(missing,'mock');assert reserve_brevo() is None
sql(f"UPDATE worker_providers SET status='rejected' WHERE id='{missing['provider']}';")
for label in ['rejected','uncertain','named-changed','legacy-thread']:
    item=brevo_draft(label,named=label=='named-changed');permission(item)
    if label=='legacy-thread':
        outreach_fixture(item,name_body()['body']);assert reserve_brevo() is None;continue
    message=reserve_brevo();assert message
    if label=='named-changed':
        add_names(item,[proof('Different API')])
        try:begin_brevo(message);raise AssertionError('stale naming accepted')
        except subprocess.CalledProcessError as error:assert 'acquisition_delivery_not_authorized' in error.stderr
        assert reserve_brevo() is None;continue
    assert begin_brevo(message)=='t'
    if label=='rejected':
        for _ in range(2):sql(f"SET ROLE service_role; SELECT mahshar_acquisition_reject_brevo('{message['id']}','brevo_400_invalid_parameter');")
        assert message_row(message)['acquisition_failure_at']
        expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_finish_send('{message['id']}','fake-accepted');",'acquisition_delivery_invalid_receipt')
    else:
        sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_finish_send('{message['id']}',NULL);")
        assert message_row(message)['send_uncertain_at']
    assert begin_brevo(message)=='f' and reserve_brevo() is None
print('PASS: no implicit consent from published email/mock approval, rejection and uncertainty retained without retries, changed naming and preexisting Outreach block real dispatch',flush=True)

# Execute the actual TS acquisition -> shared transport -> real SQL functions -> receipt path.
for outcome in ['success','rejected','ambiguous']:
    item=brevo_draft('e2e-'+outcome);permission(item)
    payload={'psql':str(BIN/'psql'),'socket':str(root),'run':draft_run,'epoch':draft_epoch,'outcome':outcome}
    runner_env={k:v for k,v in ENV.items() if k in ['PATH','LD_LIBRARY_PATH','HOME','TMPDIR']}
    result=subprocess.run(['node','--import','tsx',str(ROOT/'tests/admin-worker/brevo-postgres-runner.ts')],cwd=ROOT,env=runner_env,
      input=json.dumps(payload),capture_output=True,text=True,timeout=45)
    assert result.returncode==0,result.stdout+result.stderr
    delivered=json.loads(sql(f"SELECT to_jsonb(m) FROM admin_outreach_messages m WHERE acquisition_attempt_id='{item['attempt']}';"))
    assert delivered['acquisition_dispatch_started_at'] and delivered['send_reserved_at']
    assert (delivered['status']=='sent')==(outcome=='success')
    assert bool(delivered['acquisition_failure_at'])==(outcome=='rejected')
    assert bool(delivered['send_uncertain_at'])==(outcome=='ambiguous')
    assert sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{item['attempt']}';")==item['snapshot']
print('PASS: end-to-end TS coordinator, actual disposable PostgreSQL RPCs and mocked Brevo acceptance/rejection/lost response; one HTTP request across replay; original drafts preserved',flush=True)

# Shared cap: preserved mock + real slots, serialized last available slot, UTC boundaries.
used=int(sql("SET ROLE service_role; SELECT mahshar_acquisition_metrics()->>'daily_sends';"))
# Old simulated reservations exist; move exactly enough into today to reach 24.
needed=24-used
ids=json.loads(sql(f"SELECT json_agg(id) FROM (SELECT id FROM admin_acquisition_attempts WHERE NOT draft_only AND status IN ('reserved','simulated_sent','uncertain') ORDER BY id LIMIT {needed}) a;"))
assert ids and len(ids)==needed
sql("UPDATE admin_acquisition_attempts SET reserved_at=clock_timestamp() WHERE id IN ("+','.join(quoted(i) for i in ids)+');')
assert sql("SET ROLE service_role; SELECT mahshar_acquisition_metrics()->>'daily_sends';")=='24'
quota_items=[brevo_draft('last-slot-'+str(i)) for i in range(2)]
for item in quota_items:permission(item)
def last_real_slot(_):
    try:return reserve_brevo()
    except subprocess.CalledProcessError as error:
        assert 'acquisition_daily_send_limit' in error.stderr,error.stderr
        return 'limited'
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:last_claims=list(pool.map(last_real_slot,range(2)))
assert last_claims.count('limited')==1 and sum(isinstance(c,dict) for c in last_claims)==1,last_claims
assert sql("SET ROLE service_role; SELECT mahshar_acquisition_metrics()->>'daily_sends';")=='25'
for zone in ['Pacific/Honolulu','Pacific/Kiritimati']:
    assert sql(f"SET ROLE service_role; SET TIME ZONE '{zone}'; SELECT mahshar_acquisition_metrics()->>'daily_sends';")=='25'
print('PASS: shared mock/real 25 UTC reservation ceiling, concurrent final slot, original 20-run and research/Groq quotas untouched',flush=True)
