"""Fresh-schema Worker lifecycle, security, checkpoint, and concurrency checks."""
import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261001000100_admin_worker_foundation.sql'
PRIVILEGE_REPAIR = ROOT / 'supabase/migrations/20261001000110_admin_worker_least_privilege.sql'
DISCOVERY = ROOT / 'supabase/migrations/20261002000100_admin_worker_discovery_v1.sql'
REVIEW_BAND = ROOT / 'supabase/migrations/20261004000100_admin_worker_discovery_review_candidates.sql'
QUALIFIED_TARGET = ROOT / 'supabase/migrations/20261005000100_admin_worker_qualified_target_traction.sql'
RETRY_IDEMPOTENCY = ROOT / 'supabase/migrations/20261005000200_admin_worker_retry_idempotency.sql'
CONTACT_DISCOVERY = ROOT / 'supabase/migrations/20261005000300_admin_worker_contact_discovery.sql'
CONTACT_REENRICHMENT = ROOT / 'supabase/migrations/20261007000100_admin_worker_contact_reenrichment.sql'
configured_bin = os.environ.get('MAHSHAR_PG_BIN')
if configured_bin:
    BIN = pathlib.Path(configured_bin)
elif shutil.which('initdb'):
    BIN = pathlib.Path(shutil.which('initdb')).resolve().parent
elif shutil.which('pg_config'):
    BIN = pathlib.Path(subprocess.run(
        [shutil.which('pg_config'), '--bindir'], check=True, text=True, capture_output=True,
    ).stdout.strip())
else:
    BIN = pathlib.Path('/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin')
    if not BIN.is_dir():
        raise RuntimeError('PostgreSQL tools not found; install PostgreSQL or set MAHSHAR_PG_BIN')

ENV = dict(os.environ)
bundled_lib = BIN.parents[2] / 'x86_64-linux-gnu'
if bundled_lib.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(bundled_lib)

with tempfile.TemporaryDirectory(prefix='mahshar-worker-test-') as temporary:
    root = pathlib.Path(temporary)
    data = root / 'data'

    def run(args, **kwargs):
        return subprocess.run([str(value) for value in args], env=ENV, check=True, text=True,
                              capture_output=True, timeout=45, **kwargs)

    run([BIN / 'initdb', '-D', data, '-U', 'worker_test', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', data, '-l', root / 'postgres.log', '-o',
             f"-k {root} -p 55462 -c listen_addresses=''", '-w', 'start'])
        started = True

        def sql(statement):
            return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', root, '-p', '55462',
                        '-U', 'worker_test', '-d', 'postgres'], input=statement).stdout.strip()

        def expect_failure(statement, marker=None):
            try:
                sql(statement)
                raise AssertionError(f'expected SQL failure: {statement[:100]}')
            except subprocess.CalledProcessError as error:
                if marker:
                    assert marker in error.stderr, error.stderr

        def rpc_json(expression):
            try:
                return json.loads(sql(f"SET ROLE service_role; SELECT row_to_json(r) FROM {expression} r;"))
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error

        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        migrations = list((ROOT / 'supabase/migrations').glob('*.sql'))
        versions = [migration.name.split('_', 1)[0] for migration in migrations]
        assert all(version.isdigit() for version in versions), versions
        assert len(versions) == len(set(versions)), versions
        migrations = sorted(migrations, key=lambda path: path.name.split('_', 1)[0])
        assert [migration.name.split('_', 1)[0] for migration in migrations] == [
            '20240626000000', '20240627', '20240627000001', '20260710',
            '20260823', '20260823000001', '20260918', '20260919',
            '20260919000001', '20260923000300', '20260926000100',
            '20260926000200', '20260926000300', '20260926000400',
            '20260926000500', '20260928000100', '20260928000200',
            '20260928000300', '20261001000000', '20261001000030',
            '20261001000100', '20261001000110',
            '20261002000100', '20261004000100', '20261005000100', '20261005000200', '20261005000300',
            '20261007000100',
        ]
        for migration in migrations:
            if migration not in (MIGRATION, PRIVILEGE_REPAIR, DISCOVERY, REVIEW_BAND, QUALIFIED_TARGET, RETRY_IDEMPOTENCY, CONTACT_DISCOVERY, CONTACT_REENRICHMENT):
                sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')

        # Model Supabase projects whose default ACLs expose new objects. The
        # Worker migration must explicitly revoke these grants.
        sql("""
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC, anon, authenticated;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT USAGE, SELECT ON SEQUENCES TO PUBLIC, anon, authenticated;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT ALL ON TABLES TO service_role;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT ALL ON SEQUENCES TO service_role;
        """)

        # Every statement is transaction-safe. A forced terminal error must
        # roll back tables, sequence, functions, and the singleton row.
        rollback_sql = "BEGIN;\n" + MIGRATION.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_migration_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_migration_rollback')
        assert sql("SELECT to_regclass('public.worker_control');") == ''
        assert sql("SELECT to_regprocedure('public.mahshar_worker_create_run(boolean)');") == ''
        sql(MIGRATION.read_text())

        # Reproduce the production default-ACL drift before repairing it.
        assert sql("SELECT has_table_privilege('service_role','public.worker_control','TRUNCATE');") == 't'
        assert sql("SELECT has_sequence_privilege('service_role','public.worker_runs_run_number_seq','UPDATE');") == 't'
        rollback_sql = "BEGIN;\n" + PRIVILEGE_REPAIR.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_privilege_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_privilege_rollback')
        assert sql("SELECT has_table_privilege('service_role','public.worker_control','TRUNCATE');") == 't'
        assert sql("SELECT has_sequence_privilege('service_role','public.worker_runs_run_number_seq','UPDATE');") == 't'
        sql('BEGIN;\n' + PRIVILEGE_REPAIR.read_text() + '\nCOMMIT;')
        rollback_sql = "BEGIN;\n" + DISCOVERY.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_discovery_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_discovery_rollback')
        assert sql("SELECT to_regclass('public.worker_candidates');") == ''
        sql('BEGIN;\n' + DISCOVERY.read_text() + '\nCOMMIT;')
        assert 'review_candidate' not in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.worker_leads'::regclass AND pg_get_constraintdef(oid) LIKE '%qualification_status%';")
        rollback_sql = "BEGIN;\n" + REVIEW_BAND.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_review_band_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_review_band_rollback')
        assert 'review_candidate' not in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.worker_leads'::regclass AND pg_get_constraintdef(oid) LIKE '%qualification_status%';")
        sql('BEGIN;\n' + REVIEW_BAND.read_text() + '\nCOMMIT;')
        assert 'review_candidate' in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.worker_leads'::regclass AND pg_get_constraintdef(oid) LIKE '%qualification_status%';")

        worker_tables = ['worker_control', 'worker_runs', 'worker_providers', 'worker_provider_identities',
                         'worker_products', 'worker_leads', 'worker_sources', 'worker_decisions',
                         'worker_candidates', 'worker_budget_claims', 'worker_deferred_claims', 'worker_source_work']
        intended_table_privileges = {'SELECT', 'INSERT', 'UPDATE', 'DELETE'}
        all_table_privileges = intended_table_privileges | {'TRUNCATE', 'REFERENCES', 'TRIGGER'}
        if int(sql('SHOW server_version_num;')) >= 170000:
            all_table_privileges.add('MAINTAIN')
        for table in worker_tables:
            assert sql(f"SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass;") == 't'
            assert sql(f"SELECT count(*) FROM pg_policy WHERE polrelid='public.{table}'::regclass;") == '0'
            for role in ['anon', 'authenticated']:
                for privilege in all_table_privileges:
                    assert sql(f"SELECT has_table_privilege('{role}','public.{table}','{privilege}');") == 'f'
            for privilege in all_table_privileges:
                expected = 't' if privilege in intended_table_privileges else 'f'
                assert sql(f"SELECT has_table_privilege('service_role','public.{table}','{privilege}');") == expected
            public_grants = sql(f"""
              SELECT count(*) FROM pg_class c,
                LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
              WHERE c.oid='public.{table}'::regclass AND acl.grantee=0;
            """)
            assert public_grants == '0'

        sequence = 'public.worker_runs_run_number_seq'
        for role in ['anon', 'authenticated']:
            for privilege in ['USAGE', 'SELECT', 'UPDATE']:
                assert sql(f"SELECT has_sequence_privilege('{role}','{sequence}','{privilege}');") == 'f'
        assert sql(f"SELECT has_sequence_privilege('service_role','{sequence}','USAGE');") == 't'
        assert sql(f"SELECT has_sequence_privilege('service_role','{sequence}','SELECT');") == 'f'
        assert sql(f"SELECT has_sequence_privilege('service_role','{sequence}','UPDATE');") == 'f'
        assert sql(f"""
          SELECT count(*) FROM pg_class c,
            LATERAL aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) acl
          WHERE c.oid='{sequence}'::regclass AND acl.grantee=0;
        """) == '0'

        worker_functions = [
            'mahshar_worker_reconcile_stale_run()', 'mahshar_worker_create_run(boolean)',
            'mahshar_worker_request_stop()', 'mahshar_worker_claim_run(uuid)',
            'mahshar_worker_advance_run(uuid,integer,integer)', 'mahshar_worker_complete_run(uuid)',
            'mahshar_worker_fail_run(uuid,text)', 'mahshar_worker_attach_workflow_run(uuid,text)',
            'mahshar_worker_claim_budget(uuid,text,text)',
            'mahshar_worker_materialize_source_work(uuid,text,text,jsonb)',
            'mahshar_worker_claim_deferred_candidates(uuid,text,integer)',
            'mahshar_worker_resolve_discovery_lead(uuid,uuid,text,text,text,text,text)',
            'mahshar_worker_complete_candidate(uuid,uuid,text,text,text,text,uuid,uuid,uuid)',
            'mahshar_worker_persist_qualification(uuid,uuid,uuid,uuid,uuid,jsonb,text,boolean,text)',
            'mahshar_worker_advance_discovery_run(uuid,integer,integer,integer,integer,integer,integer,integer)',
        ]
        for function in worker_functions:
            for role in ['anon', 'authenticated']:
                assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');") == 't'
            function_config = sql(f"""
              SELECT p.prosecdef::text || ',' || coalesce(array_to_string(p.proconfig, '|'), '')
              FROM pg_proc p WHERE p.oid='public.{function}'::regprocedure;
            """)
            assert function_config in {'true,search_path=', 'true,search_path=""'}, function_config
            assert sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{function}'::regprocedure;") == 'worker_test'
            assert sql(f"""
              SELECT count(*) FROM pg_proc p,
                LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              WHERE p.oid='public.{function}'::regprocedure AND acl.grantee=0;
            """) == '0'

        for role in ['anon', 'authenticated', 'service_role']:
            assert sql(f"SELECT has_schema_privilege('{role}','public','CREATE');") == 'f'
        assert sql("""
          SELECT count(*) FROM pg_namespace n,
            LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
          WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE';
        """) == '0'

        assert sql("SELECT desired_state||','||batch_size FROM worker_control WHERE id=1;") == 'stopped,50'
        assert sql("SELECT count(*) FROM worker_runs WHERE status IN ('queued','running','stop_requested');") == '0'
        expect_failure("SET ROLE service_role; UPDATE worker_control SET batch_size=101 WHERE id=1;")
        for invalid_size in [49, 51, 77]:
            sql(f"SET ROLE service_role; UPDATE worker_control SET batch_size={invalid_size} WHERE id=1;")
            expect_failure("SET ROLE service_role; SELECT (mahshar_worker_create_run(false)).id;", 'worker_discovery_batch_size_invalid')
            assert sql("SELECT count(*) FROM worker_runs;") == '0'
        sql("SET ROLE service_role; UPDATE worker_control SET batch_size=50 WHERE id=1;")

        # Discovery counters, budgets, and durable work items are bounded. A
        # resumed run keeps its logical batch and cumulative usage.
        discovery_run = rpc_json('mahshar_worker_create_run(false)')
        discovery_id = discovery_run['id']
        assert discovery_run['discovery_batch_id'] == discovery_id
        assert discovery_run['batch_size'] == 50
        rpc_json(f"mahshar_worker_claim_run('{discovery_id}')")
        provider_window = json.dumps({'kind': 'provider_window', 'providers': ['original.example']})
        changed_window = json.dumps({'kind': 'provider_window', 'providers': ['changed.example']})
        materialized = json.loads(sql(f"SET ROLE service_role; SELECT mahshar_worker_materialize_source_work('{discovery_id}','providers:0','provider_window',$work${provider_window}$work$::jsonb);"))
        assert materialized['providers'] == ['original.example']
        assert sql(f"SELECT count(*) FROM worker_candidates WHERE discovery_batch_id='{discovery_id}';") == '0'
        replayed_materialization = json.loads(sql(f"SET ROLE service_role; SELECT mahshar_worker_materialize_source_work('{discovery_id}','providers:0','provider_window',$work${changed_window}$work$::jsonb);"))
        assert replayed_materialization == materialized
        assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{discovery_id}';") == '1'
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            budget_results = [future.result() for future in [
                pool.submit(sql, f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{discovery_id}','groq','candidate:{index}');")
                for index in range(25)
            ]]
        assert budget_results.count('t') == 20, budget_results
        assert budget_results.count('f') == 5, budget_results
        assert sql(f"SELECT groq_call_count FROM worker_runs WHERE id='{discovery_id}';") == '20'
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{discovery_id}','source','providers:0');") == 't'
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{discovery_id}','source','providers:0');") == 't'
        assert sql(f"SELECT source_query_count FROM worker_runs WHERE id='{discovery_id}';") == '1'
        first_claim = sql(f"SELECT claim_key FROM worker_budget_claims WHERE discovery_batch_id='{discovery_id}' AND budget_type='groq' ORDER BY claim_key LIMIT 1;")
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{discovery_id}','groq','{first_claim}');") == 'f'
        assert sql(f"SELECT groq_call_count FROM worker_runs WHERE id='{discovery_id}';") == '20'
        discovery_advanced = rpc_json(
            f"mahshar_worker_advance_discovery_run('{discovery_id}',0,10,10,2,3,1,1)"
        )
        assert discovery_advanced['processed_count'] == 10
        assert discovery_advanced['discovered_count'] == 10
        assert discovery_advanced['duplicate_count'] == 2
        assert discovery_advanced['filtered_count'] == 3
        assert discovery_advanced['qualified_count'] == 1
        assert discovery_advanced['persisted_count'] == 1
        replayed_discovery = rpc_json(
            f"mahshar_worker_advance_discovery_run('{discovery_id}',0,10,10,2,3,1,1)"
        )
        assert replayed_discovery['discovered_count'] == 10
        assert replayed_discovery['qualified_count'] == 1
        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_candidates(discovery_batch_id, ordinal, source_type, source_url, discovered_name)
          VALUES('{discovery_id}',0,'api_directory','https://api.apis.guru/v2/example.com.json','example.com');
        """)
        expect_failure(f"SET ROLE service_role; INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name) VALUES('{discovery_id}',0,'api_directory','https://api.apis.guru/v2/example.com.json','duplicate');")
        rpc_json('mahshar_worker_request_stop()')
        stopped_discovery = rpc_json(
            f"mahshar_worker_advance_discovery_run('{discovery_id}',10,20,10,0,0,0,0)"
        )
        assert stopped_discovery['status'] == 'stopped' and stopped_discovery['processed_count'] == 10
        resumed_discovery = rpc_json('mahshar_worker_create_run(true)')
        assert resumed_discovery['discovery_batch_id'] == discovery_id
        assert resumed_discovery['batch_size'] == 50
        assert resumed_discovery['discovered_count'] == 10
        assert resumed_discovery['groq_call_count'] == 20
        assert resumed_discovery['deadline_at'] == stopped_discovery['deadline_at']
        rpc_json(f"mahshar_worker_claim_run('{resumed_discovery['id']}')")
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{resumed_discovery['id']}','groq','{first_claim}');") == 'f'
        assert sql(f"SELECT groq_call_count FROM worker_runs WHERE id='{resumed_discovery['id']}';") == '20'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{resumed_discovery['id']}','test_cleanup')).status;")

        provider = '10000000-0000-4000-8000-000000000001'
        product = '20000000-0000-4000-8000-000000000001'
        lead = '30000000-0000-4000-8000-000000000001'
        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_providers(id,canonical_name,canonical_domain)
          VALUES('{provider}','Synthetic provider','synthetic.invalid');
          INSERT INTO worker_provider_identities(provider_id,identity_type,normalized_value,original_value)
          VALUES('{provider}','domain','synthetic.invalid','Synthetic.invalid');
          INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
          VALUES('{product}','{provider}','synthetic-api','Synthetic API');
          INSERT INTO worker_leads(id,provider_id,product_id,status)
          VALUES('{lead}','{provider}','{product}','discovered');
          INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code)
          VALUES('{provider}','{lead}','do_not_contact','manual_block');
        """)
        assert sql("SELECT decision FROM worker_decisions;") == 'do_not_contact'
        expect_failure(f"SET ROLE service_role; INSERT INTO worker_provider_identities(provider_id,identity_type,normalized_value,original_value) VALUES('{provider}','domain','synthetic.invalid','duplicate');")
        expect_failure(f"SET ROLE service_role; INSERT INTO worker_leads(provider_id,product_id,status) VALUES('{provider}','{product}','discovered');")

        # A DNC committed by a separate client after research but before the
        # atomic resolver prevents all new entity creation.
        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
            discovered_domain,discovered_product,discovered_docs_url)
          VALUES('{discovery_id}',1,'api_directory','https://api.apis.guru/v2/synthetic.invalid.json',
            'Synthetic provider','synthetic.invalid','Blocked New API','https://api.synthetic.invalid/openapi.json');
        """)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(sql, f"SET ROLE service_role; INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{provider}',NULL,'do_not_contact','race_block');").result()
        blocked_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{discovery_id}' AND ordinal=1;")
        blocked_resolution = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_resolve_discovery_lead('{blocked_candidate}',NULL,'synthetic.invalid','blocked-new',
            'Synthetic provider','synthetic.invalid','Blocked New API');
        """))
        assert blocked_resolution['action'] == 'blocked'
        assert blocked_resolution['reasonCode'] == 'provider_do_not_contact'
        assert sql(f"SELECT count(*) FROM worker_products WHERE provider_id='{provider}' AND normalized_product_key='blocked-new';") == '0'

        # Deferred candidates are claimed in stable order by a fresh logical
        # batch, reuse the same entities, and respect a DNC added while queued.
        deferred_rows = []
        for ordinal, domain in [(2, 'retry-one.invalid'), (3, 'retry-dnc.invalid'), (4, 'retry-one.invalid')]:
            sql(f"""
              SET ROLE service_role;
              INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
                discovered_domain,discovered_product,discovered_docs_url)
              VALUES('{discovery_id}',{ordinal},'api_directory','https://api.apis.guru/v2/{domain}.json',
                '{domain}','{domain}','Retry API','https://api.{domain}/openapi.json');
            """)
            candidate_id = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{discovery_id}' AND ordinal={ordinal};")
            resolved = json.loads(sql(f"""
              SET ROLE service_role;
              SELECT mahshar_worker_resolve_discovery_lead('{candidate_id}',NULL,'{domain}','retry-v1',
                '{domain}','{domain}','Retry API');
            """))
            deferred_rows.append((candidate_id, resolved))
        first_entity = deferred_rows[0][1]
        duplicate_entity = deferred_rows[2][1]
        assert first_entity['providerId'] == duplicate_entity['providerId']
        assert first_entity['productId'] == duplicate_entity['productId']
        assert first_entity['leadId'] == duplicate_entity['leadId']
        assert sql("SELECT count(*) FROM worker_providers WHERE canonical_domain='retry-one.invalid';") == '1'
        assert sql(f"SELECT count(*) FROM worker_products WHERE provider_id='{first_entity['providerId']}' AND normalized_product_key='retry-v1';") == '1'
        assert sql(f"SELECT count(*) FROM worker_leads WHERE product_id='{first_entity['productId']}';") == '1'
        sql(f"""
          SET ROLE service_role;
          UPDATE worker_leads SET qualification_status='deferred', qualification_retry_after='2026-01-01T00:00:00Z'
          WHERE id IN ('{deferred_rows[0][1]['leadId']}','{deferred_rows[1][1]['leadId']}');
          UPDATE worker_candidates SET status='deferred', reason_code='groq_budget_exhausted'
          WHERE id IN ('{deferred_rows[0][0]}','{deferred_rows[1][0]}');
          UPDATE worker_candidates SET status='duplicate', reason_code='existing_lead' WHERE id='{deferred_rows[2][0]}';
          INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
            discovered_domain,discovered_product,discovered_docs_url,status,reason_code)
          VALUES('{discovery_id}',5,'api_directory','https://api.apis.guru/v2/research-retry.invalid.json',
            'research-retry.invalid','research-retry.invalid','Research Retry API',
            'https://api.research-retry.invalid/openapi.json','deferred','research_budget_exhausted');
        """)
        research_retry_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{discovery_id}' AND ordinal=5;")
        retry_run = rpc_json('mahshar_worker_create_run(false)')
        retry_id = retry_run['id']
        rpc_json(f"mahshar_worker_claim_run('{retry_id}')")
        fresh_materialization = json.loads(sql(f"SET ROLE service_role; SELECT mahshar_worker_materialize_source_work('{retry_id}','providers:0','provider_window',$work${changed_window}$work$::jsonb);"))
        assert fresh_materialization['providers'] == ['changed.example']
        claim_statement = f"SET ROLE service_role; SELECT coalesce(json_agg(candidate_id ORDER BY candidate_id),'[]') FROM mahshar_worker_claim_deferred_candidates('{retry_id}','workflow:deferred',5);"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            concurrent_claims = [json.loads(future.result()) for future in [pool.submit(sql, claim_statement) for _ in range(2)]]
        claimed = next(value for value in concurrent_claims if value)
        assert sorted(len(value) for value in concurrent_claims) == [0, 3], concurrent_claims
        assert set(claimed) == {deferred_rows[0][0], deferred_rows[1][0], research_retry_candidate}, (claimed, deferred_rows)
        claimed_replay = json.loads(sql(f"SET ROLE service_role; SELECT coalesce(json_agg(candidate_id),'[]') FROM mahshar_worker_claim_deferred_candidates('{retry_id}','workflow:deferred',5);"))
        assert claimed_replay == []
        first_lease = sql(f"SELECT processing_lease_id FROM worker_candidates WHERE id='{deferred_rows[0][0]}';")
        expect_failure(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{deferred_rows[0][0]}','00000000-0000-4000-8000-000000000001','persisted','qualified');", 'worker_candidate_lease_mismatch')
        dnc_provider = deferred_rows[1][1]['providerId']
        sql(f"SET ROLE service_role; INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{dnc_provider}',NULL,'do_not_contact','deferred_block');")
        retry_resolution = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_resolve_discovery_lead('{deferred_rows[0][0]}',(SELECT processing_lease_id FROM worker_candidates WHERE id='{deferred_rows[0][0]}'),'retry-one.invalid','retry-v1',
            'retry-one.invalid','retry-one.invalid','Retry API');
        """))
        assert retry_resolution['action'] == 'continue'
        dnc_resolution = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_resolve_discovery_lead('{deferred_rows[1][0]}',(SELECT processing_lease_id FROM worker_candidates WHERE id='{deferred_rows[1][0]}'),'retry-dnc.invalid','retry-v1',
            'retry-dnc.invalid','retry-dnc.invalid','Retry API');
        """))
        assert dnc_resolution['action'] == 'blocked' and dnc_resolution['reasonCode'] == 'provider_do_not_contact'
        sql(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{deferred_rows[0][0]}','{first_lease}','persisted','qualified');")
        dnc_lease = sql(f"SELECT processing_lease_id FROM worker_candidates WHERE id='{deferred_rows[1][0]}';")
        sql(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{deferred_rows[1][0]}','{dnc_lease}','blocked','provider_do_not_contact');")
        abandoned_lease = sql(f"SELECT processing_lease_id FROM worker_candidates WHERE id='{research_retry_candidate}';")
        sql(f"SET ROLE service_role; UPDATE worker_candidates SET processing_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='{research_retry_candidate}';")
        reclaimed = json.loads(sql(f"SET ROLE service_role; SELECT coalesce(json_agg(json_build_object('id',candidate_id,'lease',lease_id)),'[]') FROM mahshar_worker_claim_deferred_candidates('{retry_id}','workflow:reclaim',5);"))
        assert len(reclaimed) == 1 and reclaimed[0]['id'] == research_retry_candidate
        assert reclaimed[0]['lease'] != abandoned_lease
        sql(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{research_retry_candidate}','{reclaimed[0]['lease']}','filtered','test_cleanup');")
        assert json.loads(sql(f"SET ROLE service_role; SELECT coalesce(json_agg(candidate_id),'[]') FROM mahshar_worker_claim_deferred_candidates('{retry_id}','workflow:reclaim',5);")) == []
        expect_failure(f"SET ROLE service_role; SELECT * FROM mahshar_worker_claim_deferred_candidates('{retry_id}','workflow:wrong-limit',4);", 'worker_deferred_limit_invalid')

        # Two independent clients resolving the same provider/product race to
        # one durable entity set under the advisory lock and unique keys.
        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,discovered_product,discovered_docs_url)
          VALUES
            ('{discovery_id}',6,'api_directory','https://api.apis.guru/v2/resolver-race.invalid.json','Resolver race','resolver-race.invalid','Race API','https://api.resolver-race.invalid/openapi.json'),
            ('{discovery_id}',7,'api_directory','https://api.apis.guru/v2/resolver-race.invalid.json','Resolver race','resolver-race.invalid','Race API','https://api.resolver-race.invalid/openapi.json');
        """)
        resolver_candidates = sql(f"SELECT string_agg(id::text,',' ORDER BY ordinal) FROM worker_candidates WHERE discovery_batch_id='{discovery_id}' AND ordinal IN (6,7);").split(',')
        resolver_statements = [f"SET ROLE service_role; SELECT mahshar_worker_resolve_discovery_lead('{candidate_id}',NULL,'resolver-race.invalid','race-v1','Resolver race','resolver-race.invalid','Race API');" for candidate_id in resolver_candidates]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            resolver_results = [json.loads(future.result()) for future in [pool.submit(sql, statement) for statement in resolver_statements]]
        assert len({value['providerId'] for value in resolver_results}) == 1
        assert len({value['productId'] for value in resolver_results}) == 1
        assert len({value['leadId'] for value in resolver_results}) == 1
        assert sql("SELECT count(*) FROM worker_providers WHERE canonical_domain='resolver-race.invalid';") == '1'

        qualification_json = json.dumps({
            'fitScore': 88, 'commercialApi': True, 'agentUtility': 'high', 'payPerCallFit': 'high',
            'integrationDifficulty': 'medium', 'providerCredibility': 'high',
            'reasonCodes': ['useful_tool'], 'summary': 'Strong fit.',
        })

        def create_qualification_candidate(ordinal, domain):
            sql(f"""
              SET ROLE service_role;
              INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,discovered_product,discovered_docs_url)
              VALUES('{discovery_id}',{ordinal},'api_directory','https://api.apis.guru/v2/{domain}.json','{domain}','{domain}','Qualification API','https://api.{domain}/openapi.json');
            """)
            candidate_id = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{discovery_id}' AND ordinal={ordinal};")
            resolved = json.loads(sql(f"SET ROLE service_role; SELECT mahshar_worker_resolve_discovery_lead('{candidate_id}',NULL,'{domain}','qualification-v1','{domain}','{domain}','Qualification API');"))
            return candidate_id, resolved

        def qualification_statement(candidate_id, resolved, payload=qualification_json, qualified=True):
            return (f"SET ROLE service_role; SELECT mahshar_worker_persist_qualification('{candidate_id}',NULL,"
                    f"'{resolved['providerId']}','{resolved['productId']}','{resolved['leadId']}',"
                    f"$qualification${payload}$qualification$::jsonb,'fixture-model',{'true' if qualified else 'false'},NULL);")

        def wait_for_marker(marker):
            for _ in range(40):
                if sql(f"SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE '%{marker}%';") != '0':
                    return
                time.sleep(0.05)
            raise AssertionError(f'concurrent marker not observed: {marker}')

        # A manual status committed after resolution but before persistence
        # holds the lead row; the atomic RPC waits and preserves the status.
        human_candidate, human_entity = create_qualification_candidate(8, 'human-race.invalid')
        human_admin = f"BEGIN; UPDATE worker_leads SET status='reviewed' WHERE id='{human_entity['leadId']}'; SELECT pg_sleep(1) /* race_human_lock */; COMMIT;"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            admin_future = pool.submit(sql, human_admin)
            wait_for_marker('race_human_lock')
            qualification_future = pool.submit(sql, qualification_statement(human_candidate, human_entity))
            human_result = json.loads(qualification_future.result())
            admin_future.result()
        assert human_result['status'] == 'duplicate' and human_result['reasonCode'] == 'existing_human_state'
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{human_entity['leadId']}';") == 'reviewed,pending'

        # A concurrent Admin DNC transaction wins over Discovery persistence.
        dnc_candidate, dnc_entity = create_qualification_candidate(9, 'dnc-race.invalid')
        dnc_admin = f"BEGIN; INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{dnc_entity['providerId']}','{dnc_entity['leadId']}','do_not_contact','manual_block'); UPDATE worker_leads SET status='do_not_contact' WHERE id='{dnc_entity['leadId']}'; SELECT pg_sleep(1) /* race_dnc_lock */; COMMIT;"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            admin_future = pool.submit(sql, dnc_admin)
            wait_for_marker('race_dnc_lock')
            qualification_future = pool.submit(sql, qualification_statement(dnc_candidate, dnc_entity))
            dnc_result = json.loads(qualification_future.result())
            admin_future.result()
        assert dnc_result['status'] == 'blocked' and dnc_result['reasonCode'] == 'do_not_contact'
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{dnc_entity['leadId']}';") == 'do_not_contact,pending'

        # Failure injected on candidate completion rolls the preceding lead
        # write back; retry persists once and replay is idempotent.
        atomic_candidate, atomic_entity = create_qualification_candidate(10, 'atomic-persist.invalid')
        sql(f"""
          CREATE FUNCTION public.fail_candidate_completion() RETURNS trigger LANGUAGE plpgsql AS $trigger$
          BEGIN IF NEW.id='{atomic_candidate}' AND NEW.status='persisted' THEN RAISE EXCEPTION 'injected_candidate_completion_failure'; END IF; RETURN NEW; END $trigger$;
          CREATE TRIGGER fail_candidate_completion BEFORE UPDATE ON worker_candidates FOR EACH ROW EXECUTE FUNCTION public.fail_candidate_completion();
        """)
        expect_failure(qualification_statement(atomic_candidate, atomic_entity), 'injected_candidate_completion_failure')
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{atomic_entity['leadId']}';") == 'discovered,pending'
        assert sql(f"SELECT status FROM worker_candidates WHERE id='{atomic_candidate}';") == 'pending'
        sql("DROP TRIGGER fail_candidate_completion ON worker_candidates; DROP FUNCTION public.fail_candidate_completion();")
        atomic_result = json.loads(sql(qualification_statement(atomic_candidate, atomic_entity)))
        replay_result = json.loads(sql(qualification_statement(atomic_candidate, atomic_entity)))
        assert atomic_result['status'] == 'persisted' and replay_result['status'] == 'persisted'
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{atomic_entity['leadId']}';") == 'qualified,qualified'

        # Score bands are database-authoritative: review candidates persist
        # without inflating qualified counts or rejecting the product, while
        # the legacy boolean argument cannot override the score.
        review_candidate, review_entity = create_qualification_candidate(11, 'review-band.invalid')
        review_json = json.dumps({
            'fitScore': 65, 'commercialApi': False, 'agentUtility': 'high', 'payPerCallFit': 'medium',
            'integrationDifficulty': 'medium', 'providerCredibility': 'medium',
            'reasonCodes': ['niche_provider', 'pricing_unavailable'], 'summary': 'Technically compatible; manual review is useful.',
        })
        review_result = json.loads(sql(qualification_statement(review_candidate, review_entity, review_json, False)))
        review_replay = json.loads(sql(qualification_statement(review_candidate, review_entity, review_json, False)))
        assert review_result['status'] == 'persisted' and review_result['reasonCode'] == 'review_candidate'
        assert review_replay['status'] == 'persisted' and review_replay['reasonCode'] == 'review_candidate' and not review_replay['applied']
        assert sql(f"SELECT status||','||qualification_status||','||fit_score FROM worker_leads WHERE id='{review_entity['leadId']}';") == 'discovered,review_candidate,65.00'
        assert sql(f"SELECT status FROM worker_products WHERE id='{review_entity['productId']}';") == 'discovered'
        assert sql(f"SELECT count(*) FROM worker_decisions WHERE lead_id='{review_entity['leadId']}';") == '0'

        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,discovered_product,discovered_docs_url)
          VALUES('{discovery_id}',12,'api_directory','https://api.apis.guru/v2/review-band.invalid.json','Review band','review-band.invalid','Qualification API','https://api.review-band.invalid/openapi.json');
        """)
        review_duplicate_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{discovery_id}' AND ordinal=12;")
        review_resolution = json.loads(sql(f"SET ROLE service_role; SELECT mahshar_worker_resolve_discovery_lead('{review_duplicate_candidate}',NULL,'review-band.invalid','qualification-v1','review-band.invalid','review-band.invalid','Qualification API');"))
        assert review_resolution['action'] == 'duplicate' and review_resolution['reasonCode'] == 'existing_review_candidate'

        qualified_candidate, qualified_entity = create_qualification_candidate(13, 'score-authoritative.invalid')
        qualified_json = json.dumps({**json.loads(qualification_json), 'fitScore': 70, 'commercialApi': False})
        qualified_result = json.loads(sql(qualification_statement(qualified_candidate, qualified_entity, qualified_json, False)))
        assert qualified_result['status'] == 'persisted' and qualified_result['reasonCode'] == 'qualified'
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{qualified_entity['leadId']}';") == 'qualified,qualified'

        low_candidate, low_entity = create_qualification_candidate(14, 'low-fit.invalid')
        low_json = json.dumps({**json.loads(qualification_json), 'fitScore': 59})
        low_result = json.loads(sql(qualification_statement(low_candidate, low_entity, low_json, True)))
        assert low_result['status'] == 'filtered' and low_result['reasonCode'] == 'fit_below_threshold'
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{low_entity['leadId']}';") == 'rejected,rejected'

        for ordinal, score, expected_status, expected_reason, application_flag in [
            (15, 60, 'discovered,review_candidate', 'review_candidate', True),
            (16, 69, 'discovered,review_candidate', 'review_candidate', True),
            (17, 100, 'qualified,qualified', 'qualified', False),
        ]:
            boundary_candidate, boundary_entity = create_qualification_candidate(ordinal, f'score-{score}.invalid')
            boundary_json = json.dumps({**json.loads(qualification_json), 'fitScore': score})
            boundary_result = json.loads(sql(qualification_statement(
                boundary_candidate, boundary_entity, boundary_json, application_flag,
            )))
            assert boundary_result['status'] == 'persisted' and boundary_result['reasonCode'] == expected_reason
            assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{boundary_entity['leadId']}';") == expected_status
        sql(f"SET ROLE service_role; UPDATE worker_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id='{retry_id}';")
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{retry_id}','source','deadline:test');") == 'f'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{retry_id}','test_cleanup')).status;")

        # Healthy active work must not be reconciled or duplicated.
        healthy = rpc_json('mahshar_worker_create_run(false)')
        healthy_id = healthy['id']
        assert sql("SET ROLE service_role; SELECT (mahshar_worker_reconcile_stale_run()).id IS NULL;") == 't'
        expect_failure("SET ROLE service_role; SELECT (mahshar_worker_create_run(false)).id;", 'worker_already_active')
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{healthy_id}','test_cleanup')).status;")

        # Stale queued, running, and stop-requested rows reconcile once, preserve
        # checkpoint provenance, and release the one-active invariant.
        for stale_status in ['queued', 'running', 'stop_requested']:
            stale = rpc_json('mahshar_worker_create_run(false)')
            stale_id = stale['id']
            if stale_status == 'running':
                rpc_json(f"mahshar_worker_claim_run('{stale_id}')")
            elif stale_status == 'stop_requested':
                rpc_json('mahshar_worker_request_stop()')
            sql(f"SET ROLE service_role; UPDATE worker_runs SET heartbeat_at=clock_timestamp()-interval '16 minutes' WHERE id='{stale_id}';")
            reconciled = rpc_json('mahshar_worker_reconcile_stale_run()')
            assert reconciled['id'] == stale_id and reconciled['status'] == 'failed'
            assert reconciled['error_code'] == 'worker_run_stale'
            assert sql("SELECT desired_state FROM worker_control WHERE id=1;") == 'stopped'
            assert sql("SELECT checkpoint_run_id::text FROM worker_control WHERE id=1;") == stale_id
            assert sql("SET ROLE service_role; SELECT (mahshar_worker_reconcile_stale_run()).id IS NULL;") == 't'

        # Start atomically reconciles an orphan before checking active state.
        orphan = rpc_json('mahshar_worker_create_run(false)')
        sql(f"SET ROLE service_role; UPDATE worker_runs SET heartbeat_at=clock_timestamp()-interval '16 minutes' WHERE id='{orphan['id']}';")
        after_reconcile = rpc_json('mahshar_worker_create_run(false)')
        assert after_reconcile['id'] != orphan['id']
        assert sql(f"SELECT status||','||error_code FROM worker_runs WHERE id='{orphan['id']}';") == 'failed,worker_run_stale'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{after_reconcile['id']}','test_cleanup')).status;")

        # Checkpoint writes are monotonic and tolerate exact and delayed stale
        # deliveries from a duplicate Workflow invocation using the same run ID.
        replay = rpc_json('mahshar_worker_create_run(false)')
        replay_id = replay['id']
        assert rpc_json(f"mahshar_worker_claim_run('{replay_id}')")['status'] == 'running'
        assert rpc_json(f"mahshar_worker_claim_run('{replay_id}')")['status'] == 'running'
        assert rpc_json(f"mahshar_worker_advance_run('{replay_id}',0,10)")['processed_count'] == 10
        assert rpc_json(f"mahshar_worker_advance_run('{replay_id}',0,10)")['processed_count'] == 10
        assert rpc_json(f"mahshar_worker_advance_run('{replay_id}',10,20)")['processed_count'] == 20
        delayed = rpc_json(f"mahshar_worker_advance_run('{replay_id}',0,10)")
        assert delayed['processed_count'] == 20 and delayed['status'] == 'running'
        expect_failure(f"SET ROLE service_role; SELECT (mahshar_worker_advance_run('{replay_id}',1,10)).id;", 'worker_checkpoint_conflict')
        assert sql(f"SELECT (checkpoint->>'nextIndex')||','||processed_count FROM worker_runs WHERE id='{replay_id}';") == '20,20'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{replay_id}','test_cleanup')).status;")

        gap = rpc_json('mahshar_worker_create_run(false)')
        gap_id = gap['id']
        rpc_json(f"mahshar_worker_claim_run('{gap_id}')")
        expect_failure(f"SET ROLE service_role; SELECT (mahshar_worker_advance_run('{gap_id}',0,20)).id;", 'worker_checkpoint_conflict')
        assert sql(f"SELECT processed_count FROM worker_runs WHERE id='{gap_id}';") == '0'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{gap_id}','test_cleanup')).status;")

        # A stopped run owns the resumable checkpoint. Resume creates a new row.
        stopped_source = rpc_json('mahshar_worker_create_run(false)')
        stopped_source_id = stopped_source['id']
        rpc_json(f"mahshar_worker_claim_run('{stopped_source_id}')")
        rpc_json(f"mahshar_worker_advance_run('{stopped_source_id}',0,10)")
        rpc_json('mahshar_worker_request_stop()')
        stopped = rpc_json(f"mahshar_worker_advance_run('{stopped_source_id}',10,20)")
        assert stopped['status'] == 'stopped' and stopped['processed_count'] == 10
        assert sql("SELECT checkpoint_run_id::text FROM worker_control WHERE id=1;") == stopped_source_id
        resumed = rpc_json('mahshar_worker_create_run(true)')
        assert resumed['id'] != stopped_source_id and resumed['processed_count'] == 10
        resumed_id = resumed['id']
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{resumed_id}','test_cleanup')).status;")

        # Wrong-run and mismatched-body provenance are rejected atomically.
        wrong_source = rpc_json('mahshar_worker_create_run(false)')
        wrong_source_id = wrong_source['id']
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{wrong_source_id}','test_cleanup')).status;")
        sql(f"SET ROLE service_role; UPDATE worker_control SET current_checkpoint='{json.dumps(stopped['checkpoint'])}'::jsonb, checkpoint_run_id='{wrong_source_id}' WHERE id=1;")
        expect_failure("SET ROLE service_role; SELECT (mahshar_worker_create_run(true)).id;", 'worker_checkpoint_provenance_invalid')
        sql(f"SET ROLE service_role; UPDATE worker_control SET current_checkpoint='{json.dumps(stopped['checkpoint'])}'::jsonb, checkpoint_run_id='{stopped_source_id}' WHERE id=1;")
        mismatched = dict(stopped['checkpoint'])
        mismatched['nextIndex'] = 20
        sql(f"SET ROLE service_role; UPDATE worker_control SET current_checkpoint='{json.dumps(mismatched)}'::jsonb WHERE id=1;")
        expect_failure("SET ROLE service_role; SELECT (mahshar_worker_create_run(true)).id;", 'worker_checkpoint_provenance_invalid')
        expect_failure("SET ROLE service_role; UPDATE worker_control SET checkpoint_run_id=NULL WHERE id=1;")
        expect_failure("SET ROLE service_role; UPDATE worker_control SET checkpoint_run_id='not-a-uuid' WHERE id=1;")

        # Restore legitimate provenance, then prove Resume also reconciles its
        # own stale active predecessor before creating a new historical run.
        sql(f"SET ROLE service_role; UPDATE worker_control SET current_checkpoint='{json.dumps(stopped['checkpoint'])}'::jsonb, checkpoint_run_id='{stopped_source_id}', desired_state='stopped' WHERE id=1;")
        first_resume = rpc_json('mahshar_worker_create_run(true)')
        sql(f"SET ROLE service_role; UPDATE worker_runs SET heartbeat_at=clock_timestamp()-interval '16 minutes' WHERE id='{first_resume['id']}';")
        second_resume = rpc_json('mahshar_worker_create_run(true)')
        assert second_resume['id'] != first_resume['id'] and second_resume['processed_count'] == 10
        assert sql(f"SELECT status||','||error_code FROM worker_runs WHERE id='{first_resume['id']}';") == 'failed,worker_run_stale'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{second_resume['id']}','test_cleanup')).status;")

        # A completed checkpoint is terminal and cannot resume.
        complete_run = rpc_json('mahshar_worker_create_run(false)')
        complete_id = complete_run['id']
        rpc_json(f"mahshar_worker_claim_run('{complete_id}')")
        for expected in [0, 10, 20, 30, 40]:
            value = rpc_json(f"mahshar_worker_advance_run('{complete_id}',{expected},{expected + 10})")
        assert value['processed_count'] == 50
        completed = rpc_json(f"mahshar_worker_complete_run('{complete_id}')")
        assert completed['status'] == 'completed'
        expect_failure("SET ROLE service_role; SELECT (mahshar_worker_create_run(true)).id;", 'worker_not_resumable')

        # Stop and completion serialize under the control lock. Either valid
        # terminal outcome is acceptable, and no active row may remain.
        race = rpc_json('mahshar_worker_create_run(false)')
        race_id = race['id']
        rpc_json(f"mahshar_worker_claim_run('{race_id}')")
        for expected in [0, 10, 20, 30, 40]:
            rpc_json(f"mahshar_worker_advance_run('{race_id}',{expected},{expected + 10})")
        statements = [
            "SET ROLE service_role; SELECT (mahshar_worker_request_stop()).status;",
            f"SET ROLE service_role; SELECT (mahshar_worker_complete_run('{race_id}')).status;",
        ]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [future.result() for future in [pool.submit(sql, statement) for statement in statements]]
        assert all(outcome in {'', 'completed', 'stop_requested', 'stopped'} for outcome in outcomes), outcomes
        assert sql(f"SELECT status FROM worker_runs WHERE id='{race_id}';") in {'completed', 'stopped'}
        assert sql("SELECT count(*) FROM worker_runs WHERE status IN ('queued','running','stop_requested');") == '0'

        # Two real database clients racing Start still cannot create two active runs.
        start_statement = "SET ROLE service_role; SELECT (mahshar_worker_create_run(false)).id;"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(sql, start_statement) for _ in range(2)]
            outcomes = []
            for future in futures:
                try:
                    outcomes.append(('ok', future.result()))
                except subprocess.CalledProcessError as error:
                    outcomes.append(('error', error.stderr))
        assert [kind for kind, _ in outcomes].count('ok') == 1, outcomes
        assert [kind for kind, _ in outcomes].count('error') == 1, outcomes
        assert 'worker_already_active' in next(value for kind, value in outcomes if kind == 'error')
        assert sql("SELECT count(*) FROM worker_runs WHERE status IN ('queued','running','stop_requested');") == '1'

        # Seed deferred work under the pre-target production schema. It must
        # survive both forward migrations and remain processable by the new
        # target-aware claim and qualification functions.
        active_before_legacy_deferred = sql("SELECT id FROM worker_runs WHERE status IN ('queued','running','stop_requested') LIMIT 1;")
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{active_before_legacy_deferred}','test_cleanup')).status;")
        legacy_deferred_run = rpc_json('mahshar_worker_create_run(false)')
        legacy_deferred_run_id = legacy_deferred_run['id']
        rpc_json(f"mahshar_worker_claim_run('{legacy_deferred_run_id}')")
        legacy_deferred = []
        for ordinal, domain in enumerate(['legacy-target.invalid', 'legacy-dnc.invalid', 'legacy-human.invalid']):
            sql(f"""
              SET ROLE service_role;
              INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
                discovered_domain,discovered_product,discovered_docs_url)
              VALUES('{legacy_deferred_run_id}',{ordinal},'api_directory','https://api.apis.guru/v2/{domain}.json',
                '{domain}','{domain}','Legacy Deferred API','https://api.{domain}/openapi.json');
            """)
            candidate_id = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{legacy_deferred_run_id}' AND ordinal={ordinal};")
            entity = json.loads(sql(f"""
              SET ROLE service_role;
              SELECT mahshar_worker_resolve_discovery_lead('{candidate_id}',NULL,'{domain}','legacy-v1',
                '{domain}','{domain}','Legacy Deferred API');
            """))
            legacy_deferred.append((candidate_id, entity))
        legacy_lead_ids = ','.join(f"'{entity['leadId']}'" for _, entity in legacy_deferred)
        legacy_candidate_ids = ','.join(f"'{candidate_id}'" for candidate_id, _ in legacy_deferred)
        sql(f"""
          SET ROLE service_role;
          UPDATE worker_leads SET qualification_status='deferred',qualification_retry_after='2000-01-01T00:00:00Z'
          WHERE id IN ({legacy_lead_ids});
          UPDATE worker_candidates SET status='deferred',reason_code='groq_budget_exhausted'
          WHERE id IN ({legacy_candidate_ids});
          SELECT (mahshar_worker_advance_run('{legacy_deferred_run_id}',0,10)).processed_count;
          SELECT (mahshar_worker_fail_run('{legacy_deferred_run_id}','legacy_deferred_fixture')).status;
        """)
        legacy_entity_counts = sql("""
          SELECT (SELECT count(*) FROM worker_providers WHERE canonical_domain LIKE 'legacy-%invalid')::text||','||
            (SELECT count(*) FROM worker_products WHERE display_name='Legacy Deferred API')::text||','||
            (SELECT count(*) FROM worker_leads WHERE id IN (""" + legacy_lead_ids + "))::text;")

        # Qualified-target/traction is a forward-only migration layered after
        # the deployed Discovery and review-candidate schemas. Historical run
        # outcomes remain unchanged while new runs receive the 50/300 contract.
        historical_snapshot = sql("SELECT string_agg(id::text||':'||processed_count||':'||qualified_count,',' ORDER BY run_number) FROM worker_runs;")
        rollback_sql = "BEGIN;\n" + QUALIFIED_TARGET.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_qualified_target_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_qualified_target_rollback')
        assert sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='worker_leads' AND column_name='traction_score';") == '0'
        sql('BEGIN;\n' + QUALIFIED_TARGET.read_text() + '\nCOMMIT;')
        assert sql("SELECT qualified_target||','||raw_candidate_limit FROM worker_control WHERE id=1;") == '50,300'
        assert sql("SELECT string_agg(id::text||':'||processed_count||':'||qualified_count,',' ORDER BY run_number) FROM worker_runs;") == historical_snapshot
        assert sql("SELECT count(*) FROM worker_runs WHERE raw_candidate_limit IS NOT NULL OR source_cursor IS NOT NULL;") == '0'

        rollback_sql = "BEGIN;\n" + RETRY_IDEMPOTENCY.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_retry_idempotency_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_retry_idempotency_rollback')
        assert sql("SELECT to_regprocedure('public.mahshar_worker_claim_budget_v2(uuid,text,text)');") == ''
        sql('BEGIN;\n' + RETRY_IDEMPOTENCY.read_text() + '\nCOMMIT;')

        target_functions = [
            'mahshar_worker_create_target_run(boolean)',
            'mahshar_worker_advance_target_run(uuid,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,boolean,boolean,boolean)',
            'mahshar_worker_complete_target_run(uuid)',
            'mahshar_worker_persist_qualification_v2(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,boolean,text)',
            'mahshar_worker_claim_budget_v2(uuid,text,text)',
        ]
        for function in target_functions:
            for role in ['anon', 'authenticated']:
                assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');") == 't'
            assert sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{function}'::regprocedure;") == 'worker_test'
            assert sql(f"SELECT coalesce(array_to_string(proconfig,'|'),'') FROM pg_proc WHERE oid='public.{function}'::regprocedure;") in {'search_path=', 'search_path=""'}
            assert sql(f"""
              SELECT count(*) FROM pg_proc p,
                LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              WHERE p.oid='public.{function}'::regprocedure AND acl.grantee=0;
            """) == '0'

        assert sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.worker_qualified_contributions'::regclass;") == 't'
        for role in ['anon', 'authenticated']:
            for privilege in all_table_privileges:
                assert sql(f"SELECT has_table_privilege('{role}','public.worker_qualified_contributions','{privilege}');") == 'f'
        assert sql("""
          SELECT count(*) FROM pg_class c,
            LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
          WHERE c.oid='public.worker_qualified_contributions'::regclass AND acl.grantee=0;
        """) == '0'
        assert sql("SELECT has_table_privilege('service_role','public.worker_qualified_contributions','SELECT');") == 't'
        for privilege in ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']:
            assert sql(f"SELECT has_table_privilege('service_role','public.worker_qualified_contributions','{privilege}');") == 'f'

        # All four budgets distinguish a new claim, a replay, and genuine
        # exhaustion. Replays remain successful at the cap and never increment.
        budget_run = rpc_json('mahshar_worker_create_target_run(false)')
        budget_id = budget_run['id']
        rpc_json(f"mahshar_worker_claim_run('{budget_id}')")
        for budget in ['source', 'research', 'groq', 'traction']:
            assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','{budget}','{budget}:1');") == 'claimed'
            assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','{budget}','{budget}:1');") == 'replayed'
        assert sql(f"SELECT source_query_count||','||research_fetch_count||','||groq_call_count||','||traction_fetch_count FROM worker_runs WHERE id='{budget_id}';") == '1,1,1,1'

        # Concurrent delivery of one stable key consumes exactly one slot.
        replay_statement = f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','research','research:retry');"
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            replay_results = [future.result() for future in [pool.submit(sql, replay_statement) for _ in range(8)]]
        assert replay_results.count('claimed') == 1 and replay_results.count('replayed') == 7, replay_results
        assert sql(f"SELECT research_fetch_count FROM worker_runs WHERE id='{budget_id}';") == '2'

        caps = {'source': 301, 'research': 240, 'groq': 100, 'traction': 60}
        starts = {'source': 2, 'research': 3, 'groq': 2, 'traction': 2}
        for budget, cap in caps.items():
            claimed = sql(f"""
              SET ROLE service_role;
              SELECT count(*) FROM (
                SELECT mahshar_worker_claim_budget_v2('{budget_id}','{budget}','{budget}:'||g) AS result
                FROM generate_series({starts[budget]},{cap}) g
              ) claims WHERE result='claimed';
            """)
            assert int(claimed) == cap - starts[budget] + 1
            assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','{budget}','{budget}:1');") == 'replayed'
            assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','{budget}','{budget}:new');") == 'exhausted'
            assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{budget_id}','{budget}','{budget}:1');") == 't'
            assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{budget_id}','{budget}','{budget}:legacy-new');") == 'f'
        assert sql(f"SELECT source_query_count||','||research_fetch_count||','||groq_call_count||','||traction_fetch_count FROM worker_runs WHERE id='{budget_id}';") == '301,240,100,60'
        sql(f"UPDATE worker_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id='{budget_id}';")
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','research','research:1');") == 'replayed'
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{budget_id}','research','research:after-deadline');") == 'deadline_reached'
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget('{budget_id}','research','research:after-deadline');") == 'f'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{budget_id}','test_cleanup')).status;")

        # Reproduce production ordinal 16: candidate deferred after a claimed
        # budget, but its already-created lead was still pending. The general
        # deferred state machine must reclaim it without duplicating entities.
        partial_run = rpc_json('mahshar_worker_create_target_run(false)')
        partial_id = partial_run['id']
        rpc_json(f"mahshar_worker_claim_run('{partial_id}')")
        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
            discovered_domain,discovered_product,discovered_docs_url)
          VALUES('{partial_id}',16,'api_directory','https://api.apis.guru/v2/partial-retry.invalid.json',
            'Partial retry','partial-retry.invalid','Partial Retry API','https://api.partial-retry.invalid/openapi.json');
        """)
        partial_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{partial_id}' AND ordinal=16;")
        partial_entity = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_resolve_discovery_lead('{partial_candidate}',NULL,'partial-retry.invalid','partial-v1',
            'Partial retry','partial-retry.invalid','Partial Retry API');
        """))
        sql(f"""
          SET ROLE service_role;
          UPDATE worker_candidates SET status='deferred',reason_code='research_budget_exhausted',updated_at='1900-01-01T00:00:00Z'
          WHERE id='{partial_candidate}';
          SELECT (mahshar_worker_fail_run('{partial_id}','retry_interrupted')).status;
        """)
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{partial_entity['leadId']}';") == 'discovered,pending'
        partial_counts = sql("""
          SELECT (SELECT count(*) FROM worker_providers WHERE canonical_domain='partial-retry.invalid')||','||
            (SELECT count(*) FROM worker_products WHERE normalized_product_key='partial-v1')||','||
            (SELECT count(*) FROM worker_leads WHERE product_id=(SELECT id FROM worker_products WHERE normalized_product_key='partial-v1'));
        """)
        recovery_run = rpc_json('mahshar_worker_create_target_run(false)')
        recovery_id = recovery_run['id']
        rpc_json(f"mahshar_worker_claim_run('{recovery_id}')")
        recovered = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT coalesce(json_agg(json_build_object('id',candidate_id,'lease',lease_id)),'[]')
          FROM mahshar_worker_claim_deferred_candidates('{recovery_id}','partial:recovery',1);
        """))
        recovered_item = next(item for item in recovered if item['id'] == partial_candidate)
        resolved_again = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_resolve_discovery_lead('{partial_candidate}','{recovered_item['lease']}',
            'partial-retry.invalid','partial-v1','Partial retry','partial-retry.invalid','Partial Retry API');
        """))
        assert resolved_again['providerId'] == partial_entity['providerId']
        assert resolved_again['productId'] == partial_entity['productId']
        assert resolved_again['leadId'] == partial_entity['leadId']
        assert sql("""
          SELECT (SELECT count(*) FROM worker_providers WHERE canonical_domain='partial-retry.invalid')||','||
            (SELECT count(*) FROM worker_products WHERE normalized_product_key='partial-v1')||','||
            (SELECT count(*) FROM worker_leads WHERE product_id=(SELECT id FROM worker_products WHERE normalized_product_key='partial-v1'));
        """) == partial_counts
        sql(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{partial_candidate}','{recovered_item['lease']}','filtered','test_cleanup');")
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{recovery_id}','test_cleanup')).status;")
        sql(f"""
          SET ROLE service_role;
          UPDATE worker_control SET desired_state='stopped',
            current_checkpoint=(SELECT checkpoint FROM worker_runs WHERE id='{legacy_deferred_run_id}'),
            checkpoint_run_id='{legacy_deferred_run_id}',updated_at=clock_timestamp() WHERE id=1;
        """)

        legacy_resume = rpc_json('mahshar_worker_create_target_run(true)')
        assert legacy_resume['processed_count'] == 10 and legacy_resume['source_cursor'] == 10
        assert legacy_resume['raw_candidate_limit'] == 50 and legacy_resume['batch_size'] == 50
        assert legacy_resume['discovery_batch_id'] == legacy_deferred_run_id
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{legacy_resume['id']}','test_cleanup')).status;")

        compatibility_run = rpc_json('mahshar_worker_create_target_run(false)')
        compatibility_id = compatibility_run['id']
        rpc_json(f"mahshar_worker_claim_run('{compatibility_id}')")
        claimed_legacy = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT coalesce(json_agg(json_build_object('id',candidate_id,'lease',lease_id) ORDER BY candidate_id),'[]')
          FROM mahshar_worker_claim_deferred_candidates('{compatibility_id}','legacy:post-migration',3);
        """))
        claimed_by_id = {item['id']: item['lease'] for item in claimed_legacy}
        assert set(claimed_by_id) == {candidate_id for candidate_id, _ in legacy_deferred}
        legacy_candidate, legacy_entity = legacy_deferred[0]
        expect_failure(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_persist_qualification_v2('{compatibility_id}','{legacy_candidate}',
            '00000000-0000-4000-8000-000000000001','{legacy_entity['providerId']}','{legacy_entity['productId']}',
            '{legacy_entity['leadId']}',$qualification${qualification_json}$qualification$::jsonb,NULL,'unknown',
            'fixture-model',true,NULL);
        """, 'worker_candidate_lease_mismatch')
        legacy_result = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_persist_qualification_v2('{compatibility_id}','{legacy_candidate}',
            '{claimed_by_id[legacy_candidate]}','{legacy_entity['providerId']}','{legacy_entity['productId']}',
            '{legacy_entity['leadId']}',$qualification${qualification_json}$qualification$::jsonb,NULL,'unknown',
            'fixture-model',true,NULL);
        """))
        assert legacy_result['status'] == 'persisted' and legacy_result['countedQualified']
        dnc_candidate, dnc_entity = legacy_deferred[1]
        sql(f"SET ROLE service_role; INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{dnc_entity['providerId']}',NULL,'do_not_contact','legacy_deferred_block');")
        dnc_after_migration = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_resolve_discovery_lead('{dnc_candidate}','{claimed_by_id[dnc_candidate]}',
            'legacy-dnc.invalid','legacy-v1','legacy-dnc.invalid','legacy-dnc.invalid','Legacy Deferred API');
        """))
        assert dnc_after_migration['action'] == 'blocked' and dnc_after_migration['reasonCode'] == 'provider_do_not_contact'
        sql(f"SET ROLE service_role; SELECT mahshar_worker_complete_candidate('{dnc_candidate}','{claimed_by_id[dnc_candidate]}','blocked','provider_do_not_contact');")
        human_candidate, human_entity = legacy_deferred[2]
        sql(f"SET ROLE service_role; UPDATE worker_leads SET status='reviewed' WHERE id='{human_entity['leadId']}';")
        human_after_migration = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_persist_qualification_v2('{compatibility_id}','{human_candidate}',
            '{claimed_by_id[human_candidate]}','{human_entity['providerId']}','{human_entity['productId']}',
            '{human_entity['leadId']}',$qualification${qualification_json}$qualification$::jsonb,NULL,'unknown',
            'fixture-model',true,NULL);
        """))
        assert human_after_migration['status'] == 'duplicate' and human_after_migration['reasonCode'] == 'existing_human_state'
        assert sql(f"SELECT processed_count||','||source_cursor FROM worker_runs WHERE id='{compatibility_id}';") == '0,0'
        assert sql("""
          SELECT (SELECT count(*) FROM worker_providers WHERE canonical_domain LIKE 'legacy-%invalid')::text||','||
            (SELECT count(*) FROM worker_products WHERE display_name='Legacy Deferred API')::text||','||
            (SELECT count(*) FROM worker_leads WHERE id IN (""" + legacy_lead_ids + "))::text;") == legacy_entity_counts
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{compatibility_id}','test_cleanup')).status;")

        # Exercise the same bounded ordering used by the Admin repository.
        # The oldest lead is excluded by naive recency-first limiting but must
        # be first globally because contactability precedes discovery time.
        sql("""
          INSERT INTO worker_providers(id,canonical_name,canonical_domain)
          SELECT md5('rank-provider-'||g)::uuid,'Rank provider '||g,'rank-'||g||'.invalid'
          FROM generate_series(0,304) g;
          INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
          SELECT md5('rank-product-'||g)::uuid,md5('rank-provider-'||g)::uuid,'rank-api','Rank API '||g
          FROM generate_series(0,304) g;
          INSERT INTO worker_leads(id,provider_id,product_id,status,qualification_status,fit_score,fit_reason,
            traction_score,traction_level,traction_confidence,contactability_status,created_at)
          SELECT md5('rank-lead-'||g)::uuid,md5('rank-provider-'||g)::uuid,md5('rank-product-'||g)::uuid,
            'qualified','qualified',100,'Ranking fixture',100,'high','high',
            CASE WHEN g=0 THEN 'verified_official_contact' ELSE 'unknown' END,
            '2020-01-01T00:00:00Z'::timestamptz+(g||' seconds')::interval
          FROM generate_series(0,304) g;
        """)
        ranking_where = """status IN ('qualified','reviewed','contact_ready','contacted','replied','interested','listed')
          OR (status='discovered' AND qualification_status='review_candidate')"""
        ranking_order = """qualification_rank ASC,fit_score DESC NULLS LAST,traction_score DESC NULLS LAST,
          traction_confidence_rank ASC,contactability_rank ASC,created_at DESC,id DESC"""
        special_rank_id = sql("SELECT md5('rank-lead-0')::uuid;")
        assert sql(f"""SELECT count(*) FROM (
          SELECT id FROM worker_leads WHERE {ranking_where} ORDER BY created_at DESC,id DESC LIMIT 300
        ) naive WHERE id='{special_rank_id}';""") == '0'
        assert sql(f"""SELECT count(*) FROM (
          SELECT id FROM worker_leads WHERE {ranking_where} ORDER BY {ranking_order} LIMIT 300
        ) ranked;""") == '300'
        assert sql(f"""SELECT id FROM worker_leads WHERE {ranking_where}
          ORDER BY {ranking_order} LIMIT 1;""") == special_rank_id
        assert sql(f"""SELECT count(*) FROM (
          SELECT id FROM worker_leads WHERE {ranking_where} ORDER BY {ranking_order} LIMIT 300
        ) ranked WHERE id=md5('rank-lead-5')::uuid;""") == '0'
        assert sql(f"""SELECT count(*) FROM (
          SELECT id FROM worker_leads WHERE {ranking_where} ORDER BY {ranking_order} LIMIT 300
        ) ranked WHERE id=md5('rank-lead-6')::uuid;""") == '1'

        target_run = rpc_json('mahshar_worker_create_target_run(false)')
        target_id = target_run['id']
        assert target_run['batch_size'] == 300 and target_run['raw_candidate_limit'] == 300
        assert target_run['qualified_target'] == 50 and target_run['processed_count'] == 0 and target_run['source_cursor'] == 0
        rpc_json(f"mahshar_worker_claim_run('{target_id}')")
        expect_failure(f"SET ROLE service_role; UPDATE worker_runs SET qualified_count=51 WHERE id='{target_id}';")
        assert sql(f"SELECT qualified_count FROM worker_runs WHERE id='{target_id}';") == '0'

        def seed_target_candidates(run_id, prefix, count=52):
            sql(f"""
              INSERT INTO worker_providers(id,canonical_name,canonical_domain)
              SELECT md5('{prefix}-provider-'||g)::uuid,'Target provider '||g,'{prefix}-'||g||'.invalid'
              FROM generate_series(0,{count - 1}) g;
              INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
              SELECT md5('{prefix}-product-'||g)::uuid,md5('{prefix}-provider-'||g)::uuid,'target-api','Target API'
              FROM generate_series(0,{count - 1}) g;
              INSERT INTO worker_leads(id,provider_id,product_id,status)
              SELECT md5('{prefix}-lead-'||g)::uuid,md5('{prefix}-provider-'||g)::uuid,md5('{prefix}-product-'||g)::uuid,'discovered'
              FROM generate_series(0,{count - 1}) g;
              INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
                discovered_domain,discovered_product,discovered_docs_url,provider_id,product_id,lead_id)
              SELECT '{run_id}',g,'api_directory','https://api.apis.guru/v2/{prefix}-'||g||'.invalid.json',
                'Target provider '||g,'{prefix}-'||g||'.invalid','Target API','https://api.{prefix}-'||g||'.invalid/openapi.json',
                md5('{prefix}-provider-'||g)::uuid,md5('{prefix}-product-'||g)::uuid,md5('{prefix}-lead-'||g)::uuid
              FROM generate_series(0,{count - 1}) g;
            """)

        def target_candidate_call(run_id, ordinal, payload=qualification_json, traction='NULL', contact='unknown'):
            return f"""
              SET ROLE service_role;
              SELECT mahshar_worker_persist_qualification_v2('{run_id}',candidate.id,NULL,candidate.provider_id,
                candidate.product_id,candidate.lead_id,$qualification${payload}$qualification$::jsonb,{traction},
                '{contact}','fixture-model',true,NULL)
              FROM worker_candidates candidate WHERE candidate.discovery_batch_id='{run_id}' AND candidate.ordinal={ordinal};
            """

        seed_target_candidates(target_id, 'target-one')
        sql(f"""
          INSERT INTO worker_qualified_contributions(discovery_batch_id,lead_id,candidate_id)
          SELECT '{target_id}',lead_id,id FROM worker_candidates WHERE discovery_batch_id='{target_id}' AND ordinal<49;
          UPDATE worker_runs SET qualified_count=49 WHERE id='{target_id}';
        """)
        final_result = json.loads(sql(target_candidate_call(target_id, 49)))
        assert final_result['countedQualified'] and final_result['targetReached']
        assert sql(f"SELECT qualified_count FROM worker_runs WHERE id='{target_id}';") == '50'
        assert sql(f"SELECT completion_reason FROM worker_runs WHERE id='{target_id}';") == 'qualified_target_reached'
        replay_result = json.loads(sql(target_candidate_call(target_id, 49)))
        overflow_result = json.loads(sql(target_candidate_call(target_id, 50)))
        assert not replay_result['countedQualified'] and not overflow_result['countedQualified']
        assert sql(f"SELECT qualified_count FROM worker_runs WHERE id='{target_id}';") == '50'
        expect_failure(
            f"SET ROLE service_role; SELECT (mahshar_worker_advance_target_run('{target_id}',0,0,0,0,0,0,1,0,0,0,false,false,false)).id;",
            'worker_qualified_counter_managed',
        )
        target_run = rpc_json(
            f"mahshar_worker_advance_target_run('{target_id}',0,0,0,0,0,0,0,0,0,0,false,false,false)"
        )
        assert target_run['status'] == 'completed' and target_run['qualified_count'] == 50
        assert target_run['completion_reason'] == 'qualified_target_reached'

        concurrent_run = rpc_json('mahshar_worker_create_target_run(false)')
        concurrent_id = concurrent_run['id']
        rpc_json(f"mahshar_worker_claim_run('{concurrent_id}')")
        seed_target_candidates(concurrent_id, 'target-race')
        sql(f"""
          INSERT INTO worker_qualified_contributions(discovery_batch_id,lead_id,candidate_id)
          SELECT '{concurrent_id}',lead_id,id FROM worker_candidates WHERE discovery_batch_id='{concurrent_id}' AND ordinal<49;
          UPDATE worker_runs SET qualified_count=49 WHERE id='{concurrent_id}';
        """)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            race_results = [json.loads(future.result()) for future in [
                pool.submit(sql, target_candidate_call(concurrent_id, ordinal)) for ordinal in [49, 50]
            ]]
        assert sum(1 for value in race_results if value['countedQualified']) == 1
        assert sql(f"SELECT qualified_count FROM worker_runs WHERE id='{concurrent_id}';") == '50'
        concurrent_done = rpc_json(
            f"mahshar_worker_advance_target_run('{concurrent_id}',0,0,0,0,0,0,0,0,0,0,false,false,false)"
        )
        assert concurrent_done['completion_reason'] == 'qualified_target_reached'

        duplicate_run = rpc_json('mahshar_worker_create_target_run(false)')
        duplicate_id = duplicate_run['id']
        rpc_json(f"mahshar_worker_claim_run('{duplicate_id}')")
        seed_target_candidates(duplicate_id, 'target-duplicate', 3)
        sql(f"""
          INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
            discovered_domain,discovered_product,discovered_docs_url,provider_id,product_id,lead_id)
          SELECT discovery_batch_id,3,source_type,source_url,discovered_name,discovered_domain,discovered_product,
            discovered_docs_url,provider_id,product_id,lead_id FROM worker_candidates
          WHERE discovery_batch_id='{duplicate_id}' AND ordinal=0;
        """)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            duplicate_results = [json.loads(future.result()) for future in [
                pool.submit(sql, target_candidate_call(duplicate_id, ordinal)) for ordinal in [0, 3]
            ]]
        assert sum(1 for value in duplicate_results if value['countedQualified']) == 1
        assert sql(f"SELECT qualified_count FROM worker_runs WHERE id='{duplicate_id}';") == '1'
        assert sql(f"SELECT count(*) FROM worker_qualified_contributions WHERE discovery_batch_id='{duplicate_id}';") == '1'
        duplicate_replay = json.loads(sql(target_candidate_call(duplicate_id, 0)))
        assert not duplicate_replay['countedQualified']
        assert sql(f"SELECT qualified_count FROM worker_runs WHERE id='{duplicate_id}';") == '1'

        traction_json = json.dumps({
            'tractionScore': 75, 'tractionLevel': 'high', 'tractionConfidence': 'medium',
            'lastActivityAt': '2026-10-01T00:00:00.000Z',
            'signals': ['official_docs_active', 'directory_update_recent'],
            'concerns': [], 'summary': 'High bounded activity evidence; this is not usage volume.',
        })
        traction_review_json = json.dumps({**json.loads(qualification_json), 'fitScore': 65})
        traction_result = json.loads(sql(target_candidate_call(
            duplicate_id, 1, traction_review_json, f'$traction${traction_json}$traction$::jsonb', 'verified_official_contact',
        )))
        assert traction_result['status'] == 'persisted'
        malformed_traction = json.dumps({**json.loads(traction_json), 'signals': [{'invented': 'signal'}]})
        fresh_traction_candidate = 2
        expect_failure(target_candidate_call(
            duplicate_id, fresh_traction_candidate, traction_review_json,
            f'$traction${malformed_traction}$traction$::jsonb', 'unknown',
        ), 'worker_traction_invalid')

        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{duplicate_id}','test_cleanup')).status;")
        review_target = rpc_json('mahshar_worker_create_target_run(false)')
        review_target_id = review_target['id']
        rpc_json(f"mahshar_worker_claim_run('{review_target_id}')")
        # Fifty raw scans with only review candidates are not a success target.
        for expected in [0, 10, 20, 30, 40]:
            review_target = rpc_json(
                f"mahshar_worker_advance_target_run('{review_target_id}',{expected},{expected + 10},10,0,0,0,0,10,10,10,false,false,false)"
            )
        assert review_target['processed_count'] == 50 and review_target['qualified_count'] == 0
        assert review_target['review_candidate_count'] == 50 and review_target['status'] == 'running'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{review_target_id}','test_cleanup')).status;")

        exhausted = rpc_json('mahshar_worker_create_target_run(false)')
        exhausted_id = exhausted['id']
        rpc_json(f"mahshar_worker_claim_run('{exhausted_id}')")
        exhausted = rpc_json(
            f"mahshar_worker_advance_target_run('{exhausted_id}',0,3,3,0,3,0,0,0,0,0,true,false,false)"
        )
        assert exhausted['status'] == 'completed' and exhausted['completion_reason'] == 'source_exhausted'

        deadline = rpc_json('mahshar_worker_create_target_run(false)')
        deadline_id = deadline['id']
        rpc_json(f"mahshar_worker_claim_run('{deadline_id}')")
        deadline = rpc_json(
            f"mahshar_worker_advance_target_run('{deadline_id}',0,0,0,0,0,0,0,0,0,0,false,true,false)"
        )
        assert deadline['status'] == 'completed' and deadline['completion_reason'] == 'deadline_reached'

        raw_cap = rpc_json('mahshar_worker_create_target_run(false)')
        raw_cap_id = raw_cap['id']
        rpc_json(f"mahshar_worker_claim_run('{raw_cap_id}')")
        for expected in range(0, 300, 10):
            raw_cap = rpc_json(
                f"mahshar_worker_advance_target_run('{raw_cap_id}',{expected},{expected + 10},10,0,10,0,0,0,0,0,false,false,false)"
            )
        assert raw_cap['status'] == 'completed' and raw_cap['processed_count'] == 300
        assert raw_cap['completion_reason'] == 'hard_limit_reached' and raw_cap['qualified_count'] == 0

        resumable_target = rpc_json('mahshar_worker_create_target_run(false)')
        resumable_target_id = resumable_target['id']
        rpc_json(f"mahshar_worker_claim_run('{resumable_target_id}')")
        seed_target_candidates(resumable_target_id, 'target-resume', 2)
        sql(f"""
          INSERT INTO worker_qualified_contributions(discovery_batch_id,lead_id,candidate_id)
          SELECT '{resumable_target_id}',lead_id,id FROM worker_candidates WHERE discovery_batch_id='{resumable_target_id}';
          UPDATE worker_runs SET qualified_count=2 WHERE id='{resumable_target_id}';
        """)
        rpc_json(f"mahshar_worker_advance_target_run('{resumable_target_id}',0,10,10,0,0,0,0,3,5,5,false,false,false)")
        rpc_json('mahshar_worker_request_stop()')
        stopped_target = rpc_json(f"mahshar_worker_advance_target_run('{resumable_target_id}',10,20,0,0,0,0,0,0,0,0,false,false,false)")
        resumed_target = rpc_json('mahshar_worker_create_target_run(true)')
        assert stopped_target['status'] == 'stopped'
        assert resumed_target['processed_count'] == 10 and resumed_target['qualified_count'] == 2
        assert resumed_target['review_candidate_count'] == 3 and resumed_target['persisted_count'] == 5
        assert resumed_target['discovery_batch_id'] == resumable_target['discovery_batch_id']
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{resumed_target['id']}','test_cleanup')).status;")

        # Contact Discovery is forward-only and does not rewrite the existing
        # technical evaluations, run counters, or qualified contributions.
        contact_history = sql("""
          SELECT (SELECT count(*) FROM worker_runs)||','||(SELECT count(*) FROM worker_leads)||','||
            (SELECT count(*) FROM worker_qualified_contributions)||','||
            coalesce((SELECT sum(qualified_count) FROM worker_runs),0);
        """)
        rollback_sql = "BEGIN;\n" + CONTACT_DISCOVERY.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_contact_discovery_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_contact_discovery_rollback')
        assert sql("SELECT to_regclass('public.worker_contacts');") == ''
        sql('BEGIN;\n' + CONTACT_DISCOVERY.read_text() + '\nCOMMIT;')
        assert sql("""
          SELECT (SELECT count(*) FROM worker_runs)||','||(SELECT count(*) FROM worker_leads)||','||
            (SELECT count(*) FROM worker_qualified_contributions)||','||
            coalesce((SELECT sum(qualified_count) FROM worker_runs),0);
        """) == contact_history

        for table in ['worker_contacts', 'worker_contact_enrichment_claims']:
            assert sql(f"SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass;") == 't'
            assert sql(f"SELECT count(*) FROM pg_policy WHERE polrelid='public.{table}'::regclass;") == '0'
            for role in ['anon', 'authenticated']:
                for privilege in all_table_privileges:
                    assert sql(f"SELECT has_table_privilege('{role}','public.{table}','{privilege}');") == 'f'
            assert sql(f"SELECT has_table_privilege('service_role','public.{table}','SELECT');") == 't'
            for privilege in ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']:
                assert sql(f"SELECT has_table_privilege('service_role','public.{table}','{privilege}');") == 'f'
        for function in [
            'mahshar_worker_save_contact_research(uuid,uuid,uuid,text,boolean,text,text,boolean,jsonb)',
            'mahshar_worker_claim_contact_enrichment(uuid,text,integer)',
            'mahshar_worker_apply_contact_actionability(uuid,uuid,uuid,uuid)',
        ]:
            assert sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{function}'::regprocedure;") == 'worker_test'
            for role in ['anon', 'authenticated']:
                assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');") == 't'
            assert sql(f"SELECT coalesce(array_to_string(proconfig,'|'),'') FROM pg_proc WHERE oid='public.{function}'::regprocedure;") in {'search_path=', 'search_path=""'}

        contact_run = rpc_json('mahshar_worker_create_target_run(false)')
        contact_run_id = contact_run['id']
        rpc_json(f"mahshar_worker_claim_run('{contact_run_id}')")
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{contact_run_id}','contact','contact:one');") == 'claimed'
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{contact_run_id}','contact','contact:one');") == 'replayed'
        assert sql(f"SELECT contact_fetch_count FROM worker_runs WHERE id='{contact_run_id}';") == '1'
        sql(f"""
          SET ROLE service_role;
          INSERT INTO worker_budget_claims(discovery_batch_id,budget_type,claim_key)
          SELECT '{contact_run_id}','contact','contact:cap:'||g FROM generate_series(2,120) g;
          UPDATE worker_runs SET contact_fetch_count=120 WHERE id='{contact_run_id}';
        """)
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{contact_run_id}','contact','contact:one');") == 'replayed'
        assert sql(f"SET ROLE service_role; SELECT mahshar_worker_claim_budget_v2('{contact_run_id}','contact','contact:new');") == 'exhausted'

        seed_target_candidates(contact_run_id, 'contact-gate', 5)
        before_gate_count = int(sql(f"SELECT qualified_count FROM worker_runs WHERE id='{contact_run_id}';"))
        no_contact = json.loads(sql(target_candidate_call(contact_run_id, 0)))
        assert no_contact['reasonCode'] == 'qualified_contact_pending' and not no_contact['countedQualified']
        no_contact_lead = sql(f"SELECT lead_id FROM worker_candidates WHERE discovery_batch_id='{contact_run_id}' AND ordinal=0;")
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{no_contact_lead}';") == 'discovered,qualified'
        assert int(sql(f"SELECT qualified_count FROM worker_runs WHERE id='{contact_run_id}';")) == before_gate_count

        def save_fixture_contact(ordinal, prefix='api'):
            contact_row = sql(f"""SELECT candidate.provider_id||','||candidate.lead_id||','||provider.canonical_domain
              FROM worker_candidates candidate JOIN worker_providers provider ON provider.id=candidate.provider_id
              WHERE candidate.discovery_batch_id='{contact_run_id}' AND candidate.ordinal={ordinal};""").split(',')
            provider_id, lead_id, domain = contact_row
            email = f'{prefix}@{domain}'
            url = f'https://{domain}/contact'
            payload = json.dumps([{
                'type': 'email', 'value': email, 'purpose': 'api', 'sourceUrl': url,
                'sourceType': 'official_site', 'verificationStatus': 'verified', 'preferred': True,
                'emailReady': True, 'discoveredAt': '2026-10-05T00:00:00Z', 'verifiedAt': '2026-10-05T00:00:00Z',
            }])
            saved = sql(f"""SET ROLE service_role;
              SELECT mahshar_worker_save_contact_research('{contact_run_id}','{provider_id}','{lead_id}',
                'verified_email',true,'{email}','{url}',true,$evidence${payload}$evidence$::jsonb);""")
            return saved, provider_id, lead_id

        # Human/provider state changed after contact research must still win at
        # the final actionability boundary.
        saved, race_provider, race_lead = save_fixture_contact(0, 'race')
        assert saved == 'saved'
        race_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{contact_run_id}' AND ordinal=0;")
        sql(f"SET ROLE service_role; UPDATE worker_providers SET status='do_not_contact' WHERE id='{race_provider}';")
        race_actionability = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_apply_contact_actionability('{contact_run_id}','{race_candidate}',
            '{race_provider}','{race_lead}');
        """))
        assert race_actionability['blocked'] and not race_actionability['countedQualified']
        assert int(sql(f"SELECT qualified_count FROM worker_runs WHERE id='{contact_run_id}';")) == before_gate_count

        saved, _, actionable_lead = save_fixture_contact(1)
        assert saved == 'saved'
        with_contact = json.loads(sql(target_candidate_call(contact_run_id, 1)))
        assert with_contact['reasonCode'] == 'qualified' and with_contact['countedQualified']
        assert int(sql(f"SELECT qualified_count FROM worker_runs WHERE id='{contact_run_id}';")) == before_gate_count + 1

        # A decision-only human DNC committed concurrently with final contact
        # actionability must win even when it does not update an entity row.
        decision_race_pending = json.loads(sql(target_candidate_call(contact_run_id, 4)))
        assert decision_race_pending['reasonCode'] == 'qualified_contact_pending' and not decision_race_pending['countedQualified']
        saved, decision_race_provider, decision_race_lead = save_fixture_contact(4, 'decision-race')
        assert saved == 'saved'
        decision_race_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{contact_run_id}' AND ordinal=4;")
        before_decision_race = int(sql(f"SELECT qualified_count FROM worker_runs WHERE id='{contact_run_id}';"))
        decision_only_dnc = f"""BEGIN;
          INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code)
            VALUES('{decision_race_provider}','{decision_race_lead}','do_not_contact','concurrent_contact_block');
          SELECT pg_sleep(1) /* race_contact_decision_only */;
          COMMIT;"""
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            admin_future = pool.submit(sql, decision_only_dnc)
            wait_for_marker('race_contact_decision_only')
            actionability_future = pool.submit(sql, f"""SET ROLE service_role;
              SELECT mahshar_worker_apply_contact_actionability('{contact_run_id}','{decision_race_candidate}',
                '{decision_race_provider}','{decision_race_lead}');""")
            decision_race_result = json.loads(actionability_future.result())
            admin_future.result()
        assert decision_race_result['blocked'] and not decision_race_result['countedQualified']
        assert int(sql(f"SELECT qualified_count FROM worker_runs WHERE id='{contact_run_id}';")) == before_decision_race
        assert sql(f"SELECT count(*) FROM worker_qualified_contributions WHERE lead_id='{decision_race_lead}';") == '0'
        assert sql(f"SELECT status FROM worker_leads WHERE id='{decision_race_lead}';") == 'discovered'
        assert sql(f"SELECT count(*) FROM worker_decisions WHERE lead_id='{decision_race_lead}' AND decision='do_not_contact';") == '1'

        saved, _, review_lead = save_fixture_contact(2)
        assert saved == 'saved'
        review_contact = json.loads(sql(target_candidate_call(contact_run_id, 2, traction_review_json)))
        assert review_contact['reasonCode'] == 'review_candidate' and not review_contact['countedQualified']
        assert sql(f"SELECT status||','||qualification_status FROM worker_leads WHERE id='{review_lead}';") == 'discovered,review_candidate'
        review_candidate = sql(f"SELECT id FROM worker_candidates WHERE discovery_batch_id='{contact_run_id}' AND ordinal=2;")
        review_product = sql(f"SELECT product_id FROM worker_leads WHERE id='{review_lead}';")
        sql(f"SET ROLE service_role; UPDATE worker_products SET status='rejected' WHERE id='{review_product}';")
        product_race = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_apply_contact_actionability('{contact_run_id}','{review_candidate}',
            (SELECT provider_id FROM worker_leads WHERE id='{review_lead}'),'{review_lead}');
        """))
        assert product_race['blocked'] and not product_race['countedQualified']

        dnc_provider = sql(f"SELECT provider_id FROM worker_candidates WHERE discovery_batch_id='{contact_run_id}' AND ordinal=3;")
        sql(f"SET ROLE service_role; INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code) VALUES('{dnc_provider}',NULL,'do_not_contact','contact_fixture');")
        saved, _, dnc_lead = save_fixture_contact(3)
        assert saved == 'blocked'
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{dnc_lead}';") == '0'

        # Reuse a historical technically-qualified, unknown-contact lead. It
        # is enrichable without raw discovery or another qualification call.
        enrich_claim = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT coalesce(json_agg(candidate_id),'[]') FROM
            mahshar_worker_claim_contact_enrichment('{contact_run_id}','contact-enrichment:{contact_run_id}',5);
        """))
        assert enrich_claim
        enrich_candidate = enrich_claim[0]
        enrich_row = sql(f"""SELECT candidate.provider_id||','||candidate.lead_id||','||provider.canonical_domain
          FROM worker_candidates candidate JOIN worker_providers provider ON provider.id=candidate.provider_id
          WHERE candidate.id='{enrich_candidate}';""").split(',')
        enrich_provider, enrich_lead, enrich_domain = enrich_row
        enrich_email = f'api@{enrich_domain}'
        enrich_url = f'https://{enrich_domain}/contact'
        evidence = json.dumps([{
            'type': 'email', 'value': enrich_email, 'purpose': 'api',
            'sourceUrl': enrich_url, 'sourceType': 'official_site',
            'verificationStatus': 'verified', 'preferred': True, 'emailReady': True,
            'discoveredAt': '2026-10-05T00:00:00Z', 'verifiedAt': '2026-10-05T00:00:00Z',
        }])
        assert sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_save_contact_research('{contact_run_id}','{enrich_provider}','{enrich_lead}',
            'verified_email',true,'{enrich_email}','{enrich_url}',true,
            $evidence${evidence}$evidence$::jsonb);
        """) == 'saved'
        # Replaying evidence upserts the same logical contact instead of duplicating it.
        assert sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_save_contact_research('{contact_run_id}','{enrich_provider}','{enrich_lead}',
            'verified_email',true,'{enrich_email}','{enrich_url}',true,
            $evidence${evidence}$evidence$::jsonb);
        """) == 'saved'
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{enrich_lead}';") == '1'
        sibling_product = sql("SELECT gen_random_uuid();")
        sibling_lead = sql("SELECT gen_random_uuid();")
        sql(f"""SET ROLE service_role;
          INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
            VALUES('{sibling_product}','{enrich_provider}','contact-sibling','Contact sibling API');
          INSERT INTO worker_leads(id,provider_id,product_id,status)
            VALUES('{sibling_lead}','{enrich_provider}','{sibling_product}','discovered');
          SELECT mahshar_worker_save_contact_research('{contact_run_id}','{enrich_provider}','{sibling_lead}',
            'verified_email',true,'{enrich_email}','{enrich_url}',true,$evidence${evidence}$evidence$::jsonb);
        """)
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE provider_id='{enrich_provider}';") == '1'
        assert sql(f"SELECT contactability_status FROM worker_leads WHERE id='{sibling_lead}';") == 'verified_email'
        actionability = json.loads(sql(f"""
          SET ROLE service_role;
          SELECT mahshar_worker_apply_contact_actionability('{contact_run_id}','{enrich_candidate}',
            '{enrich_provider}','{enrich_lead}');
        """))
        assert not actionability['blocked']
        assert sql(f"SELECT email_ready::text||','||contactability_status FROM worker_leads WHERE id='{enrich_lead}';") == 'true,verified_email'
        sql(f"SET ROLE service_role; SELECT (mahshar_worker_fail_run('{contact_run_id}','test_cleanup')).status;")

        # Controlled contact maintenance is independently transactional and
        # never requires or mutates a Worker run.
        rollback_sql = "BEGIN;\n" + CONTACT_REENRICHMENT.read_text() + """
          DO $rollback$ BEGIN RAISE EXCEPTION 'forced_worker_contact_reenrichment_rollback'; END $rollback$;
          COMMIT;
        """
        expect_failure(rollback_sql, 'forced_worker_contact_reenrichment_rollback')
        assert sql("SELECT to_regprocedure('public.mahshar_worker_maintain_contact_research(uuid,uuid,boolean,jsonb)');") == ''
        assert sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='worker_contacts' AND column_name='evidence_origin';") == '0'
        sql('BEGIN;\n' + CONTACT_REENRICHMENT.read_text() + '\nCOMMIT;')

        maintenance_function = 'mahshar_worker_maintain_contact_research(uuid,uuid,boolean,jsonb)'
        assert sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{maintenance_function}'::regprocedure;") == 'worker_test'
        assert sql(f"SELECT coalesce(array_to_string(proconfig,'|'),'') FROM pg_proc WHERE oid='public.{maintenance_function}'::regprocedure;") in {'search_path=', 'search_path=""'}
        for role in ['anon', 'authenticated']:
            assert sql(f"SELECT has_function_privilege('{role}','public.{maintenance_function}','EXECUTE');") == 'f'
        assert sql(f"SELECT has_function_privilege('service_role','public.{maintenance_function}','EXECUTE');") == 't'
        for privilege in ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']:
            assert sql(f"SELECT has_table_privilege('service_role','public.worker_contacts','{privilege}');") == 'f'

        maintenance_provider = sql('SELECT gen_random_uuid();')
        maintenance_product = sql('SELECT gen_random_uuid();')
        maintenance_lead = sql('SELECT gen_random_uuid();')
        sql(f"""
          INSERT INTO worker_providers(id,canonical_name,canonical_domain)
            VALUES('{maintenance_provider}','Maintenance Fixture','maintenance.example');
          INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
            VALUES('{maintenance_product}','{maintenance_provider}','maintenance-api','Maintenance API');
          INSERT INTO worker_leads(id,provider_id,product_id,status,fit_score,qualification_status,
            contactability_status,email_ready,preferred_email,preferred_contact_url,contact_researched_at)
          VALUES('{maintenance_lead}','{maintenance_provider}','{maintenance_product}','qualified',78,'qualified',
            'verified_email',true,'//www.tiktok.com/@maintenance','https://maintenance.example/',clock_timestamp());
          INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
            verification_status,preferred,email_ready,discovered_at,verified_at,evidence_origin)
          VALUES
            ('{maintenance_provider}','{maintenance_lead}','email','//www.tiktok.com/@maintenance','general',
              'https://maintenance.example/','official_site','verified',true,true,clock_timestamp(),clock_timestamp(),'automatic'),
            ('{maintenance_provider}','{maintenance_lead}','official_contact','https://directory.example/vendor','business',
              'https://maintenance.example/','official_site','verified',false,false,clock_timestamp(),clock_timestamp(),'automatic'),
            ('{maintenance_provider}','{maintenance_lead}','official_contact','https://maintenance.example/api-product','api',
              'https://maintenance.example/api-product','official_site','verified',false,false,clock_timestamp(),clock_timestamp(),'automatic'),
            ('{maintenance_provider}','{maintenance_lead}','email','support@maintenance.example','support',
              'https://maintenance.example/support','official_site','verified',false,true,clock_timestamp(),clock_timestamp(),'automatic'),
            ('{maintenance_provider}','{maintenance_lead}','email','security@maintenance.example','security',
              'https://maintenance.example/security','official_site','verified',false,true,clock_timestamp(),clock_timestamp(),'automatic'),
            ('{maintenance_provider}','{maintenance_lead}','official_contact','https://maintenance.example/manual-contact','contact',
              'https://maintenance.example/manual-contact','official_site','verified',false,false,clock_timestamp(),clock_timestamp(),'manual');
        """)
        assert sql("SELECT count(*) FROM worker_runs WHERE status IN ('queued','running','stop_requested');") == '0'
        historical_runs = sql("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM worker_runs r;")
        historical_contributions = sql("SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY discovery_batch_id,lead_id),'[]') FROM worker_qualified_contributions c;")
        technical_state = sql(f"SELECT fit_score||','||qualification_status FROM worker_leads WHERE id='{maintenance_lead}';")
        rediscovered_contact_id = sql(f"SELECT id FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND value='support@maintenance.example';")

        maintenance_evidence = json.dumps([
            {
                'type': 'email', 'value': 'support@maintenance.example', 'purpose': 'support',
                'sourceUrl': 'https://maintenance.example/support', 'sourceType': 'official_site',
                'verificationStatus': 'verified', 'preferred': False, 'emailReady': True,
                'discoveredAt': '2026-10-07T12:00:00Z', 'verifiedAt': '2026-10-07T12:00:00Z',
            },
            {
                'type': 'email', 'value': 'security@maintenance.example', 'purpose': 'security',
                'sourceUrl': 'https://maintenance.example/security', 'sourceType': 'official_site',
                'verificationStatus': 'verified', 'preferred': True, 'emailReady': True,
                'discoveredAt': '2026-10-07T12:00:00Z', 'verifiedAt': '2026-10-07T12:00:00Z',
            },
            {
                'type': 'official_contact', 'value': 'https://maintenance.example/contact', 'purpose': 'contact',
                'sourceUrl': 'https://maintenance.example/contact', 'sourceType': 'official_site',
                'verificationStatus': 'verified', 'preferred': False, 'emailReady': False,
                'discoveredAt': '2026-10-07T12:00:00Z', 'verifiedAt': '2026-10-07T12:00:00Z',
            },
        ])

        maintenance_call = f"""mahshar_worker_maintain_contact_research(
          '{maintenance_provider}','{maintenance_lead}',true,$evidence${maintenance_evidence}$evidence$::jsonb)"""
        maintained = json.loads(sql(f"SET ROLE service_role; SELECT {maintenance_call};"))
        assert maintained == {
            'result': 'saved', 'contactStatus': 'verified_email', 'emailReady': True,
            'preferredEmail': 'support@maintenance.example',
            'preferredContactUrl': 'https://maintenance.example/support', 'actionable': True,
        }
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND value IN ('//www.tiktok.com/@maintenance','https://directory.example/vendor','https://maintenance.example/api-product');") == '0'
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND value='support@maintenance.example';") == '1'
        assert sql(f"SELECT id FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND value='support@maintenance.example';") == rediscovered_contact_id
        assert sql(f"SELECT email_ready::text||','||preferred::text FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND value='security@maintenance.example';") == 'false,false'
        assert sql(f"SELECT evidence_origin||','||preferred::text FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND value='https://maintenance.example/manual-contact';") == 'manual,false'
        assert sql(f"SELECT status||','||contactability_status||','||email_ready::text||','||preferred_email FROM worker_leads WHERE id='{maintenance_lead}';") == 'qualified,verified_email,true,support@maintenance.example'
        assert sql(f"SELECT fit_score||','||qualification_status FROM worker_leads WHERE id='{maintenance_lead}';") == technical_state

        contact_snapshot = sql(f"""SELECT jsonb_agg(jsonb_build_object('id',id,'type',contact_type,'value',value,'purpose',purpose,
          'preferred',preferred,'emailReady',email_ready,'origin',evidence_origin) ORDER BY contact_type,value)
          FROM worker_contacts WHERE lead_id='{maintenance_lead}';""")
        assert json.loads(sql(f"SET ROLE service_role; SELECT {maintenance_call};")) == maintained
        assert sql(f"""SELECT jsonb_agg(jsonb_build_object('id',id,'type',contact_type,'value',value,'purpose',purpose,
          'preferred',preferred,'emailReady',email_ready,'origin',evidence_origin) ORDER BY contact_type,value)
          FROM worker_contacts WHERE lead_id='{maintenance_lead}';""") == contact_snapshot

        unavailable = json.loads(sql(f"""SET ROLE service_role;
          SELECT mahshar_worker_maintain_contact_research(
            '{maintenance_provider}','{maintenance_lead}',true,'[]'::jsonb);"""))
        assert unavailable == {
            'result': 'saved', 'contactStatus': 'contact_unavailable', 'emailReady': False,
            'preferredEmail': None, 'preferredContactUrl': None, 'actionable': False,
        }
        assert sql(f"SELECT status||','||qualification_status||','||fit_score FROM worker_leads WHERE id='{maintenance_lead}';") == 'discovered,qualified,78.00'
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND evidence_origin='automatic';") == '0'
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{maintenance_lead}' AND evidence_origin='manual';") == '1'

        retryable = json.loads(sql(f"""SET ROLE service_role;
          SELECT mahshar_worker_maintain_contact_research(
            '{maintenance_provider}','{maintenance_lead}',false,'[]'::jsonb);"""))
        assert retryable == {
            'result': 'saved', 'contactStatus': 'unknown', 'emailReady': False,
            'preferredEmail': None, 'preferredContactUrl': None, 'actionable': False,
        }
        assert sql(f"SELECT contact_researched_at IS NULL FROM worker_leads WHERE id='{maintenance_lead}';") == 't'
        assert sql(f"SELECT fit_score||','||qualification_status FROM worker_leads WHERE id='{maintenance_lead}';") == technical_state

        sql(f"UPDATE worker_contacts SET preferred=true WHERE lead_id='{maintenance_lead}' AND evidence_origin='manual';")
        manual_result = json.loads(sql(f"""SET ROLE service_role;
          SELECT mahshar_worker_maintain_contact_research(
            '{maintenance_provider}','{maintenance_lead}',true,'[]'::jsonb);"""))
        assert manual_result == {
            'result': 'saved', 'contactStatus': 'official_contact_page', 'emailReady': False,
            'preferredEmail': None,
            'preferredContactUrl': 'https://maintenance.example/manual-contact', 'actionable': True,
        }
        assert sql(f"SELECT evidence_origin||','||preferred::text FROM worker_contacts WHERE lead_id='{maintenance_lead}';") == 'manual,true'
        assert sql(f"SELECT status||','||qualification_status||','||fit_score FROM worker_leads WHERE id='{maintenance_lead}';") == 'qualified,qualified,78.00'

        blocked_provider = sql('SELECT gen_random_uuid();')
        blocked_product = sql('SELECT gen_random_uuid();')
        blocked_lead = sql('SELECT gen_random_uuid();')
        sql(f"""
          INSERT INTO worker_providers(id,canonical_name,canonical_domain)
            VALUES('{blocked_provider}','Blocked Fixture','blocked-maintenance.example');
          INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
            VALUES('{blocked_product}','{blocked_provider}','blocked-api','Blocked API');
          INSERT INTO worker_leads(id,provider_id,product_id,status,fit_score,qualification_status,contactability_status)
            VALUES('{blocked_lead}','{blocked_provider}','{blocked_product}','discovered',65,'review_candidate','official_contact_page');
          INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
            verification_status,preferred,email_ready,discovered_at,verified_at)
          VALUES('{blocked_provider}','{blocked_lead}','official_contact','https://blocked-maintenance.example/contact','contact',
            'https://blocked-maintenance.example/contact','official_site','verified',true,false,clock_timestamp(),clock_timestamp());
          INSERT INTO worker_decisions(provider_id,lead_id,decision,reason_code)
            VALUES('{blocked_provider}','{blocked_lead}','rejected','maintenance_fixture');
        """)
        blocked_before = sql(f"SELECT to_jsonb(l) FROM worker_leads l WHERE id='{blocked_lead}';")
        blocked_result = json.loads(sql(f"""SET ROLE service_role;
          SELECT mahshar_worker_maintain_contact_research('{blocked_provider}','{blocked_lead}',true,'[]'::jsonb);"""))
        assert blocked_result['result'] == 'blocked' and not blocked_result['actionable']
        assert sql(f"SELECT to_jsonb(l) FROM worker_leads l WHERE id='{blocked_lead}';") == blocked_before
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE lead_id='{blocked_lead}';") == '1'

        assert sql("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM worker_runs r;") == historical_runs
        assert sql("SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY discovery_batch_id,lead_id),'[]') FROM worker_qualified_contributions c;") == historical_contributions

        print('PASS: Worker transactional migration, qualified target, traction/contact schema, privileges, leases, provenance, retries, races, and concurrency')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
