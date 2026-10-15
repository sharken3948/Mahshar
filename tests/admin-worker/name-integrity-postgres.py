"""Official naming, fallback, legacy preservation and pre-transport checks; disposable DB only."""
name_tables=['worker_sources','worker_providers','worker_products','worker_leads','admin_acquisition_attempts','admin_acquisition_attempt_history','admin_outreach_messages']
name_before={t:sql(f"SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM {t} x;") for t in name_tables}
functions_before=json.loads(sql("""SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND (p.proname LIKE 'mahshar_acquisition_%' OR p.proname LIKE 'mahshar_admin_outreach_%')
 AND p.proname NOT IN ('mahshar_acquisition_template_context','mahshar_acquisition_save_template_draft','mahshar_admin_outreach_reserve_send');"""))
import hashlib
name_migration_text=NAME_INTEGRITY.read_text()
print('Name migration SHA-256:',hashlib.sha256(name_migration_text.encode()).hexdigest(),flush=True)
old_reserve_definition=sql("SELECT pg_get_functiondef('mahshar_admin_outreach_reserve_send(uuid)'::regprocedure);")
try:sql('BEGIN;\n'+name_migration_text+'\nCOMMIT;')
except subprocess.CalledProcessError as error:raise AssertionError(error.stderr) from error
new_reserve_definition=sql("SELECT pg_get_functiondef('mahshar_admin_outreach_reserve_send(uuid)'::regprocedure);")
assert new_reserve_definition.replace('  PERFORM public.mahshar_admin_outreach_assert_invitation_integrity(p_message_id);\n','')==old_reserve_definition,'Existing reservation authorization must be unchanged'
for table,snapshot in name_before.items():
    projection="to_jsonb(x)-'naming_evidence'" if table=='worker_sources' else 'to_jsonb(x)'
    assert sql(f"SELECT coalesce(jsonb_agg({projection} ORDER BY id),'[]') FROM {table} x;")==snapshot,table
for signature,definition in functions_before.items():
    assert sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);")==definition.strip(),signature
for fn in ['mahshar_acquisition_template_context(uuid)','mahshar_acquisition_save_template_draft(uuid,uuid,uuid,text,text,text,text)',
           'mahshar_admin_outreach_assert_invitation_integrity(uuid,text,text,text)','mahshar_admin_outreach_reserve_send(uuid)']:
    for role in ['anon','authenticated']:assert sql(f"SELECT has_function_privilege('{role}','public.{fn}','EXECUTE');")=='f'
    assert sql(f"SELECT has_function_privilege('service_role','public.{fn}','EXECUTE');")=='t'
for role in ['anon','authenticated']:
    assert sql(f"SELECT has_table_privilege('{role}','worker_sources','SELECT');")=='f'
for fn in ['mahshar_invitation_render_v2(text,text)','mahshar_invitation_name_proof(jsonb,text)','mahshar_invitation_commercial_name(text,text)']:
    assert sql(f"SELECT has_function_privilege('service_role','public.{fn}','EXECUTE');")=='f'

for item in template_items:
    ctx=template_context(item)
    assert ctx['templateVariables']['company'] is None and ctx['templateVariables']['product'] is None
    assert ctx['templateVersion']=='mahshar-provider-invitation-v2'
    # Immutable v1 checkpoints are neither overwritten nor re-claimed.
    row=json.loads(sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE provider_id='{item['provider']}';"))
    assert row['draft_template_version']=='mahshar-provider-invitation-v1'
    expect_failure(f"UPDATE admin_acquisition_attempts SET body='replacement' WHERE id='{row['id']}';",'acquisition_template_immutable')
sql("UPDATE worker_providers SET status='rejected';")
name_saved=json.loads((ROOT/'tests/admin-worker/fixtures/invitation-name-saved.json').read_text())['providers']
def name_fixture(label,product='Developer Tools API'):
    domain=label+'.example'
    provider=sql(f"INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES({quoted(domain)},{quoted(domain)}) RETURNING id;")
    prod=sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','api',{quoted(product)}) RETURNING id;")
    lead=sql(f"""INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,contactability_status,email_ready,preferred_email,contact_researched_at)
      VALUES('{provider}','{prod}','qualified','qualified',90,true,'verified_email',true,'team@{domain}',clock_timestamp()) RETURNING id;""")
    sql(f"""INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at)
      VALUES('{provider}','{lead}','email','team@{domain}','api','https://{domain}/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp());""")
    source=sql(f"""INSERT INTO worker_sources(lead_id,source_type,source_role,title,url,factual_summary,checked_at)
      VALUES('{lead}','website','official_site',{quoted(product)},'https://{domain}/','Provider-owned site verified.',clock_timestamp()) RETURNING id;""")
    return {'provider':provider,'lead':lead,'product':prod,'source':source,'domain':domain}
def add_names(item,names,source=None):
    sql(f"UPDATE worker_sources SET naming_evidence={quoted(json.dumps(names))}::jsonb,checked_at=clock_timestamp() WHERE id='{source or item['source']}';")
def proof(name,kind='product'):
    return {'kind':kind,'name':name,'basis':'provider_statement','quote':f"Our {'company' if kind=='company' else 'API'} is called {name}."}
def name_context(item):
    return json.loads(sql(f"SET ROLE service_role; SELECT mahshar_acquisition_template_context('{item['lead']}');"))
def name_body(company=None,product=None):
    return json.loads(sql(f"SELECT mahshar_invitation_render_v2({'NULL' if company is None else quoted(company)},{'NULL' if product is None else quoted(product)});"))
def name_checkpoint(item,claim,key=None,body=None,version='mahshar-provider-invitation-v2',token=None):
    ctx=name_context(item);v=ctx['templateVariables'];expected=name_body(v['company'],v['product'])
    return sql(f"""SET ROLE service_role; SELECT mahshar_acquisition_save_template_draft('{claim['attemptId']}','{draft_epoch}',
      '{token or claim['claimToken']}',{quoted(key or ctx['key'])},{quoted(expected['subject'])},{quoted(expected['body'] if body is None else body)},{quoted(version)});""")

# Exact saved bad labels and arbitrary official page headings all fall back.
for index,saved in enumerate([p for p in name_saved if p['domain'] in ['hubhopper.com','netlicensing.io']]):
    item=name_fixture('unsafe'+str(index),saved['product'])
    for bad in [saved['product'],'Swagger UI','OpenAPI Documentation','Developer Portal','Demo API','Acme Sandbox']:
        add_names(item,[proof(bad)])
        assert name_context(item)['templateVariables']['product'] is None,bad
    add_names(item,[])
    claim=claim_draft();assert claim['providerId']==item['provider']
    assert name_checkpoint(item,claim,body=saved['savedBody'])=='f'
    assert name_checkpoint(item,claim,version='mahshar-provider-invitation-v1')=='f'
    assert name_checkpoint(item,claim)=='t'
    expected=name_body()
    row=json.loads(sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{claim['attemptId']}';"))
    assert row['body']==expected['body'] and row['body'].startswith('Hello team,')
    assert row['draft_variables']['company'] is None and row['draft_variables']['product'] is None
    assert name_checkpoint(item,claim)=='f' and claim_draft() is None
    assert all(row[k] is None for k in ['reserved_at','dispatched_at','provider_message_id'])

item=name_fixture('official')
add_names(item,[proof('Acme','company'),proof('Developer Tools API')])
ctx=name_context(item);assert ctx['templateVariables']['company']=='Acme' and ctx['templateVariables']['product']=='Developer Tools API'
claim=claim_draft();assert claim['providerId']==item['provider']
assert name_checkpoint(item,claim,key='wrong')=='f'
# Source titles do not verify names; contradictory explicit official naming falls back.
second=sql(f"INSERT INTO worker_sources(lead_id,source_type,source_role,url,title,checked_at) VALUES('{item['lead']}','website','official_docs','https://{item['domain']}/docs','Swagger UI',clock_timestamp()) RETURNING id;")
add_names(item,[proof('Different API')],second)
assert name_context(item)['templateVariables']['product'] is None
assert name_checkpoint(item,claim,key=ctx['key'])=='f'
add_names(item,[proof('Developer Tools API')],second)
assert name_context(item)['templateVariables']['product']=='Developer Tools API', 'duplicate proof is not a conflict'
stable_key=name_context(item)['key']
sql(f"UPDATE worker_sources SET checked_at=clock_timestamp() WHERE lead_id='{item['lead']}';")
assert name_context(item)['key']==stable_key,'timestamp-only proof refresh does not schedule another retry'
for source_type,source_role in [('api_directory','directory_assertion'),('website','directory_assertion')]:
    sql(f"UPDATE worker_sources SET source_type={quoted(source_type)},source_role={quoted(source_role)} WHERE lead_id='{item['lead']}';")
    assert name_context(item)['templateVariables']['company'] is None
    assert name_context(item)['templateVariables']['product'] is None
sql(f"UPDATE worker_sources SET source_type='website',source_role='official_docs' WHERE lead_id='{item['lead']}';")
# Stale proofs cannot be used, and DNC still blocks an otherwise valid rendering.
sql(f"UPDATE worker_sources SET checked_at=clock_timestamp()-interval '31 days' WHERE lead_id='{item['lead']}';")
assert name_context(item)['templateVariables']['product'] is None
sql(f"UPDATE worker_sources SET checked_at=clock_timestamp() WHERE lead_id='{item['lead']}';")
sql(f"UPDATE worker_providers SET status='do_not_contact' WHERE id='{item['provider']}';")
assert name_checkpoint(item,claim)=='f'
sql(f"UPDATE worker_providers SET status='active' WHERE id='{item['provider']}';")
sql(f"UPDATE admin_acquisition_attempts SET draft_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id='{claim['attemptId']}';")
recovered=claim_draft();assert recovered['claimToken']!=claim['claimToken']
assert name_checkpoint(item,recovered,token=claim['claimToken'])=='f'
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(lambda _:name_checkpoint(item,recovered),range(3)))
assert results.count('t')==1 and results.count('f')==2
assert claim_draft() is None, 'saved draft is not regenerated after restart'
row=json.loads(sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{claim['attemptId']}';"))
assert row['draft_template_version']=='mahshar-provider-invitation-v2'
assert row['body']==name_body('Acme','Developer Tools API')['body']
original=row['draft_variables']
add_names(item,[proof('New API')])
assert json.loads(sql(f"SELECT draft_variables FROM admin_acquisition_attempts WHERE id='{claim['attemptId']}';"))==original,'saved proof snapshot is immutable'

# Independent official structured Product/Organization metadata is accepted; WebPage/OpenAPI headings are not.
schema_item=name_fixture('schema')
for kind,schema_type in [('company','Organization'),('product','SoftwareApplication')]:
    name='Acme' if kind=='company' else 'Acme Developer API'
    schema_data={'@type':schema_type,'name':name,'url':f"https://{schema_item['domain']}/products",'description':'A commercial API service for developers.'}
    add_names(schema_item,[{'kind':kind,'name':name,'basis':'schema_org','data':schema_data}])
    assert name_context(schema_item)['templateVariables'][kind]==name
    for invalid in [{'@type':'WebPage'}, {'url':'https://lookalike.example.evil.test/'}, {'name':'Other title'}]:
        add_names(schema_item,[{'kind':kind,'name':name,'basis':'schema_org','data':schema_data|invalid}])
        assert name_context(schema_item)['templateVariables'][kind] is None
sql(f"UPDATE worker_providers SET status='rejected' WHERE id='{schema_item['provider']}';")

# Historical initial Outreach cannot bypass the new policy by prior approval or direct transport assertion.
def outreach_fixture(item,body):
    thread=sql(f"INSERT INTO admin_outreach_threads(provider_id,lead_id,status) VALUES('{item['provider']}','{item['lead']}','draft') RETURNING id;")
    message=sql(f"""INSERT INTO admin_outreach_messages(thread_id,direction,status,recipient_email,sender_email,subject,body,approved_at,approved_by)
      VALUES('{thread}','outbound','ready_to_send','team@{item['domain']}','support@mahshar.xyz','Invitation to list your API on Mahshar',{quoted(body)},clock_timestamp(),'0x1111111111111111111111111111111111111111') RETURNING id;""")
    return message
legacy=name_fixture('legacy-send')
old_text=next(p['savedBody'] for p in name_saved if p['domain']=='netlicensing.io')
message=outreach_fixture(legacy,old_text)
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_reserve_send('{message}');",'invitation_integrity_unverified_names')
assert sql(f"SELECT send_reserved_at IS NULL AND body={quoted(old_text)} FROM admin_outreach_messages WHERE id='{message}';")=='t'
sql(f"UPDATE admin_outreach_messages SET send_reserved_at=clock_timestamp() WHERE id='{message}';")
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{legacy['domain']}','Invitation to list your API on Mahshar',{quoted(old_text)});",'invitation_integrity_unverified_names')

safe=name_fixture('generic-send');generic=name_body();message=outreach_fixture(safe,generic['body'])
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{safe['domain']}',{quoted(generic['subject'])},{quoted(generic['body'])});",'invitation_integrity_payload_changed')
sql(f"UPDATE worker_providers SET status='do_not_contact' WHERE id='{safe['provider']}';")
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_reserve_send('{message}');",'admin_outreach_lead_blocked')
sql(f"UPDATE worker_providers SET status='active' WHERE id='{safe['provider']}';")
assert sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_reserve_send('{message}');")=='t'
assert sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{safe['domain']}',{quoted(generic['subject'])},{quoted(generic['body'])});")=='t'
# Safe generic wording remains acceptable when official metadata improves later.
add_names(safe,[proof('Acme','company'),proof('Developer API')])
assert sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{safe['domain']}',{quoted(generic['subject'])},{quoted(generic['body'])});")=='t'
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_reserve_send('{message}');",'admin_outreach_delivery_not_reservable')
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{safe['domain']}',{quoted(generic['subject'])},'changed');",'invitation_integrity_payload_changed')
assert sql(f"SELECT status='ready_to_send' AND sent_at IS NULL AND provider_message_id IS NULL FROM admin_outreach_messages WHERE id='{message}';")=='t'
print('PASS: name-integrity migration preserves history/old functions; v1 immutability; directory/heading rejection; verified official body/schema evidence; neutral/generic fallback; conflicts/freshness/DNC; fenced checkpoints/restart/concurrency; immutable proof snapshots; historical approval bypass blocked at reservation and final transport assertion; safe generic replay and no dispatch')

# A once-valid specific name is checked again immediately before a hypothetical transport.
named=name_fixture('named-send')
add_names(named,[proof('Acme','company'),proof('Acme Developer API')])
named_body=name_body('Acme','Acme Developer API')
message=outreach_fixture(named,named_body['body'])
assert sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_reserve_send('{message}');")=='t'
assert sql(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{named['domain']}',{quoted(named_body['subject'])},{quoted(named_body['body'])});")=='t'
add_names(named,[proof('Different API')])
expect_failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_assert_invitation_integrity('{message}','team@{named['domain']}',{quoted(named_body['subject'])},{quoted(named_body['body'])});",'invitation_integrity_unverified_names')
assert sql(f"SELECT status='ready_to_send' AND sent_at IS NULL AND provider_message_id IS NULL FROM admin_outreach_messages WHERE id='{message}';")=='t'
print('PASS: final assertion rechecks current official names after reservation; evidence changes block transport without rewriting the approved message')
