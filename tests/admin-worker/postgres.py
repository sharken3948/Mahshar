"""Fresh-schema Worker lifecycle, security, checkpoint, and concurrency checks."""
import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261001000100_admin_worker_foundation.sql'
PRIVILEGE_REPAIR = ROOT / 'supabase/migrations/20261001000110_admin_worker_least_privilege.sql'
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
        ]
        for migration in migrations:
            if migration not in (MIGRATION, PRIVILEGE_REPAIR):
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

        worker_tables = ['worker_control', 'worker_runs', 'worker_providers', 'worker_provider_identities',
                         'worker_products', 'worker_leads', 'worker_sources', 'worker_decisions']
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
            assert sql(f"""
              SELECT count(*) FROM pg_proc p,
                LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              WHERE p.oid='public.{function}'::regprocedure AND acl.grantee=0;
            """) == '0'

        assert sql("SELECT desired_state||','||batch_size FROM worker_control WHERE id=1;") == 'stopped,50'
        assert sql("SELECT count(*) FROM worker_runs WHERE status IN ('queued','running','stop_requested');") == '0'
        expect_failure("SET ROLE service_role; UPDATE worker_control SET batch_size=101 WHERE id=1;")

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
