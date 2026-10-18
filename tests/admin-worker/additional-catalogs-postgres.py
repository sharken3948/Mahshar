"""Runs only in the disposable multi-source harness with --expanded --additional."""
additional = ROOT / 'supabase/migrations/20261018000400_admin_worker_additional_catalogs.sql'
history_before = snapshots()
source_before = sql("SELECT jsonb_agg(to_jsonb(s) ORDER BY source_id) FROM worker_discovery_sources s;")
function_before = json.loads(sql("SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'mahshar_%';"))
failure('BEGIN;\n' + additional.read_text() + "\nDO $$ BEGIN RAISE EXCEPTION 'rollback_additional'; END $$; COMMIT;", 'rollback_additional')
assert snapshots() == history_before
assert sql("SELECT jsonb_agg(to_jsonb(s) ORDER BY source_id) FROM worker_discovery_sources s;") == source_before
sql('BEGIN;\n' + additional.read_text() + '\nCOMMIT;')
assert snapshots() == history_before
assert sql("SELECT jsonb_agg(to_jsonb(s) ORDER BY source_id) FROM worker_discovery_sources s WHERE source_id NOT IN ('x402_list','payapi_market','bolthub');") == source_before
assert sql('SELECT count(*) FROM worker_discovery_sources;') == '8'
for signature, definition in function_before.items():
    if signature != 'mahshar_worker_claim_discovery_request(uuid,text,uuid)':
        assert sql(f"SELECT pg_get_functiondef({quote(signature)}::regprocedure);") == definition.strip(), signature
for role in ['anon', 'authenticated']:
    failure(f"SET ROLE {role}; SELECT mahshar_worker_claim_discovery_request(NULL,'x402_list',gen_random_uuid());", 'permission denied')
    failure(f'SET ROLE {role}; SELECT * FROM worker_discovery_sources;', 'permission denied')
failure("SET ROLE service_role; UPDATE worker_discovery_sources SET version=version+1;", 'permission denied')
assert data('mahshar_worker_discovery_ready()') is True
print('PASS: 48-migration baseline + additive catalogs; rollback, eight source rows, unchanged history/functions and service-only security', flush=True)

identifier = start_run()
for source_id in ['x402_list','payapi_market','bolthub']:
    attempt = str(uuid.uuid4())
    assert request(source_id, attempt=attempt, identifier=identifier) == 'claimed'
    assert request(source_id, attempt=attempt, identifier=identifier) == 'replayed'
    for _ in range(38):
        assert request(source_id, identifier=identifier) == 'claimed'
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: request(source_id, identifier=identifier), range(2)))
    assert sorted(outcomes) == ['claimed', 'source_exhausted']
assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{identifier}';") == '120'
for source_id in ['rapidapi','postman','zyla','apilayer','api_market','allthingsdev','apyhub','apis_io','api_tracker','api_directory','aws_marketplace','api_deposu']:
    failure(f"SET ROLE service_role; SELECT mahshar_worker_claim_discovery_request('{identifier}',{quote(source_id)},gen_random_uuid());", 'worker_discovery_source_not_authorized')
assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{identifier}';") == '120'
data(f"mahshar_worker_advance_target_run('{identifier}',0,10,0,0,0,0,0,0,0,0,false,false,false)")
stop_run(identifier, 10)
resumed_id = start_run(True)
assert request('x402_list', identifier=resumed_id) == 'source_exhausted'
assert request('apis_guru', identifier=resumed_id) == 'claimed'
sql(f"UPDATE worker_runs SET source_query_count=300 WHERE id='{resumed_id}';")
assert request('public_api_lists', identifier=resumed_id) == 'claimed'
assert request('github_public_apis', identifier=resumed_id) == 'exhausted'
stop_run(resumed_id, 10)
print('PASS: three new source caps under concurrency, replay/Resume accounting, all twelve denied sources and shared 301 cap', flush=True)

identifier = start_run()
saved_candidates = []
for ordinal, source_id in enumerate(['x402_list','payapi_market','bolthub']):
    snapshot = {'entries':[{'id':'fixture','domain':'additional.example'}], 'cursor':0, 'revision':'a'*64,
        'fetchedAt':'2026-10-18T00:00:00Z','refreshAfter':'2026-10-19T00:00:00Z','retryAfter':None,'failures':0}
    updated = data(f"mahshar_worker_discovery_source_update('{identifier}',{quote(source_id)},0,{payload(snapshot)})")
    record = {'ordinal':ordinal,'source_id':source_id,'source_record_id':'fixture','source_revision':'a'*64,
        'source_type':'api_directory','source_url':'https://additional.example/catalog','discovered_name':'Additional Fixture',
        'discovered_domain':'additional.example','discovered_product':source_id,'discovered_docs_url':'https://additional.example/docs',
        'normalized_domain':'additional.example','normalized_product_key':source_id,'status':'pending'}
    result = {'kind':'candidate','ordinal':ordinal,'candidate':{'sourceType':'api_directory','sourceId':source_id,
        'discoveredName':'Additional Fixture','discoveredDomain':'additional.example','discoveredProduct':source_id,
        'sourceUrl':'https://additional.example/catalog'}}
    expression = f"mahshar_worker_discovery_source_observe('{identifier}',{quote(source_id)},1,{payload(result)},{payload(record)})"
    assert data(expression) == result
    assert data(expression) == result
    assert sql(f"SELECT snapshot->>'cursor' FROM worker_discovery_sources WHERE source_id={quote(source_id)};") == '1'
assert sql(f"SELECT count(*) FROM worker_candidates WHERE discovery_batch_id='{identifier}';") == '3'
stop_run(identifier)
identifier = start_run()
recovered = data(f"mahshar_worker_claim_pending_sources('{identifier}')")
assert {candidate['source_id'] for candidate in recovered} == {'x402_list','payapi_market','bolthub'}
stop_run(identifier)
assert sql("SELECT desired_state FROM worker_control WHERE id=1;") == 'stopped'
assert sql("SELECT desired_state FROM admin_acquisition_control WHERE id=1;") == 'stopped'
assert sql("SELECT enabled FROM admin_acquisition_delivery_control WHERE id=1;") == 'f'
assert sql("SELECT status FROM admin_worker_mail_registry WHERE provider_id='"+provider+"';") == 'manual_sent'
assert sql('SELECT count(*) FROM admin_outreach_messages;') == '0'
print('PASS: new source attribution, atomic candidate/cursor replay, pending recovery across Starts and protected sent/delivery history', flush=True)
