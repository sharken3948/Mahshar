"""Executed inside the disposable multi-source PostgreSQL harness with --expanded."""
import uuid

stop_run(expired)
expansion = ROOT / 'supabase/migrations/20261018000200_admin_worker_source_expansion.sql'
email_guard = ROOT / 'supabase/migrations/20261018000300_admin_worker_email_identity_guard.sql'
before_expansion = snapshots()
sql('BEGIN;\n' + expansion.read_text() + '\nCOMMIT;')
assert snapshots() == before_expansion
assert sql('SELECT count(*) FROM worker_discovery_sources;') == '5'
for role in ['anon','authenticated']:
    failure(f"SET ROLE {role}; SELECT mahshar_worker_claim_discovery_request(NULL,'apis_guru',gen_random_uuid());", 'permission denied')

request_run = start_run()
def request(source='apis_guru', attempt=None, identifier=None):
    return data(f"mahshar_worker_claim_discovery_request('{identifier or request_run}',{quote(source)},'{attempt or uuid.uuid4()}')")
attempt = str(uuid.uuid4())
assert request(attempt=attempt) == 'claimed'
assert request(attempt=attempt) == 'replayed'
for _ in range(38):
    assert request() == 'claimed'
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    limited = list(pool.map(lambda _:request(),range(2)))
assert sorted(limited) == ['claimed','source_exhausted']
assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{request_run}';") == '40'
assert request('public_apis_dev') == 'claimed'
for disabled_source in ['rapidapi','postman','zyla','apilayer','api_market','allthingsdev','apyhub','apis_io','api_tracker','api_directory']:
    failure(f"SET ROLE service_role; SELECT mahshar_worker_claim_discovery_request('{request_run}',{quote(disabled_source)},gen_random_uuid());", 'worker_discovery_source_not_authorized')
assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{request_run}';") == '41'
data(f"mahshar_worker_advance_target_run('{request_run}',0,10,0,0,0,0,0,0,0,0,false,false,false)")
stop_run(request_run,10)
child = start_run(True)
assert request(identifier=child) == 'source_exhausted'
assert request('github_public_apis',identifier=child) == 'claimed'
sql(f"UPDATE worker_runs SET source_query_count=300 WHERE id='{child}';")
assert request('public_api_lists',identifier=child) == 'claimed'
assert request('apify_store',identifier=child) == 'exhausted'
data('mahshar_worker_request_stop()')
assert request('apify_store',identifier=child) == 'deadline_reached'
stop_run(child,10)
print('PASS: 46 baseline migrations + source expansion; atomic forty-request source caps, healthy-source continuation, Resume accounting, shared 301 cap, Stop and disabled-source denial',flush=True)

# Reproduce the proven baseline gap in a transaction that always rolls back.
collision_fixture = """DO $$ DECLARE p uuid; x uuid; l uuid; BEGIN
 FOR n IN 1..2 LOOP
  INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES('Collision Fixture','collision-'||n||'.example') RETURNING id INTO p;
  INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES(p,'api','Fixture API') RETURNING id INTO x;
  INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,email_ready,preferred_email,contactability_status)
   VALUES(p,x,'qualified','qualified',90,true,true,'shared@agency.example','verified_email') RETURNING id INTO l;
  INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at)
   VALUES(p,l,'email','shared@agency.example','business','https://collision-'||n||'.example/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp());
  INSERT INTO worker_sources(lead_id,source_type,source_role,url,checked_at) VALUES(l,'website','official_docs','https://collision-'||n||'.example/docs',clock_timestamp());
 END LOOP;
 IF (SELECT count(*) FROM admin_worker_mail_registry WHERE email_address='shared@agency.example' AND status='pending')<>2 THEN RAISE EXCEPTION 'collision_not_reproduced'; END IF;
END $$;"""
failure('BEGIN;\n'+collision_fixture+'\n'+email_guard.read_text()+'\nCOMMIT;', 'worker_mail_existing_email_collision_requires_review')
assert sql("SELECT count(*) FROM worker_providers WHERE canonical_domain LIKE 'collision-%.example';") == '0'
before_guard=snapshots()
old_functions=json.loads(sql("SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'mahshar_%';"))
sql('BEGIN;\n'+email_guard.read_text()+'\nCOMMIT;')
assert snapshots()==before_guard
for signature,definition in old_functions.items():
    if signature!='mahshar_worker_mail_candidate(uuid)':
        assert sql(f"SELECT pg_get_functiondef({quote(signature)}::regprocedure);")==definition.strip(),signature
for role in ['anon','authenticated']:
    failure(f"SET ROLE {role}; SELECT mahshar_worker_mail_email_reason(NULL,'private@example.com');",'permission denied')
    failure(f"SET ROLE {role}; SELECT mahshar_worker_discovery_ready();",'permission denied')
assert data('mahshar_worker_discovery_ready()') is True
assert sql('BEGIN; DROP INDEX worker_mail_unique_recipient; SELECT mahshar_worker_discovery_ready(); ROLLBACK;')=='f'
assert sql("SELECT indisunique AND indisvalid FROM pg_index WHERE indexrelid='worker_mail_unique_recipient'::regclass;")=='t'

def fixture(domain,email):
    p=sql(f"INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES('Synthetic API',{quote(domain)}) RETURNING id;")
    x=sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{p}','api','Synthetic API') RETURNING id;")
    l=sql(f"INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,email_ready,preferred_email,contactability_status) VALUES('{p}','{x}','qualified','qualified',90,true,true,{quote(email)},'verified_email') RETURNING id;")
    c=sql(f"INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at) VALUES('{p}','{l}','email',{quote(email)},'business','https://{domain}/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp()) RETURNING id;")
    sql(f"INSERT INTO worker_sources(lead_id,source_type,source_role,url,checked_at) VALUES('{l}','website','official_docs','https://{domain}/docs',clock_timestamp());")
    return {'provider':p,'product':x,'lead':l,'contact':c,'domain':domain,'email':email}

def owner_candidate(identifier):
    return json.loads(sql(f"SELECT to_jsonb(mahshar_worker_mail_candidate('{identifier}'));"))
assert sql("SELECT has_function_privilege('service_role','mahshar_worker_mail_candidate(uuid)','EXECUTE');")=='f'

first=fixture('shared-a.example','agency@shared.example')
assert owner_candidate(first['provider'])['eligible'] is True
second=fixture('shared-b.example','agency@shared.example')
for item in [first,second]:
    reason=owner_candidate(item['provider'])
    assert reason=={'eligible':False,'reason':'email_identity_conflict'}
assert sql("SELECT count(*) FROM worker_providers WHERE canonical_domain IN ('shared-a.example','shared-b.example');")=='2'
def raw_registry(item,status='pending'):
    sent=",manual_sent_at,marked_by" if status=='manual_sent' else ''
    sent_values=",clock_timestamp(),'0x1111111111111111111111111111111111111111'" if status=='manual_sent' else ''
    return f"INSERT INTO admin_worker_mail_registry(provider_id,identity_key,lead_id,contact_id,api_name,email_address,contact_source_url,contact_verified_at,status{sent}) VALUES('{item['provider']}','{item['domain']}','{item['lead']}','{item['contact']}','Synthetic API',{quote(item['email'])},'https://{item['domain']}/contact',clock_timestamp(),'{status}'{sent_values}) ON CONFLICT(provider_id) DO NOTHING;"
sql(raw_registry(second))
assert sql(f"SELECT status||':'||reason_code FROM admin_worker_mail_registry WHERE provider_id='{second['provider']}';")=='excluded:email_identity_conflict'
assert sql("SELECT count(*) FROM admin_worker_mail_registry WHERE lower(btrim(email_address))='agency@shared.example' AND status='pending';")=='1'
third=fixture('shared-c.example','agency@shared.example')
failure(raw_registry(third,'manual_sent').replace(' ON CONFLICT(provider_id) DO NOTHING',''), 'worker_mail_unique_recipient')
# Candidate-based listing hides ambiguous contacts without merging or rewriting either provider.
assert not any(row['emailAddress']=='agency@shared.example' for row in data('mahshar_worker_mail_list(p_limit=>100)')['items'])

manual=fixture('manual-other.example','api@known.example')
assert owner_candidate(manual['provider'])['reason']=='email_contact_history'
assert data(f"mahshar_worker_mail_email_reason('{manual['provider']}',' API@KNOWN.EXAMPLE ')")=='email_contact_history'
contacted=fixture('contacted.example','old@contacted.example')
sql(f"UPDATE worker_leads SET status='contacted' WHERE id='{contacted['lead']}';")
other=fixture('other-contacted.example','old@contacted.example')
assert owner_candidate(other['provider'])['reason']=='email_contact_history'
old=sql("INSERT INTO discovered_apis(repo_url,api_name,owner_email,invited) VALUES('https://legacy.example','Legacy','legacy@old.example',true) RETURNING id;")
legacy=fixture('different-legacy.example','legacy@old.example')
assert owner_candidate(legacy['provider'])['reason']=='email_contact_history'
valid=fixture('valid.example','business@valid.example')
assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{valid['provider']}';")=='pending'

# Lock contention is recoverable and creates no permanent exclusion or lost provider.
busy=fixture('busy.example','business@busy.example')
sql(f"DELETE FROM admin_worker_mail_registry WHERE provider_id='{busy['provider']}';")
import time
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    held=pool.submit(sql,"BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('worker-mail-email:business@busy.example',19370002)); SELECT pg_sleep(1); COMMIT;")
    time.sleep(0.15)
    data(f"mahshar_worker_mail_reconcile(p_dry_run=>false,p_provider_ids=>ARRAY['{busy['provider']}'::uuid])")
    assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{busy['provider']}';")=='0'
    held.result()
data(f"mahshar_worker_mail_reconcile(p_dry_run=>false,p_provider_ids=>ARRAY['{busy['provider']}'::uuid])")
assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{busy['provider']}';")=='pending'

# Actual concurrent insert paths hold conflicts and cannot produce a second pending email.
a=fixture('race-a.example','race@shared.example');b=fixture('race-b.example','race@shared.example')
sql(f"DELETE FROM admin_worker_mail_registry WHERE provider_id IN ('{a['provider']}','{b['provider']}');")
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(lambda item:sql(raw_registry(item)),[a,b]))
assert sql("SELECT count(*) FROM admin_worker_mail_registry WHERE email_address='race@shared.example' AND status='pending';")=='0'
assert sql("SELECT count(*) FROM worker_providers WHERE canonical_domain IN ('race-a.example','race-b.example');")=='2'
assert sql("SELECT status FROM admin_worker_mail_registry WHERE provider_id='"+provider+"';")=='manual_sent'
assert sql('SELECT count(*) FROM admin_outreach_messages;')=='0'
assert sql("SELECT desired_state FROM worker_control WHERE id=1;")=='stopped'
assert sql("SELECT desired_state FROM admin_acquisition_control WHERE id=1;")=='stopped'
assert sql("SELECT enabled FROM admin_acquisition_delivery_control WHERE id=1;")=='f'
print('PASS: duplicate-email gap reproduced; additive guard preserves old data/functions, normalized uniqueness, concurrent conflict holds, separate providers, manual/contacted/legacy history and automatic qualified enqueue',flush=True)
