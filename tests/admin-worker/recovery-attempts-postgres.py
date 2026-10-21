"""Executed by multi-source-postgres.py --expanded --additional --recovery; disposable database only."""
migration = ROOT / 'supabase/migrations/20261019000100_admin_worker_recovery_attempts.sql'
# Check this historical migration prefix, independent of newer releases.
assert len([p for p in (ROOT / 'supabase/migrations').glob('*.sql') if p.name.split('_')[0] <= migration.name.split('_')[0]]) == 50
before = snapshots()
candidate_fingerprint = sql("SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM worker_candidates t;")
old_rpc = sql("SELECT pg_get_functiondef('public.mahshar_worker_claim_deferred_candidates(uuid,text,integer)'::regprocedure);")
failure('BEGIN;\n' + migration.read_text() + "\nDO $$ BEGIN RAISE EXCEPTION 'rollback_recovery'; END $$; COMMIT;", 'rollback_recovery')
assert sql("SELECT to_regprocedure('public.mahshar_worker_begin_deferred_candidate(uuid,uuid,uuid,timestamptz)');") == ''
sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')
assert snapshots() == before
assert candidate_fingerprint == sql("SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM worker_candidates t;")
assert old_rpc == sql("SELECT pg_get_functiondef('public.mahshar_worker_claim_deferred_candidates(uuid,text,integer)'::regprocedure);")
for role in ['anon', 'authenticated']:
    failure(f"SET ROLE {role}; SELECT * FROM mahshar_worker_lease_deferred_candidates(NULL,'fixture',5);", 'permission denied')
    failure(f"SET ROLE {role}; SELECT mahshar_worker_begin_deferred_candidate(NULL,NULL,NULL,clock_timestamp());", 'permission denied')
assert sql("SELECT count(*) FROM pg_proc WHERE proname IN ('mahshar_worker_lease_deferred_candidates','mahshar_worker_begin_deferred_candidate') AND prosecdef AND proconfig=ARRAY['search_path=\"\"'];") == '2'
failure("SET ROLE service_role; SELECT * FROM mahshar_worker_lease_deferred_candidates(NULL,'fixture',NULL);", 'worker_deferred_limit_invalid')
print('PASS: 49-migration baseline + additive recovery migration, rollback, service-only security, old-app RPC and historical fingerprints unchanged', flush=True)

# Historical attempts are deliberately nonzero; the migration must never rewrite them.
origin = start_run()
historical = []
for i in range(5):
    identifier = sql(f"INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,discovered_product,discovered_docs_url,status,reason_code,processing_attempt,updated_at) VALUES('{origin}',{100+i},'api_directory','https://fixture.example/catalog','Recovery {i}','recovery{i}.example','API','https://recovery{i}.example/docs','deferred','research_budget_exhausted',{i},clock_timestamp()-interval '2 days') RETURNING id;")
    historical.append(identifier)
stop_run(origin)
attempts_before = sql("SELECT jsonb_object_agg(id, jsonb_build_array(processing_attempt,updated_at)) FROM worker_candidates WHERE id IN (" + ','.join(map(quote, historical)) + ');')
current = start_run()
def lease(run_id, key):
    return json.loads(sql(f"SET ROLE service_role; SELECT coalesce(json_agg(json_build_object('id',candidate_id,'lease',lease_id)),'[]') FROM mahshar_worker_lease_deferred_candidates('{run_id}',{quote(key)},5);"))
def begin(run_id, item, deadline="clock_timestamp()+interval '1 minute'"):
    return data(f"mahshar_worker_begin_deferred_candidate('{run_id}','{item['id']}','{item['lease']}',{deadline})")
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    leases = list(pool.map(lambda n: lease(current, f'concurrent:{n}'), range(2)))
claimed = [item for group in leases for item in group]
assert len(claimed) == 5 and len({item['id'] for item in claimed}) == 5
assert attempts_before == sql("SELECT jsonb_object_agg(id, jsonb_build_array(processing_attempt,updated_at)) FROM worker_candidates WHERE id IN (" + ','.join(map(quote, historical)) + ');')
assert begin(current, claimed[0], "clock_timestamp()-interval '1 second'") is False
sql(f"UPDATE worker_runs SET qualified_count=50 WHERE id='{current}';")
assert begin(current, claimed[0]) is False
sql(f"UPDATE worker_runs SET qualified_count=0 WHERE id='{current}';")
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    authorized = list(pool.map(lambda _: begin(current, claimed[0]), range(2)))
assert sorted(authorized) == [False, True]
assert begin(current, claimed[0]) is False
for item in claimed[1:]:
    assert begin(current, item, "clock_timestamp()-interval '1 second'") is False
for identifier in historical:
    expected = historical.index(identifier) + int(identifier == claimed[0]['id'])
    assert sql(f"SELECT processing_attempt FROM worker_candidates WHERE id='{identifier}';") == str(expected)
print('PASS: five concurrent leases consume no retries or cooldown timestamps; one authorized processing start consumes exactly one attempt, replay and deadline consume none', flush=True)

# Stop cannot authorize a pending lease, and an expired lease cannot complete work after a new claim.
data('mahshar_worker_request_stop()')
assert begin(current, claimed[1]) is False
stop_run(current)
sql("UPDATE worker_candidates SET processing_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id IN (" + ','.join(map(quote, historical)) + ');')
next_run = start_run()
recovered = lease(next_run, 'next-start')
assert len(recovered) == 5
assert all(item['lease'] != next(old['lease'] for old in claimed if old['id'] == item['id']) for item in recovered)
assert begin(next_run, claimed[1]) is False
assert all(begin(next_run, item) for item in recovered)
for item in recovered:
    assert data(f"mahshar_worker_complete_candidate('{item['id']}','{item['lease']}','filtered','fit_below_threshold')")['applied']
stop_run(next_run)
print('PASS: Stop fencing, interruption recovery on a later Start, all five retained candidates, stale lease rejection and completion locks', flush=True)

# A crash before processing must not change the retry clock or exhaust temporary-failure recovery.
origin = start_run()
unreachable = sql(f"INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,discovered_product,discovered_docs_url,status,reason_code,updated_at) VALUES('{origin}',200,'api_directory','https://fixture.example/catalog','Temporary fixture','temporary.example','API','https://temporary.example/docs','deferred','official_docs_unreachable',clock_timestamp()-interval '2 hours') RETURNING id;")
stop_run(origin)
sql("UPDATE admin_acquisition_control SET desired_state='running',operating_mode='continuous' WHERE id=1;")
current = start_run()
unused = next(item for item in lease(current, 'unused') if item['id'] == unreachable)
assert sql(f"SELECT processing_attempt FROM worker_candidates WHERE id='{unreachable}';") == '0'
stop_run(current)
sql(f"UPDATE worker_candidates SET processing_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='{unreachable}';")
current = start_run()
retry = next(item for item in lease(current, 'genuine-retry') if item['id'] == unreachable)
assert begin(current, retry) is True
stop_run(current)
sql(f"UPDATE worker_candidates SET processing_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='{unreachable}';")
current = start_run()
assert all(item['id'] != unreachable for item in lease(current, 'cooldown'))
stop_run(current)
sql("UPDATE admin_acquisition_control SET desired_state='stopped' WHERE id=1;")
assert sql('SELECT count(*) FROM admin_outreach_messages;') == '0'
assert sql("SELECT enabled FROM admin_acquisition_delivery_control WHERE id=1;") == 'f'
print('PASS: unused leases remain immediately recoverable after expiry; actual attempts preserve the existing temporary-failure cooldown, delivery stays disabled', flush=True)

# Source quarantine metadata uses the existing optimistic snapshot RPC and survives separate Starts.
current = start_run()
state_version = int(sql("SELECT version FROM worker_discovery_sources WHERE source_id='apis_guru';"))
quarantine = {'reason': 'discovery_response_too_large', 'checkedAt': '2026-10-19T00:00:00Z'}
source_snapshot = {'entries': [{'id': 'healthy.example', 'domain': 'healthy.example'},
    {'id': 'amazonaws.com', 'domain': 'amazonaws.com', 'quarantine': quarantine}], 'cursor': 0,
    'revision': 'f'*64, 'fetchedAt': '2026-10-19T00:00:00Z', 'refreshAfter': '2026-10-20T00:00:00Z',
    'retryAfter': None, 'failures': 0}
saved = data(f"mahshar_worker_discovery_source_update('{current}','apis_guru',{state_version},{payload(source_snapshot)})")
assert saved['snapshot']['entries'][1]['quarantine'] == quarantine
stop_run(current)
current = start_run()
assert sql("SELECT snapshot->'entries'->1->'quarantine'->>'reason' FROM worker_discovery_sources WHERE source_id='apis_guru';") == 'discovery_response_too_large'
stop_run(current)
assert sql("SELECT desired_state FROM worker_control WHERE id=1;") == 'stopped'
assert sql("SELECT desired_state FROM admin_acquisition_control WHERE id=1;") == 'stopped'
print('PASS: existing source snapshot RPC durably preserves an oversized-record quarantine alongside healthy progress across Starts', flush=True)
