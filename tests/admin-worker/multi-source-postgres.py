"""Local-only migration, atomic discovery progress, permissions and lifecycle regressions."""
import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261018000100_admin_worker_multi_source.sql'
BIN = pathlib.Path(os.environ.get('MAHSHAR_PG_BIN') or (str(pathlib.Path(shutil.which('initdb')).parent) if shutil.which('initdb')
    else '/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
ENV = dict(os.environ)
if (BIN.parents[2] / 'x86_64-linux-gnu').is_dir():
    ENV['LD_LIBRARY_PATH'] = str(BIN.parents[2] / 'x86_64-linux-gnu')

with tempfile.TemporaryDirectory(prefix='mahshar-multi-source-pg-') as directory:
    socket = pathlib.Path(directory)
    def run(args, **kwargs):
        return subprocess.run([str(a) for a in args], env=ENV, text=True, capture_output=True, check=True, timeout=90, **kwargs)
    run([BIN / 'initdb', '-D', socket / 'data', '-U', 'discovery_test', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', socket / 'data', '-l', socket / 'postgres.log', '-o',
            f"-k {socket} -p 55468 -c listen_addresses=''", '-w', 'start'])
        started = True
        def sql(statement):
            try:
                return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                    '-p', '55468', '-U', 'discovery_test', '-d', 'postgres'], input=statement).stdout.strip()
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error
        def quote(value):
            return "'" + str(value).replace("'", "''") + "'"
        def payload(value):
            return quote(json.dumps(value)) + '::jsonb'
        def data(expression):
            value = sql('SET ROLE service_role; SELECT to_jsonb(' + expression + ');')
            return json.loads(value) if value else None
        def failure(statement, marker):
            try:
                sql(statement)
            except AssertionError as error:
                assert marker in str(error), str(error)
            else:
                raise AssertionError('Expected failure: ' + marker)
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        baseline = sorted((p for p in (ROOT / 'supabase/migrations').glob('*.sql') if p.name.split('_')[0] <= '20261018000100'), key=lambda p: p.name.split('_')[0])
        assert len(baseline) == 46
        for migration in baseline:
            if migration != MIGRATION:
                sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')
        # Synthetic preexisting qualified/manual-sent history and DNC state must remain byte-for-byte unchanged.
        provider = sql("INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES('Historical Fixture','known.example') RETURNING id;")
        product = sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','known','Known API') RETURNING id;")
        lead = sql(f"INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,commercial_api,email_ready,preferred_email,contactability_status) VALUES('{provider}','{product}','qualified','qualified',90,true,true,'api@known.example','verified_email') RETURNING id;")
        sql(f"INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at) VALUES('{provider}','{lead}','email','api@known.example','business','https://known.example/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp());")
        sql(f"INSERT INTO worker_sources(lead_id,source_type,source_role,url,checked_at) VALUES('{lead}','website','official_docs','https://known.example/docs',clock_timestamp());")
        assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '1'
        sql("UPDATE admin_worker_mail_registry SET status='manual_sent',manual_sent_at=clock_timestamp(),marked_by='0x1111111111111111111111111111111111111111'; INSERT INTO worker_providers(canonical_name,canonical_domain,status) VALUES('DNC Fixture','dnc.example','do_not_contact');")
        tables = ['worker_control','worker_runs','worker_providers','worker_provider_identities','worker_products',
            'worker_leads','worker_contacts','worker_sources','admin_worker_mail_registry','admin_acquisition_control',
            'admin_acquisition_attempts','admin_outreach_threads','admin_outreach_messages','discovered_apis','outreach_log']
        def snapshots():
            return {table: sql(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;") for table in tables}
        original = snapshots()
        functions = sql("SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'mahshar_%';")
        # Reproduce permissive Supabase default ACLs: the migration must explicitly revoke them.
        sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;')
        failure('BEGIN;\n' + MIGRATION.read_text() + "\nDO $$ BEGIN RAISE EXCEPTION 'rollback_multisource'; END $$; COMMIT;", 'rollback_multisource')
        assert sql("SELECT to_regclass('public.worker_discovery_sources');") == ''
        sql('BEGIN;\n' + MIGRATION.read_text() + '\nCOMMIT;')
        assert snapshots() == original
        current = json.loads(sql("SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'mahshar_%';"))
        assert all(current[key] == value for key,value in json.loads(functions).items())
        assert len(current) == len(json.loads(functions)) + 3
        for role in ['anon','authenticated']:
            failure(f'SET ROLE {role}; SELECT * FROM worker_discovery_sources;', 'permission denied')
            failure(f"SET ROLE {role}; SELECT mahshar_worker_discovery_source_update(NULL,'apis_guru',0,'{{}}');", 'permission denied')
            failure(f"SET ROLE {role}; SELECT mahshar_worker_claim_pending_sources(NULL);", 'permission denied')
        failure("SET ROLE service_role; UPDATE worker_discovery_sources SET version=2;", 'permission denied')
        failure('SET ROLE service_role; TRUNCATE worker_discovery_sources;', 'permission denied')
        assert sql('SET ROLE service_role; SELECT count(*) FROM worker_discovery_sources;') == '2'
        print('PASS: 45 baseline migrations + additive migration, rollback, unchanged data/functions and service-only permissions', flush=True)

        run_id = data('mahshar_worker_create_target_run(false)')['id']
        data(f"mahshar_worker_claim_run('{run_id}')")
        state = {'entries': [{'id': name, 'domain': name + '.example'} for name in 'abcdefghijklmnopqrst'], 'cursor': 0,
            'revision': 'a'*64, 'fetchedAt': '2026-10-18T00:00:00Z', 'refreshAfter': '2026-10-19T00:00:00Z', 'retryAfter': None, 'failures': 0}
        def update(version, snapshot=state):
            return data(f"mahshar_worker_discovery_source_update('{run_id}','apis_guru',{version},{payload(snapshot)})")
        assert update(0)['version'] == 1
        def observe(ordinal, version, record_id, invalid=False):
            result = {'kind':'candidate','ordinal':ordinal,'candidate':None,'reasonCode':'provider_identity_processed'}
            record = {'ordinal':ordinal,'source_id':'apis_guru','source_record_id':record_id,'source_revision':'a'*64,
                'source_url':'https://api.apis.guru/v2/providers.json','discovered_name':'x'*201 if invalid else 'Fixture API',
                'status':'filtered','reason_code':'provider_identity_processed'}
            return data(f"mahshar_worker_discovery_source_observe('{run_id}','apis_guru',{version},{payload(result)},{payload(record)})")
        def cursor():
            return sql("SELECT snapshot->>'cursor' FROM worker_discovery_sources WHERE source_id='apis_guru';")
        assert observe(0,1,'a')['ordinal'] == 0
        assert cursor() == '1'
        count = sql(f"SELECT source_query_count FROM worker_runs WHERE id='{run_id}';")
        assert observe(0,1,'a')['ordinal'] == 0
        assert cursor() == '1' and sql(f"SELECT source_query_count FROM worker_runs WHERE id='{run_id}';") == count
        assert sql(f"SELECT source_id||':'||source_record_id||':'||source_revision FROM worker_candidates WHERE discovery_batch_id='{run_id}' AND ordinal=0;") == 'apis_guru:a:'+'a'*64
        try:
            observe(1,1,'b')
            raise AssertionError('Expected stale-source conflict')
        except AssertionError as error:
            assert 'worker_discovery_source_conflict' in str(error)
        try:
            observe(1,2,'b',True)
            raise AssertionError('Expected observation rollback')
        except AssertionError as error:
            assert 'worker_candidates_discovered_name_check' in str(error)
        assert cursor() == '1'
        assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{run_id}';") == count
        assert sql(f"SELECT count(*) FROM worker_source_work WHERE discovery_batch_id='{run_id}' AND claim_key='candidate:1';") == '0'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: observe(1,2,'b'), range(2)))
        assert all(result['ordinal'] == 1 for result in results) and cursor() == '2'
        assert sql(f"SELECT count(*) FROM worker_candidates WHERE discovery_batch_id='{run_id}';") == '2'
        print('PASS: atomic candidate + observation + cursor, replay, stale-writer fencing, rollback and concurrent duplicate delivery', flush=True)

        sql(f"UPDATE worker_runs SET source_query_count=301 WHERE id='{run_id}';")
        assert observe(2,3,'c') is None and cursor() == '2'
        sql(f"UPDATE worker_runs SET source_query_count=2 WHERE id='{run_id}';")
        for ordinal in range(2,10):
            assert observe(ordinal,ordinal+1,chr(ord('a')+ordinal))['ordinal'] == ordinal
        data(f"mahshar_worker_advance_target_run('{run_id}',0,10,0,10,0,0,0,0,0,0,false,false,false)")
        assert observe(10,11,'k')['ordinal'] == 10
        data('mahshar_worker_request_stop()')
        assert observe(11,12,'l') is None and update(12) is None
        data(f"mahshar_worker_advance_target_run('{run_id}',10,10,0,0,0,0,0,0,0,0,false,false,false)")
        resumed = data('mahshar_worker_create_target_run(true)')
        assert resumed['discovery_batch_id'] == run_id and resumed['checkpoint']['nextIndex'] == 10
        run_id = resumed['id']; data(f"mahshar_worker_claim_run('{run_id}')")
        assert observe(10,11,'k')['ordinal'] == 10 and cursor() == '11'
        assert observe(11,12,'l')['ordinal'] == 11 and cursor() == '12'
        data('mahshar_worker_request_stop()')
        data(f"mahshar_worker_advance_target_run('{run_id}',10,10,0,0,0,0,0,0,0,0,false,false,false)")
        separate = data('mahshar_worker_create_target_run(false)')
        assert separate['discovery_batch_id'] != resumed['discovery_batch_id'] and cursor() == '12'
        data(f"mahshar_worker_claim_run('{separate['id']}')")
        sql(f"UPDATE worker_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id='{separate['id']}';")
        run_id = separate['id']; assert update(13) is None
        print('PASS: existing budgets, Stop fencing, Resume replay, separate Start persistence and deadline fencing', flush=True)

        def stop_run(identifier, checkpoint=0):
            data('mahshar_worker_request_stop()')
            data(f"mahshar_worker_advance_target_run('{identifier}',{checkpoint},{checkpoint},0,0,0,0,0,0,0,0,false,false,false)")
        def start_run(resume=False):
            created = data(f"mahshar_worker_create_target_run({'true' if resume else 'false'})")
            data(f"mahshar_worker_claim_run('{created['id']}')")
            return created['id']
        def pending_claim(identifier):
            return data(f"mahshar_worker_claim_pending_sources('{identifier}')")
        def finish(candidate, lease=None):
            return data(f"mahshar_worker_complete_candidate('{candidate['id']}',{quote(lease or candidate['processing_lease_id'])},'filtered','fit_below_threshold')")
        stop_run(run_id)
        origin = start_run()
        run_id = origin
        fresh_state = dict(state, entries=[{'id': f'pending{i}', 'domain': f'pending{i}.example'} for i in range(10)], cursor=0, revision='b'*64)
        version = int(sql("SELECT version FROM worker_discovery_sources WHERE source_id='apis_guru';"))
        assert update(version, fresh_state)['version'] == version+1
        for ordinal in range(10):
            record = {'ordinal': ordinal, 'source_id': 'apis_guru', 'source_record_id': f'pending{ordinal}', 'source_revision': 'b'*64,
                'source_url': 'https://api.apis.guru/v2/providers.json', 'discovered_name': f'Pending {ordinal}',
                'discovered_domain': f'pending{ordinal}.example', 'discovered_product': 'API', 'status': 'pending'}
            observation = {'kind': 'candidate', 'ordinal': ordinal, 'candidate': {'sourceType': 'api_directory', 'discoveredName': f'Pending {ordinal}'}}
            assert data(f"mahshar_worker_discovery_source_observe('{origin}','apis_guru',{version+1+ordinal},{payload(observation)},{payload(record)})")['ordinal'] == ordinal
        assert cursor() == '10'
        assert pending_claim(origin) == []  # Current batch retains its ordinary ordinals.
        # One candidate completes; reaching the target closes the batch before nine are processed.
        first_id = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{origin}' AND ordinal=0;")
        data(f"mahshar_worker_complete_candidate('{first_id}',NULL,'filtered','fit_below_threshold')")
        sql(f"UPDATE worker_runs SET qualified_count=50 WHERE id='{origin}';")
        data(f"mahshar_worker_advance_target_run('{origin}',0,1,0,1,0,1,0,0,0,0,false,false,false)")
        assert sql(f"SELECT status FROM worker_runs WHERE id='{origin}';") == 'completed'
        recovering = start_run()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda _: pending_claim(recovering), range(2)))
        claimed = [item for result in claims for item in result]
        assert sorted(map(len, claims)) == [0,5] and len({item['id'] for item in claimed}) == 5
        assert all(item['discovery_batch_id'] == origin and item['retention_eligible_at'] is None for item in claimed)
        assert pending_claim(recovering) == []
        stop_run(recovering)
        recovering = start_run()
        reclaimed = pending_claim(recovering)
        assert {item['id'] for item in reclaimed} == {item['id'] for item in claimed}
        assert all(next(item for item in claimed if item['id']==candidate['id'])['processing_lease_id'] != candidate['processing_lease_id'] for candidate in reclaimed)
        claimed = reclaimed
        for candidate in claimed[:2]:
            assert finish(candidate)['applied']
        # Simulate a checkpoint interruption with three claimed rows still pending.
        data(f"mahshar_worker_advance_target_run('{recovering}',0,10,0,0,0,0,0,0,0,0,false,false,false)")
        stop_run(recovering,10)
        resumed_id = start_run(True)
        assert sql(f"SELECT discovery_batch_id FROM worker_runs WHERE id='{resumed_id}';") == recovering
        assert pending_claim(resumed_id) == []  # Active leases are not reissued on concurrent replay.
        sql(f"UPDATE worker_candidates SET processing_lease_expires_at=clock_timestamp()-interval '1 second' WHERE deferred_claim_batch_id='{recovering}' AND status='pending';")
        renewed = pending_claim(resumed_id)
        assert {item['id'] for item in renewed} == {item['id'] for item in claimed[2:]}
        for old in claimed[2:]:
            failure(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{old['id']}','{old['processing_lease_id']}','filtered','fit_below_threshold');", 'worker_candidate_lease_mismatch')
        for candidate in renewed:
            assert finish(candidate)['applied']
        assert pending_claim(resumed_id) == []
        stop_run(resumed_id,10)
        final_run = start_run()
        sql(f"UPDATE worker_runs SET qualified_count=50 WHERE id='{final_run}';")
        assert pending_claim(final_run) == []
        sql(f"UPDATE worker_runs SET qualified_count=0,deadline_at=clock_timestamp()-interval '1 second' WHERE id='{final_run}';")
        assert pending_claim(final_run) == []
        sql(f"UPDATE worker_runs SET deadline_at=clock_timestamp()+interval '30 minutes' WHERE id='{final_run}';")
        data('mahshar_worker_request_stop()')
        assert pending_claim(final_run) == []
        stop_run(final_run)
        final_run = start_run()
        final_slice = pending_claim(final_run)
        assert len(final_slice) == 4
        for candidate in final_slice:
            assert finish(candidate)['applied']
        assert sql(f"SELECT count(*) FROM worker_candidates WHERE discovery_batch_id='{origin}' AND status='pending';") == '0'
        assert sql(f"SELECT count(*) FROM worker_candidates WHERE discovery_batch_id='{origin}';") == '10'
        assert cursor() == '10'
        print('PASS: 10 consumed / 1 completed / 9 pending recover as 5+4 across Starts; concurrent claims, Resume lease renewal and stale completion fencing', flush=True)

        # Actual database cap remains atomic even when HTTP dispatchers race at its final allowance.
        sql(f"UPDATE worker_runs SET source_query_count=300 WHERE id='{final_run}';")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            budgets = list(pool.map(lambda n: data(f"mahshar_worker_claim_budget_v2('{final_run}','source','attempt:concurrent:{n}')"), range(2)))
        assert sorted(budgets) == ['claimed','exhausted']
        assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{final_run}';") == '301'
        assert data(f"mahshar_worker_claim_budget_v2('{final_run}','source','attempt:concurrent:{budgets.index('claimed')}')") == 'replayed'
        data('mahshar_worker_request_stop()')
        assert pending_claim(final_run) == []
        stop_run(final_run)
        expired = start_run()
        sql(f"UPDATE worker_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id='{expired}';")
        assert pending_claim(expired) == []
        print('PASS: concurrent source HTTP budget cap, Stop and deadline claim fences', flush=True)
        assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '1'
        assert sql("SELECT status FROM admin_worker_mail_registry WHERE provider_id='"+provider+"';") == 'manual_sent'
        assert sql('SELECT count(*) FROM worker_providers;') == '2'
        unchanged = snapshots()
        assert all(unchanged[table] == original[table] for table in tables if table not in ['worker_control','worker_runs'])
        assert sql('SELECT count(*) FROM admin_outreach_messages;') == '0'
        print('PASS: directory observations create no providers, qualified leads, Pending Emails or invitations', flush=True)
        if '--expanded' in __import__('sys').argv:
            exec(compile((ROOT / 'tests/admin-worker/source-expansion-postgres.py').read_text(), 'source-expansion-postgres.py', 'exec'))
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', socket / 'data', '-m', 'immediate', '-w', 'stop'])
