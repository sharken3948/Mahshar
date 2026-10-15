"""Disposable PostgreSQL integration, appended after existing migration regressions."""
before_drafts = {table: sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;")
                 for table in ['worker_providers', 'worker_leads', 'worker_contacts', 'worker_sources',
                               'worker_runs', 'worker_decisions', 'admin_acquisition_attempts', 'admin_outreach_messages']}
old_functions = sql("""SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND (p.proname LIKE 'mahshar_acquisition_%' OR p.proname LIKE 'mahshar_outreach_%');""")
try:
    sql('BEGIN;\n' + DRAFT_ONLY.read_text() + '\nCOMMIT;')
except subprocess.CalledProcessError as error:
    raise AssertionError(error.stderr) from error
for table, original in before_drafts.items():
    projection = "to_jsonb(t)-'draft_only'-'draft_evidence_key'-'draft_claim_token'-'draft_claim_expires_at'" if table == 'admin_acquisition_attempts' else 'to_jsonb(t)'
    assert sql(f"SELECT coalesce(jsonb_agg({projection} ORDER BY id),'[]') FROM {table} t;") == original
for signature, definition in json.loads(old_functions).items():
    assert sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);") == definition.strip(), signature
for function in ['mahshar_acquisition_claim_draft(uuid,uuid)', 'mahshar_acquisition_draft_context(uuid)',
                 'mahshar_acquisition_save_draft_only(uuid,uuid,uuid,text,text,text,text)',
                 'mahshar_acquisition_record_draft(uuid,uuid,uuid,text)']:
    for role in ['anon', 'authenticated']:
        assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');") == 'f'
    assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');") == 't'
for role in ['anon', 'authenticated']:
    assert sql(f"SELECT has_table_privilege('{role}','admin_acquisition_attempt_history','SELECT');") == 'f'
assert sql("SELECT has_table_privilege('service_role','admin_acquisition_attempt_history','SELECT');") == 't'
for privilege in ['INSERT', 'UPDATE', 'DELETE']:
    assert sql(f"SELECT has_table_privilege('service_role','admin_acquisition_attempt_history','{privilege}');") == 'f'

# Quarantine only disposable old fixtures so the new queue contains exactly the
# four saved providers; no external database, Workflow, Groq or email is used.
sql("UPDATE worker_providers SET status='rejected'; UPDATE worker_runs SET status='stopped' WHERE status IN ('running','queued','stop_requested');")
draft_run = rpc_json('mahshar_worker_create_target_run(false)')['id']
rpc_json(f"mahshar_worker_claim_run('{draft_run}')")
draft_control = rpc_json('mahshar_acquisition_set_state(true,false,NULL)')
draft_epoch = draft_control['epoch']
saved_providers = json.loads((ROOT / 'tests/admin-worker/fixtures/acquisition-provider-saved.json').read_text())['providers']
draft_items = []
def quoted(value):
    return "'" + value.replace("'", "''") + "'"
for index, fixture in enumerate(saved_providers):
    domain = fixture['domain']
    provider = sql(f"INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES({quoted(domain)},{quoted(domain)}) RETURNING id;")
    product = sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','api',{quoted(fixture['product'])}) RETURNING id;")
    lead = sql(f"""INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,
      contactability_status,email_ready,preferred_email,contact_researched_at)
      VALUES('{provider}','{product}','qualified','qualified',{90-index},true,'verified_email',true,
        {quoted(fixture['email'])},clock_timestamp()) RETURNING id;""")
    sql(f"""INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
      verification_status,preferred,email_ready,discovered_at,verified_at) VALUES('{provider}','{lead}','email',
      {quoted(fixture['email'])},{quoted(fixture['purpose'])},{quoted(fixture['contactSource'])},'official_site','verified',true,true,clock_timestamp(),clock_timestamp());
      INSERT INTO worker_sources(lead_id,source_type,source_role,url,factual_summary,checked_at) VALUES
        ('{lead}','website','official_site',{quoted(fixture['identityUrl'])},'Provider-owned site independently verified for this directory contract.',clock_timestamp()),
        ('{lead}','api_directory','directory_assertion',{quoted(fixture['contractUrl'])},{quoted(fixture['contractSummary'])},clock_timestamp());""")
    attempt = sql(f"""INSERT INTO admin_acquisition_attempts(provider_id,lead_id,run_id,status,reason_code,created_at,updated_at)
      VALUES('{provider}','{lead}','{draft_run}','skipped',{quoted(fixture['skip'])},'{fixture['skipAt']}','{fixture['skipAt']}') RETURNING id;""")
    draft_items.append({'provider': provider, 'product': product, 'lead': lead, 'attempt': attempt, 'fixture': fixture})

def claim_draft():
    value = sql(f"SET ROLE service_role; SELECT mahshar_acquisition_claim_draft('{draft_run}','{draft_epoch}');")
    return json.loads(value) if value else None
def draft_context(item):
    return json.loads(sql(f"SET ROLE service_role; SELECT mahshar_acquisition_draft_context('{item['lead']}');"))
def checkpoint(item, claim, key=None, epoch=None, token=None):
    key = key or draft_context(item)['key']
    return sql(f"""SET ROLE service_role; SELECT mahshar_acquisition_save_draft_only('{item['attempt']}',
      '{epoch or draft_epoch}','{token or claim['claimToken']}',{quoted(key)},'Grounded invitation',
      'Offline validated invitation fixture','groq');""")

for item in draft_items:
    context = draft_context(item)
    assert context['identityVerified'] and context['contactVerified'] and context['allowed']
    assert not any(f['sourceRole'] == 'official_docs' for f in context['facts'])
    claim = claim_draft(); assert claim['providerId'] == item['provider'] and claim['verified'] and not claim['approved']
    assert checkpoint(item, claim) == 'f', 'directory contracts alone cannot pass the SQL documentation gate'
    assert sql(f"SET ROLE service_role; SELECT mahshar_acquisition_record_draft('{item['attempt']}','{draft_epoch}','{claim['claimToken']}','api_documentation_missing');") == 't'
    history = json.loads(sql(f"SELECT jsonb_agg(to_jsonb(h)) FROM admin_acquisition_attempt_history h WHERE attempt_id='{item['attempt']}';"))
    assert len(history) == 1 and history[0]['reason_code'] == item['fixture']['skip']
    assert history[0]['created_at'] == history[0]['updated_at']
    assert sql(f"SELECT updated_at='{item['fixture']['skipAt']}'::timestamptz FROM admin_acquisition_attempt_history WHERE attempt_id='{item['attempt']}';") == 't'
assert claim_draft() is None
sql("UPDATE worker_sources SET checked_at=clock_timestamp();")
assert claim_draft() is None, 'timestamp-only refresh does not create another investigation'

negative = draft_items[1]
for table, column, predicate in [('worker_sources','checked_at',f"lead_id='{negative['lead']}'"),
                                  ('worker_contacts','verified_at',f"provider_id='{negative['provider']}'")]:
    sql(f"UPDATE {table} SET {column}=clock_timestamp()-interval '31 days' WHERE {predicate};")
    context = draft_context(negative)
    assert not context['identityVerified' if table == 'worker_sources' else 'contactVerified']
    sql(f"UPDATE {table} SET {column}=clock_timestamp() WHERE {predicate};")
assert claim_draft() is None, 'revalidating identical evidence does not create a retry loop'

outreach_before = sql("SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM admin_outreach_messages m;")
eligibility_before = sql("SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY provider_id,recipient_email),'[]') FROM admin_acquisition_eligibility e;")
for item in draft_items:
    if item['fixture']['domain'] == 'ideaconsult.net':
        continue  # Its saved product marketing page has no API request examples.
    page = item['fixture']['officialPage']
    sql(f"""INSERT INTO worker_sources(lead_id,source_type,source_role,url,factual_summary,checked_at)
      VALUES('{item['lead']}','website','official_docs',{quoted(page['url'])},'Provider-owned API request documentation verified in offline fixture.',clock_timestamp());""")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: claim_draft(), range(2)))
    assert sum(c is not None for c in claims) == 1, claims
    claim = next(c for c in claims if c)
    assert claim['providerId'] == item['provider']
    assert claim_draft() is None, 'live lease prevents duplicate inference'
    assert checkpoint(item, claim, key='stale-evidence') == 'f'
    assert checkpoint(item, claim, epoch='00000000-0000-0000-0000-000000000000') == 'f'
    key_before = draft_context(item)['key']
    sql(f"UPDATE worker_sources SET factual_summary='Changed documented capability' WHERE lead_id='{item['lead']}' AND source_role='official_docs';")
    assert checkpoint(item, claim, key=key_before) == 'f', 'changed evidence invalidates in-flight generation'
    sql(f"UPDATE admin_acquisition_attempts SET draft_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id='{item['attempt']}';")
    recovered = claim_draft(); assert recovered['claimToken'] != claim['claimToken']
    assert checkpoint(item, recovered, token=claim['claimToken']) == 'f'
    for table, identity in [('worker_providers', item['provider']), ('worker_leads', item['lead'])]:
        previous_status = sql(f"SELECT status FROM {table} WHERE id='{identity}';")
        sql(f"UPDATE {table} SET status='do_not_contact' WHERE id='{identity}';")
        assert checkpoint(item, recovered) == 'f'
        sql(f"UPDATE {table} SET status={quoted(previous_status)} WHERE id='{identity}';")
    sql(f"INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{item['provider']}','{item['lead']}','do_not_contact','fixture_suppression');")
    assert checkpoint(item, recovered) == 'f'
    sql(f"DELETE FROM worker_decisions WHERE provider_id='{item['provider']}' AND reason_code='fixture_suppression';")
    # Current contact evidence must still agree after inference.
    sql(f"UPDATE worker_contacts SET email_ready=false WHERE provider_id='{item['provider']}';")
    assert checkpoint(item, recovered) == 'f'
    sql(f"UPDATE worker_contacts SET email_ready=true WHERE provider_id='{item['provider']}';")
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: checkpoint(item, recovered), range(3)))
    assert results.count('t') == 1 and results.count('f') == 2
    prepared = json.loads(sql(f"SELECT to_jsonb(a) FROM admin_acquisition_attempts a WHERE id='{item['attempt']}';"))
    assert prepared['status'] == 'prepared' and prepared['draft_generator'] == 'groq' and prepared['draft_prepared_at']
    assert prepared['recipient_email'] == item['fixture']['email']
    assert all(prepared[k] is None for k in ['reserved_at','dispatched_at','provider_message_id','draft_claim_token'])
    assert sql(f"SELECT count(*) FROM admin_acquisition_attempt_history WHERE attempt_id='{item['attempt']}';") == '2'
    assert checkpoint(item, recovered) == 'f', 'lost-response replay cannot overwrite a proven draft'
    assert claim_draft() is None, 'saved checkpoint is never regenerated after restart'
    assert sql(f"SET ROLE service_role; SELECT mahshar_acquisition_reserve('{item['attempt']}','{draft_epoch}',{quoted(item['fixture']['email'])},'Subject','Body');") == ''
    expect_failure(f"UPDATE admin_acquisition_attempts SET status='reserved',reserved_at=clock_timestamp() WHERE id='{item['attempt']}';", 'admin_acquisition_draft_only_no_dispatch')

assert sql("SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM admin_outreach_messages m;") == outreach_before
assert sql("SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY provider_id,recipient_email),'[]') FROM admin_acquisition_eligibility e;") == eligibility_before
assert sql("SELECT count(*) FROM admin_acquisition_attempts WHERE draft_only AND status='prepared';") == '3'
sql("UPDATE admin_acquisition_control SET desired_state='stopped' WHERE id=1;")
assert claim_draft() is None
print('PASS: draft-only migration, unchanged dispatch functions/history, service ACLs, four saved providers, official docs gate, evidence refresh, immutable skips, leases/concurrency, Stop/epoch/suppression, provenance/checkpoint replay and zero outbound side effects')
