"""Executed by postgres.py against its disposable, fully migrated local database."""
before_coverage = {
    table: sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;")
    for table in ['worker_leads', 'worker_contacts', 'worker_providers', 'worker_runs', 'admin_acquisition_attempts']
}
protected_functions = sql("""SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) ORDER BY p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND (p.proname LIKE 'mahshar_acquisition_%' OR p.proname LIKE 'mahshar_outreach_%');""")
try:
    sql('BEGIN;\n' + CONTACT_COVERAGE.read_text() + '\nCOMMIT;')
except subprocess.CalledProcessError as error:
    raise AssertionError(error.stderr) from error
assert sql("""SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) ORDER BY p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND (p.proname LIKE 'mahshar_acquisition_%' OR p.proname LIKE 'mahshar_outreach_%');""") == protected_functions
for table, original in before_coverage.items():
    projection = "to_jsonb(t)-'contact_research_state'-'contact_checked_at'" if table == 'worker_leads' else "to_jsonb(t)-'form_state'" if table == 'worker_contacts' else 'to_jsonb(t)'
    assert sql(f"SELECT coalesce(jsonb_agg({projection} ORDER BY id),'[]') FROM {table} t;") == original, table
for function in ['mahshar_worker_save_contact_research(uuid,uuid,uuid,text,boolean,text,text,boolean,jsonb)',
                 'mahshar_worker_claim_contact_enrichment(uuid,text,integer)']:
    for role in ['anon', 'authenticated']:
        assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');") == 'f'
    assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');") == 't'
    assert sql(f"SELECT coalesce(array_to_string(proconfig,'|'),'') FROM pg_proc WHERE oid='public.{function}'::regprocedure;") in {'search_path=', 'search_path=""'}
for role in ['anon', 'authenticated']:
    assert sql(f"SELECT has_table_privilege('{role}','public.worker_contacts','SELECT');") == 'f'
assert sql("SELECT has_table_privilege('service_role','public.worker_contacts','UPDATE');") == 'f'

# Isolated synthetic run rows only. No workflow or external transport is involved.
sql("UPDATE worker_runs SET status='stopped' WHERE status IN ('running','queued','stop_requested');")
coverage_run = rpc_json('mahshar_worker_create_target_run(false)')['id']
rpc_json(f"mahshar_worker_claim_run('{coverage_run}')")
sql("UPDATE worker_leads SET contact_checked_at=clock_timestamp(),contact_research_state='no_contact_found';")

def coverage_provider(index, commercial=True, age='8 days', state='no_contact_found', email=False):
    provider = sql(f"INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES('Coverage {index}','coverage-{index}.example') RETURNING id;")
    product = sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','api','Coverage API') RETURNING id;")
    lead = sql(f"""INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,
      contactability_status,email_ready,preferred_email,contact_research_state,contact_researched_at,contact_checked_at)
      VALUES('{provider}','{product}','qualified','qualified',80,{str(commercial).lower()},
      '{'verified_email' if email else 'contact_unavailable'}',{str(email).lower()},
      {'NULL' if not email else "'support@coverage.example'"},'{state}',clock_timestamp()-interval '{age}',clock_timestamp()-interval '{age}') RETURNING id;""")
    candidate = sql(f"""INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
      status,provider_id,product_id,lead_id) VALUES('{coverage_run}',{index},'api_directory','https://directory.example/',
      'Coverage {index}','persisted','{provider}','{product}','{lead}') RETURNING id;""")
    return provider, product, lead, candidate

ordinary = coverage_provider(0, False, '31 days')
commercial = coverage_provider(1)
fresh = coverage_provider(2, True, '6 days')
not_due = coverage_provider(3, False, '29 days')
verified = coverage_provider(4, True, '99 days', 'verified_email', True)
blocked = coverage_provider(5)
sql(f"UPDATE worker_providers SET status='do_not_contact' WHERE id='{blocked[0]}';")
due_unresolved = coverage_provider(6, False, '2 days', 'unresolved')
legacy = coverage_provider(7, True, '1 hour')
sql(f"UPDATE worker_leads SET contact_research_state=NULL WHERE id='{legacy[2]}';")
claimed = sql(f"SET ROLE service_role; SELECT candidate_id FROM mahshar_worker_claim_contact_enrichment('{coverage_run}','coverage:first',5);").splitlines()
assert commercial[3] in claimed and ordinary[3] in claimed and due_unresolved[3] in claimed
assert legacy[3] in claimed
assert claimed.index(commercial[3]) < claimed.index(ordinary[3])
assert all(item[3] not in claimed for item in [fresh, not_due, verified, blocked])
assert len(claimed) <= 5
assert sql(f"SET ROLE service_role; SELECT candidate_id FROM mahshar_worker_claim_contact_enrichment('{coverage_run}','coverage:first',5);").splitlines() == claimed
assert commercial[3] not in sql(f"SET ROLE service_role; SELECT candidate_id FROM mahshar_worker_claim_contact_enrichment('{coverage_run}','coverage:second',5);").splitlines()
for status, completed, expected in [('unknown', False, 'unresolved'), ('contact_unavailable', True, 'no_contact_found')]:
    assert sql(f"""SET ROLE service_role; SELECT mahshar_worker_save_contact_research('{coverage_run}',
      '{fresh[0]}','{fresh[2]}','{status}',false,NULL,NULL,{str(completed).lower()},'[]'::jsonb);""") == 'saved'
    assert sql(f"SELECT contact_research_state FROM worker_leads WHERE id='{fresh[2]}';") == expected

provider, product, lead, candidate = commercial
url = 'https://coverage-1.example/contact'
def coverage_save(evidence, status='official_contact_page', completed=True, email=None):
    payload = json.dumps(evidence)
    preferred = 'NULL' if email is None else "'" + email + "'"
    return sql(f"""SET ROLE service_role; SELECT mahshar_worker_save_contact_research('{coverage_run}','{provider}','{lead}',
      '{status}',{str(email is not None).lower()},{preferred},'{url}',{str(completed).lower()},$e${payload}$e$::jsonb);""")
form = {'type': 'official_contact', 'value': url, 'purpose': 'contact', 'sourceUrl': url, 'sourceType': 'official_site',
        'verificationStatus': 'verified', 'preferred': True, 'emailReady': False, 'discoveredAt': '2026-10-01T00:00:00Z',
        'verifiedAt': '2026-10-15T00:00:00Z', 'formState': 'available'}
assert coverage_save([form]) == 'saved'
assert sql(f"SELECT contact_research_state FROM worker_leads WHERE id='{lead}';") == 'form_available'
identity = sql(f"SELECT id||','||discovered_at FROM worker_contacts WHERE provider_id='{provider}' AND value='{url}';")
form['formState'] = 'manual_required'
form['discoveredAt'] = '2026-10-15T00:00:00Z'
assert coverage_save([form]) == 'saved'
assert sql(f"SELECT id||','||discovered_at FROM worker_contacts WHERE provider_id='{provider}' AND value='{url}';") == identity
assert sql(f"SELECT contact_research_state FROM worker_leads WHERE id='{lead}';") == 'manual_required'
assert sql(f"SELECT count(*) FROM worker_contacts WHERE provider_id='{provider}';") == '1'
email = {**form, 'type': 'email', 'value': 'sales@coverage-1.example', 'purpose': 'sales', 'emailReady': True}
email.pop('formState')
assert coverage_save([email], 'verified_email', email=email['value']) == 'saved'
assert coverage_save([], 'unknown', False) == 'saved'
assert sql(f"SELECT contact_research_state||','||preferred_email FROM worker_leads WHERE id='{lead}';") == 'verified_email,sales@coverage-1.example'
assert sql(f"SELECT count(*) FROM worker_contacts WHERE provider_id='{provider}';") == '2'
assert sql(f"SELECT qualification_status='qualified' AND fit_score=80 FROM worker_leads WHERE id='{lead}';") == 't'
assert sql(f"SELECT count(*) FROM admin_acquisition_eligibility WHERE provider_id='{provider}';") == '0'

# A manual preference wins; no automatic rediscovery changes its content or timestamp.
sql(f"UPDATE worker_contacts SET preferred=false WHERE provider_id='{provider}'; UPDATE worker_contacts SET preferred=true,evidence_origin='manual' WHERE provider_id='{provider}' AND value='{url}';")
manual_before = sql(f"SELECT to_jsonb(c) FROM worker_contacts c WHERE provider_id='{provider}' AND value='{url}';")
assert coverage_save([form, email], 'verified_email', email=email['value']) == 'saved'
assert sql(f"SELECT to_jsonb(c) FROM worker_contacts c WHERE provider_id='{provider}' AND value='{url}';") == manual_before
assert sql(f"SELECT preferred_contact_url FROM worker_leads WHERE id='{lead}';") == url
sql(f"UPDATE worker_providers SET status='do_not_contact' WHERE id='{provider}';")
lead_before = sql(f"SELECT to_jsonb(l) FROM worker_leads l WHERE id='{lead}';")
assert coverage_save([email], 'verified_email', email=email['value']) == 'blocked'
assert sql(f"SELECT to_jsonb(l) FROM worker_leads l WHERE id='{lead}';") == lead_before
print('PASS: contact coverage migration history, commercial priority, TTLs, replay, bounds, form states, deduplication, manual/DNC and service-only permissions')
