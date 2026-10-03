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
            return json.loads(sql(f"SET ROLE service_role; SELECT row_to_json(r) FROM {expression} r;"))

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
            '20261002000100', '20261004000100',
        ]
        for migration in migrations:
            if migration not in (MIGRATION, PRIVILEGE_REPAIR, DISCOVERY, REVIEW_BAND):
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

        print('PASS: Worker transactional migration, privileges, leases, provenance, retries, races, and concurrency')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
