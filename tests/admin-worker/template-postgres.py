"""Additive template migration regressions on disposable PostgreSQL only."""
before_template = {table: sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;")
                   for table in ['worker_providers','worker_products','worker_leads','worker_contacts','worker_sources',
                                 'admin_acquisition_attempts','admin_acquisition_attempt_history','admin_outreach_messages']}
protected_functions = json.loads(sql("""SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname LIKE 'mahshar_outreach_%' OR p.proname LIKE 'mahshar_acquisition_%')
 AND p.proname NOT IN ('mahshar_acquisition_claim_draft','mahshar_acquisition_record_draft');"""))
try:
    sql('BEGIN;\n' + STANDARD_TEMPLATE.read_text() + '\nCOMMIT;')
except subprocess.CalledProcessError as error:
    raise AssertionError(error.stderr) from error
for table, original in before_template.items():
    projection = "to_jsonb(t)-'draft_template_version'-'draft_variables'" if table=='admin_acquisition_attempts' else 'to_jsonb(t)'
    assert sql(f"SELECT coalesce(jsonb_agg({projection} ORDER BY id),'[]') FROM {table} t;") == original, table
for signature, definition in protected_functions.items():
    assert sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);") == definition.strip(), signature
for function in ['mahshar_acquisition_template_context(uuid)', 'mahshar_acquisition_save_template_draft(uuid,uuid,uuid,text,text,text,text)']:
    for role in ['anon','authenticated']:
        assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');")=='f'
    assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');")=='t'
for privilege in ['INSERT','UPDATE','DELETE']:
    assert sql(f"SELECT has_table_privilege('service_role','admin_acquisition_attempts','{privilege}');")=='f'
for invalid in ['', 'Unknown', '[Company]', 'Acme <script>', 'Acme\nBcc: x', 'https://evil.test', 'team@evil.test', 'Acme\u202eevil', 'Acme\u200b', ' Acme', 'A'*201]:
    assert sql(f"SELECT mahshar_acquisition_render_template({quoted(invalid)},'API') IS NULL;")=='t', repr(invalid)
assert sql("SELECT mahshar_acquisition_render_template('Météo 日本','Weather API') IS NOT NULL;")=='t'

# Fresh local fixtures: existing Groq rows remain intact and excluded from claims.
sql("UPDATE worker_providers SET status='rejected'; UPDATE worker_runs SET status='stopped' WHERE status IN ('running','queued','stop_requested');")
draft_run=rpc_json('mahshar_worker_create_target_run(false)')['id']
rpc_json(f"mahshar_worker_claim_run('{draft_run}')")
draft_epoch=rpc_json('mahshar_acquisition_set_state(true,false,NULL)')['epoch']
template_items=[]
for index,fixture in enumerate(saved_providers):
    domain='template-'+fixture['domain']
    provider=sql(f"INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES({quoted(domain)},{quoted(domain)}) RETURNING id;")
    product=sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','api',{quoted(fixture['product'])}) RETURNING id;")
    lead=sql(f"""INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,contactability_status,email_ready,preferred_email,contact_researched_at)
      VALUES('{provider}','{product}','qualified','qualified',{90-index},true,'verified_email',true,{quoted(fixture['email'])},clock_timestamp()) RETURNING id;""")
    sql(f"""INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at)
      VALUES('{provider}','{lead}','email',{quoted(fixture['email'])},'api','https://{domain}/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp());
      INSERT INTO worker_sources(lead_id,source_type,source_role,title,url,factual_summary,checked_at) VALUES
        ('{lead}','website','official_site',{quoted(domain)},'https://{domain}/','Verified official identity',clock_timestamp()),
        ('{lead}','api_directory','directory_assertion',{quoted(fixture['product'])},{quoted(fixture['contractUrl'])},{quoted(fixture['contractSummary'])},clock_timestamp());""")
    template_items.append({'provider':provider,'product':product,'lead':lead,'fixture':fixture,'domain':domain})
def template_context(item):
    return json.loads(sql(f"SET ROLE service_role; SELECT mahshar_acquisition_template_context('{item['lead']}');"))
def template_save(item,claim,key=None,token=None,epoch=None,body=None):
    context=template_context(item)
    expected=json.loads(sql(f"SELECT mahshar_acquisition_render_template({quoted(item['domain'])},{quoted(item['fixture']['product'])});"))
    return sql(f"""SET ROLE service_role; SELECT mahshar_acquisition_save_template_draft('{claim['attemptId']}','{epoch or draft_epoch}',
      '{token or claim['claimToken']}',{quoted(key or context['key'])},{quoted(expected['subject'])},
      {quoted(body if body is not None else expected['body'])},'mahshar-provider-invitation-v1');""")

outbound_snapshot={table:sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t;")
                   for table in ['admin_outreach_messages','admin_acquisition_eligibility']}
for item in template_items:
    context=template_context(item)
    assert context['allowed'] and context['identityVerified'] and context['contactVerified']
    assert context['templateVariables']['companyVerified'] and context['templateVariables']['productVerified']
    assert not any(f['sourceRole']=='official_docs' for f in context['facts'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        claims=list(pool.map(lambda _:claim_draft(),range(2)))
    claim=next(c for c in claims if c and c['providerId']==item['provider'])
    # The second claim may belong to the next provider, never the same provider.
    assert sum(c is not None and c['providerId']==item['provider'] for c in claims)==1
    for other in claims:
        if other and other['providerId']!=item['provider']:
            sql(f"UPDATE admin_acquisition_attempts SET draft_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id='{other['attemptId']}';")
    assert template_save(item,claim,key='stale')=='f'
    assert template_save(item,claim,epoch='00000000-0000-0000-0000-000000000000')=='f'
    assert template_save(item,claim,body='Injected text')=='f'
    sql(f"UPDATE worker_sources SET title='Unsupported product title' WHERE lead_id='{item['lead']}' AND source_role='directory_assertion';")
    assert not template_context(item)['templateVariables']['productVerified']
    assert template_save(item,claim,key=context['key'])=='f'
    sql(f"UPDATE worker_sources SET title={quoted(item['fixture']['product'])} WHERE lead_id='{item['lead']}' AND source_role='directory_assertion';")
    sql(f"UPDATE worker_contacts SET verified_at=clock_timestamp()-interval '31 days' WHERE lead_id='{item['lead']}';")
    assert template_save(item,claim)=='f'
    sql(f"UPDATE worker_contacts SET verified_at=clock_timestamp() WHERE lead_id='{item['lead']}';")
    sql(f"UPDATE worker_providers SET status='do_not_contact' WHERE id='{item['provider']}';")
    assert template_save(item,claim)=='f'
    sql(f"UPDATE worker_providers SET status='active' WHERE id='{item['provider']}';")
    sql(f"INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{item['provider']}','{item['lead']}','do_not_contact','template_suppression');")
    assert template_save(item,claim)=='f'
    sql(f"DELETE FROM worker_decisions WHERE provider_id='{item['provider']}' AND reason_code='template_suppression';")
    sql(f"UPDATE admin_acquisition_attempts SET draft_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id='{claim['attemptId']}';")
    recovered=claim_draft(); assert recovered['providerId']==item['provider'] and recovered['claimToken']!=claim['claimToken']
    assert template_save(item,recovered,token=claim['claimToken'])=='f'
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(lambda _:template_save(item,recovered),range(3)))
    assert results.count('t')==1 and results.count('f')==2, results
    row=json.loads(sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{claim['attemptId']}';"))
    assert row['draft_generator']=='template' and row['draft_template_version']=='mahshar-provider-invitation-v1'
    assert row['draft_variables']==context['templateVariables'] and row['status']=='prepared'
    assert all(row[k] is None for k in ['reserved_at','dispatched_at','provider_message_id','draft_claim_token'])
    assert sql(f"SELECT count(*) FROM admin_acquisition_attempts WHERE provider_id='{item['provider']}';")=='1'
    for mutation in ["body='changed'", "draft_generator=NULL,draft_prepared_at=NULL,draft_variables=NULL,draft_template_version=NULL", "status='skipped'"]:
        expect_failure(f"UPDATE admin_acquisition_attempts SET {mutation} WHERE id='{claim['attemptId']}';",'acquisition_template_immutable')
    expect_failure(f"DELETE FROM admin_acquisition_attempts WHERE id='{claim['attemptId']}';",'acquisition_template_immutable')
    assert template_save(item,recovered)=='f'
    assert sql(f"SET ROLE service_role; SELECT mahshar_acquisition_reserve('{claim['attemptId']}','{draft_epoch}',{quoted(item['fixture']['email'])},'Subject','Body');") == ''
assert claim_draft() is None, 'restart never regenerates saved templates or historical Groq drafts'
for table,snapshot in outbound_snapshot.items():
    assert sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t;")==snapshot

# Missing saved product is a durable safe skip; supplying evidence permits one retry.
item=template_items[0]
provider=sql("INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES('missing.example','missing.example') RETURNING id;")
lead=sql(f"""INSERT INTO worker_leads(provider_id,status,qualification_status,fit_score,commercial_api,contactability_status,email_ready,preferred_email,contact_researched_at)
 VALUES('{provider}','qualified','qualified',99,true,'verified_email',true,'team@missing.example',clock_timestamp()) RETURNING id;""")
claim=claim_draft(); assert claim['providerId']==provider
assert claim['context']['templateVariables']['product'] is None
assert sql(f"SET ROLE service_role; SELECT mahshar_acquisition_record_draft('{claim['attemptId']}','{draft_epoch}','{claim['claimToken']}','template_product_missing');")=='t'
assert claim_draft() is None
sql(f"UPDATE worker_sources SET checked_at=clock_timestamp() WHERE lead_id='{lead}';")
assert claim_draft() is None, 'timestamp-only refresh does not loop skipped providers'
product=sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','api','Saved API') RETURNING id;")
sql(f"UPDATE worker_leads SET product_id='{product}' WHERE id='{lead}';")
retry=claim_draft(); assert retry['providerId']==provider
assert sql(f"SELECT count(*) FROM admin_acquisition_attempt_history WHERE attempt_id='{claim['attemptId']}' AND reason_code='template_product_missing';")=='1'
assert sql(f"SET ROLE service_role; SELECT mahshar_acquisition_record_draft('{retry['attemptId']}','{draft_epoch}','{retry['claimToken']}','template_company_unverified');")=='t'
assert claim_draft() is None
print('PASS: standard template migration/history, protected dispatch functions, service ACLs, SQL validation, four saved product fixtures, identity/contract proof, concurrency, lease recovery, DNC, immutable versioned saves, no outbound effects and safe missing-variable reconsideration')
