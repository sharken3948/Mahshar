"""Disposable PostgreSQL latency/plan/lock checks. Synthetic data, no transports.

Run outside a socket-restricted sandbox. Results are local acceptance evidence,
not a forecast of Production latency. No third-party Python packages are needed.
"""
import concurrent.futures
import json
import os
import pathlib
import shutil
import statistics
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = pathlib.Path(os.environ.get('MAHSHAR_PG_BIN') or
    (str(pathlib.Path(shutil.which('initdb')).resolve().parent) if shutil.which('initdb') else
     '/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
ENV = dict(os.environ)
bundled = BIN.parents[2] / 'x86_64-linux-gnu'
if bundled.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(bundled)
MIGRATION = ROOT / 'supabase/migrations/20261017000100_admin_worker_mail_registry.sql'
REPORT = {'acceptance': {'stop_event_max_ms': 250, 'claim_max_ms': 500,
    'claim_provider_locks_max': 5, 'due_rows_max': 25, 'lock_timeout_ms': 250,
    'statement_timeout_ms': 2000}, 'dataset': {'providers': 10000, 'products': 20000,
    'leads': 20000, 'contacts': 20000, 'sources': 20000, 'acquisition': 1000,
    'outreach_threads': 1000, 'outreach_messages': 1000, 'retained_legacy': 754}}

with tempfile.TemporaryDirectory(prefix='mahshar-mail-performance-') as directory:
    socket = pathlib.Path(directory)
    def run(args, **kwargs):
        return subprocess.run([str(x) for x in args], env=ENV, text=True,
            capture_output=True, check=True, timeout=120, **kwargs)
    run([BIN / 'initdb', '-D', socket / 'data', '-U', 'mail_perf', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', socket / 'data', '-l', socket / 'postgres.log',
            '-o', f"-k {socket} -p 55464 -c listen_addresses=''", '-w', 'start'])
        started = True
        def sql(statement):
            try:
                return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                    '-h', socket, '-p', '55464', '-U', 'mail_perf', '-d', 'postgres'], input=statement).stdout.strip()
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error
        def measured(statement):
            begin = time.perf_counter()
            value = sql(statement)
            return round((time.perf_counter() - begin) * 1000, 2), value
        def wait_for(predicate, label):
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if predicate():
                    return
                time.sleep(0.01)
            raise AssertionError('Barrier was not reached: ' + label)
        def uid(n, kind=1):
            return f'{kind:08d}-0000-4000-8000-{n:012d}'
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE EXTENSION pgrowlocks;')
        for path in sorted((ROOT / 'supabase/migrations').glob('*.sql'), key=lambda p: p.name.split('_')[0]):
            if path != MIGRATION:
                sql('BEGIN;\n' + path.read_text() + '\nCOMMIT;')
        run_id = sql('SELECT (mahshar_worker_create_target_run(false)).id;')
        sql(f"UPDATE worker_runs SET status='running',deadline_at=clock_timestamp()+interval '1 hour' WHERE id='{run_id}';")
        # Deterministic two-product providers, with real table shapes and no
        # temporary candidates. Fresh evidence should not be scanned by recovery.
        sql(f"""
        INSERT INTO worker_providers(id,canonical_name,canonical_domain)
         SELECT ('00000001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Fixture '||n,'fixture-'||n||'.example' FROM generate_series(1,10000) n;
        INSERT INTO worker_provider_identities(provider_id,identity_type,normalized_value,original_value)
         SELECT id,'domain',canonical_domain,'https://'||canonical_domain FROM worker_providers;
        INSERT INTO worker_products(id,provider_id,normalized_product_key,display_name)
         SELECT ('00000002-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
          ('00000001-0000-4000-8000-'||lpad(((n+1)/2)::text,12,'0'))::uuid,'product-'||n,'Fixture API' FROM generate_series(1,20000) n;
        INSERT INTO worker_leads(id,provider_id,product_id,status,qualification_status,fit_score,email_ready,preferred_email,contactability_status)
         SELECT ('00000003-0000-4000-8000-'||lpad(row_number() OVER(ORDER BY id)::text,12,'0'))::uuid,provider_id,id,
          'qualified','qualified',90,true,'business'||row_number() OVER(ORDER BY id)||'@fixture.example','verified_email' FROM worker_products;
        INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at)
         SELECT l.provider_id,l.id,'email',l.preferred_email,'business','https://'||p.canonical_domain||'/contact','official_site','verified',(right(l.id::text,12)::bigint%2=1),true,
          clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day' FROM worker_leads l JOIN worker_providers p ON p.id=l.provider_id;
        INSERT INTO worker_sources(lead_id,source_type,source_role,url,checked_at)
         SELECT l.id,'website','official_docs','https://'||p.canonical_domain||'/docs',clock_timestamp()-interval '1 day'
          FROM worker_leads l JOIN worker_providers p ON p.id=l.provider_id;
        INSERT INTO admin_acquisition_attempts(provider_id,lead_id,run_id,status,reason_code,draft_only)
         SELECT provider_id,min(id::text)::uuid,'{run_id}','skipped','no_email',true FROM worker_leads
          WHERE provider_id BETWEEN '{uid(1001)}' AND '{uid(2000)}' GROUP BY provider_id;
        INSERT INTO admin_outreach_threads(provider_id,lead_id,status,last_outreach_at)
         SELECT provider_id,min(id::text)::uuid,'sent',clock_timestamp() FROM worker_leads
          WHERE provider_id BETWEEN '{uid(2001)}' AND '{uid(3000)}' GROUP BY provider_id;
        INSERT INTO admin_outreach_messages(thread_id,status,recipient_email,subject,body,approved_by,approved_at,sent_at,provider_message_id)
         SELECT t.id,'sent',l.preferred_email,'Synthetic fixture','No delivery performed','0x1111111111111111111111111111111111111111',
          clock_timestamp(),clock_timestamp(),'fixture-'||t.id FROM admin_outreach_threads t JOIN worker_leads l ON l.id=t.lead_id;
        ANALYZE;
        """)
        event = json.loads(sql("SELECT jsonb_build_object('provider',provider_message_id,'email',recipient_email) FROM admin_outreach_messages ORDER BY id LIMIT 1;"))
        sql("INSERT INTO discovered_apis(repo_url,api_name,invited) SELECT 'https://retained-'||n||'.example/docs','Retained fixture '||n,false FROM generate_series(1,754) n;")
        event_call = f"SELECT mahshar_admin_outreach_ingest_delivery_event('{event['provider']}','{event['email']}','delivered','1',clock_timestamp());"
        inbound_call = "SELECT mahshar_admin_outreach_ingest_unverified_inbound('synthetic-inbound',NULL,'{}','sender@fixture.example','support@mahshar.xyz','Synthetic fixture','No transport',clock_timestamp());"
        stop_call = 'SELECT mahshar_worker_request_stop();'
        def control_reset():
            sql(f"UPDATE worker_control SET desired_state='running'; UPDATE worker_runs SET status='running',heartbeat_at=clock_timestamp() WHERE id='{run_id}';")
        def samples(call, reset=False):
            values = []
            for _ in range(12):
                if reset:
                    control_reset()
                values.append(measured(call)[0])
            return {'median_ms': round(statistics.median(values), 2), 'max_ms': max(values)}
        REPORT['baseline'] = {'stop': samples(stop_call, True), 'delivery': samples(event_call), 'inbound': samples(inbound_call)}
        control_reset()
        REPORT['migration_ms'] = measured("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s';\n" + MIGRATION.read_text() + '\nCOMMIT;')[0]
        assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '0'
        assert sql("SELECT count(*) FROM pg_trigger WHERE tgname='worker_mail_transaction_gate';") == '0'
        REPORT['corrected_idle'] = {'stop': samples(stop_call, True), 'delivery': samples(event_call), 'inbound': samples(inbound_call)}
        control_reset()
        REPORT['empty_claim'] = samples(f"SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact');")
        # Twenty due leads represent ten providers. Contacts/sources are updated
        # under the normal triggers, not by manufacturing schedule timestamps.
        sql(f"UPDATE worker_contacts SET verified_at=clock_timestamp()-interval '31 days' WHERE lead_id BETWEEN '{uid(1,3)}' AND '{uid(20,3)}';")
        plan = json.loads(sql("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT provider_id,id FROM worker_leads WHERE mail_refresh_due_at<=statement_timestamp() ORDER BY mail_refresh_due_at,provider_id,id LIMIT 25;"))[0]
        REPORT['due_plan'] = plan
        def nodes(node):
            yield node
            for child in node.get('Plans', []):
                yield from nodes(child)
        assert any(n.get('Index Name') == 'worker_mail_refresh_due' for n in nodes(plan['Plan']))
        assert plan['Plan']['Actual Rows'] <= 25
        # Hold the ACTUAL claimed transaction at its end. Stop and incoming events
        # must complete while five provider/lead locks are still held, not after it.
        sql("CREATE FUNCTION test_recovery_hold() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(905010); END $$;")
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            blocker = pool.submit(sql,"SET application_name='perf_barrier'; BEGIN; SELECT pg_advisory_xact_lock(905010); SELECT pg_sleep(1.8); COMMIT;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_barrier' AND wait_event='PgSleep';") == '1', 'barrier owner')
            claim = pool.submit(measured, f"SET application_name='perf_claim'; BEGIN; SET LOCAL statement_timeout='2s'; SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact'); SELECT test_recovery_hold(); COMMIT;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_claim' AND wait_event='advisory';") == '1', 'claimed transaction')
            REPORT['held_rows'] = {table: int(sql(f"SELECT count(*) FROM pgrowlocks('{table}');")) for table in ['worker_providers','worker_products','worker_leads','worker_runs','worker_control']}
            REPORT['held_run_modes'] = json.loads(sql("SELECT coalesce(json_agg(modes),'[]') FROM pgrowlocks('worker_runs');"))
            REPORT['row_lock_waiters'] = int(sql("SELECT count(*) FROM pg_locks WHERE NOT granted AND locktype IN ('tuple','transactionid');"))
            assert REPORT['row_lock_waiters'] == 0
            assert REPORT['held_rows']['worker_providers'] == 5
            assert REPORT['held_rows']['worker_leads'] <= 10
            assert REPORT['held_rows']['worker_control'] == 0
            operations = {'stop': pool.submit(measured, stop_call), 'delivery': pool.submit(measured,event_call), 'inbound': pool.submit(measured,inbound_call)}
            REPORT['during_held_recovery'] = {name: future.result(timeout=1)[0] for name,future in operations.items()}
            assert not claim.done(), 'Independent operations must finish while the recovery transaction remains held'
            for latency in REPORT['during_held_recovery'].values():
                assert latency < REPORT['acceptance']['stop_event_max_ms']
            claim.result(timeout=3); blocker.result(timeout=3)
        control_reset()
        # Sweep transactions never acquire the control cursor. Hold their actual
        # provider locks across Stop, then checkpoint in a separate transaction.
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            blocker = pool.submit(sql,"SET application_name='perf_sweep_barrier'; BEGIN; SELECT pg_advisory_xact_lock(905011); SELECT pg_sleep(1.8); COMMIT;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_sweep_barrier' AND wait_event='PgSleep';") == '1','sweep barrier')
            sweep = pool.submit(sql,f"SET application_name='perf_sweep'; BEGIN; SELECT mahshar_worker_mail_recover('{run_id}'); SELECT pg_advisory_xact_lock(905011); COMMIT;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_sweep' AND wait_event='advisory';") == '1','sweep transaction')
            assert sql("SELECT count(*) FROM pgrowlocks('worker_control');") == '0'
            operations = {'stop': pool.submit(measured,stop_call),'delivery': pool.submit(measured,event_call),'inbound': pool.submit(measured,inbound_call)}
            REPORT['during_held_sweep'] = {name: future.result(timeout=1)[0] for name,future in operations.items()}
            assert not sweep.done()
            assert max(REPORT['during_held_sweep'].values()) < REPORT['acceptance']['stop_event_max_ms']
            result = sweep.result(timeout=3).splitlines()[0]
            part = json.loads(result)
            blocker.result(timeout=3)
        assert part['processed'] <= 25
        assert sql('SELECT mail_reconcile_cursor IS NULL FROM worker_control;') == 't'
        assert sql(f"SELECT mahshar_worker_mail_checkpoint_recovery('{run_id}',NULL,'{part['cursorAfter']}');") == 'f'
        control_reset()
        assert sql(f"SELECT mahshar_worker_mail_checkpoint_recovery('{run_id}',NULL,'{part['cursorAfter']}');") == 't'
        assert sql(f"SELECT mahshar_worker_mail_checkpoint_recovery('{run_id}',NULL,'{part['cursorAfter']}');") == 'f'
        REPORT['separate_checkpoint_replay'] = 'PASS'
        # Actual claim time without the deliberate barrier; replay cannot spend
        # another attempt. Parallel replay receives either the same work or [].
        before = sql("SELECT sum((mail_refresh->>'attempts')::integer) FROM worker_leads;")
        REPORT['claim_replay'] = samples(f"SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact');")
        assert sql("SELECT sum((mail_refresh->>'attempts')::integer) FROM worker_leads;") == before
        assert REPORT['claim_replay']['max_ms'] < REPORT['acceptance']['claim_max_ms']
        # A conflicting provider is skipped; no attempts/checkpoints are changed.
        sql('DELETE FROM worker_candidates;')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            busy = pool.submit(sql,f"SET application_name='perf_busy'; BEGIN; SELECT 1 FROM worker_providers WHERE id='{uid(1)}' FOR UPDATE; SELECT pg_sleep(0.6); ROLLBACK;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_busy' AND wait_event='PgSleep';") == '1','busy provider')
            REPORT['busy_skip_ms'], _ = measured(f"SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact');")
            assert REPORT['busy_skip_ms'] < 250
            assert not busy.done()
            busy.result()
        # Explicit row lock timeout rolls back the entire manual mutation; retry
        # after release must create exactly one permanent declaration.
        pending_row = sql("SELECT jsonb_build_object('id',id,'provider',provider_id) FROM admin_worker_mail_registry WHERE status='pending' LIMIT 1;")
        pending = json.loads(pending_row) if pending_row else None
        if pending is None:
            sql(f"SELECT mahshar_worker_mail_reconcile(p_provider_ids=>ARRAY['{uid(11)}']::uuid[],p_dry_run=>false);")
            pending = json.loads(sql(f"SELECT jsonb_build_object('id',id,'provider',provider_id) FROM admin_worker_mail_registry WHERE provider_id='{uid(11)}';"))
        mark = f"SELECT mahshar_worker_mail_mark_sent('{pending['id']}','0x1111111111111111111111111111111111111111');"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            held = pool.submit(sql,f"SET application_name='perf_manual_lock'; BEGIN; SELECT 1 FROM worker_providers WHERE id='{pending['provider']}' FOR UPDATE; SELECT pg_sleep(0.8); ROLLBACK;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_manual_lock' AND wait_event='PgSleep';") == '1','manual conflict')
            begin = time.perf_counter()
            try:
                sql(mark)
                raise AssertionError('Expected lock timeout')
            except AssertionError as error:
                assert 'lock timeout' in str(error), str(error)
            REPORT['lock_timeout_ms'] = round((time.perf_counter()-begin)*1000,2)
            assert 200 <= REPORT['lock_timeout_ms'] < 600
            assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE id='{pending['id']}';") == 'pending'
            held.result()
        sql(mark); first = sql(f"SELECT manual_sent_at::text||marked_by FROM admin_worker_mail_registry WHERE id='{pending['id']}';")
        sql(mark); assert sql(f"SELECT manual_sent_at::text||marked_by FROM admin_worker_mail_registry WHERE id='{pending['id']}';") == first
        # Direct SQL harness sets the timeout BEFORE the statement, as PostgREST
        # does with hoisted function settings. Test a real claim blocked by a
        # synthetic trigger; never change timeout expectations to make it pass.
        sql("DELETE FROM worker_candidates; CREATE FUNCTION test_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$; CREATE TRIGGER test_slow_claim BEFORE INSERT ON worker_candidates FOR EACH ROW EXECUTE FUNCTION test_slow_claim();")
        before = sql("SELECT md5(string_agg(coalesce(mail_refresh::text,''),'' ORDER BY id)) FROM worker_leads;")
        begin = time.perf_counter()
        try:
            sql(f"SET statement_timeout='2s'; SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact');")
            raise AssertionError('Expected statement timeout')
        except AssertionError as error:
            assert 'statement timeout' in str(error), str(error)
        REPORT['statement_timeout_ms'] = round((time.perf_counter()-begin)*1000,2)
        assert 1900 <= REPORT['statement_timeout_ms'] < 2600
        assert sql("SELECT md5(string_agg(coalesce(mail_refresh::text,''),'' ORDER BY id)) FROM worker_leads;") == before
        sql('DROP TRIGGER test_slow_claim ON worker_candidates; DROP FUNCTION test_slow_claim();')
        REPORT['post_timeout_claim_ms'], result = measured(f"SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact');")
        assert len(json.loads(result)) <= 5
        assert REPORT['post_timeout_claim_ms'] < REPORT['acceptance']['claim_max_ms']
        sql(f"DELETE FROM worker_candidates WHERE mail_recovery_kind='contact'; UPDATE worker_contacts SET verified_at=clock_timestamp()-interval '31 days' WHERE provider_id='{uid(4000)}';")
        profiling = "LOAD 'auto_explain'; SET plan_cache_mode=force_generic_plan; SET auto_explain.log_min_duration=0; SET auto_explain.log_analyze=on; SET auto_explain.log_buffers=on; SET auto_explain.log_format='json'; SET auto_explain.log_nested_statements=on; "
        REPORT['profiled_contact_claim_ms'], _ = measured(profiling+f"SELECT mahshar_worker_mail_claim_recovery('{run_id}','contact');")
        assert REPORT['profiled_contact_claim_ms'] < REPORT['acceptance']['claim_max_ms']
        # Retained legacy assertions also use a bounded indexed range and never
        # manufacture contacts/qualification. Capture the actual nested SQL plan.
        sql("""INSERT INTO discovered_apis(id,repo_url,api_name,invited)
          SELECT ('00000004-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
           'https://legacy-'||n||'.example/docs','Legacy fixture '||n,false FROM generate_series(1,50) n;""")
        legacy_payload = json.dumps([{'identity': f'legacy-{n}.example','providerName': f'Legacy fixture {n}',
            'productName': 'Legacy asserted API','docsUrl': f'https://legacy-{n}.example/docs',
            'officialUrl': f'https://legacy-{n}.example','legacyIds': [uid(n,4)],'csvSha256':'0'*64} for n in range(1,51)])
        sql("SELECT mahshar_worker_mail_seed_legacy('"+legacy_payload+"'::jsonb,false);")
        REPORT['legacy_assertions'] = 50
        assert sql("SELECT count(*) FROM worker_leads WHERE provider_id IN (SELECT id FROM worker_providers WHERE mail_intake IS NOT NULL);") == '0'
        legacy_plan = json.loads(sql("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM worker_providers WHERE mail_intake_due_at<=statement_timestamp() ORDER BY mail_intake_due_at,id LIMIT 25;"))[0]
        REPORT['legacy_due_plan'] = legacy_plan
        assert any(n.get('Index Name') == 'worker_mail_intake_due' for n in nodes(legacy_plan['Plan']))
        assert legacy_plan['Plan']['Actual Rows'] <= 25
        begin = time.perf_counter()
        sql(profiling+f"SELECT mahshar_worker_mail_claim_recovery('{run_id}','legacy');")
        REPORT['profiled_legacy_claim_ms'] = round((time.perf_counter()-begin)*1000,2)
        assert REPORT['profiled_legacy_claim_ms'] < REPORT['acceptance']['claim_max_ms']
        log = (socket / 'postgres.log').read_text()
        decoder = json.JSONDecoder()
        nested = []
        for offset,char in enumerate(log):
            if char != '{':
                continue
            try:
                value,_ = decoder.raw_decode(log[offset:])
            except ValueError:
                continue
            if isinstance(value,dict) and 'Query Text' in value and "WHERE p_kind='legacy'" in value['Query Text']:
                nested.append(value)
        assert nested, 'Actual claim query plan was not logged'
        REPORT['actual_claim_plan'] = nested[-1]
        contact_plans = [p for p in nested if "$2 = 'contact'" in p.get('Query Parameters','')]
        assert contact_plans, 'Actual contact claimant plan was not logged'
        REPORT['actual_contact_claim_plan'] = contact_plans[-1]
        assert any(n.get('Index Name') == 'worker_mail_refresh_due' and n['Actual Loops']>0 for n in nodes(contact_plans[-1]['Plan']))
        assert any(n.get('Index Name') == 'worker_mail_intake_due' and n['Actual Loops']>0 for n in nodes(nested[-1]['Plan']))
        assert not any(n['Node Type']=='Seq Scan' and n.get('Relation Name') in ('worker_providers','worker_leads') and n['Actual Loops']>0 for n in nodes(nested[-1]['Plan']))
        # History may change without a Worker trigger. Even a due slice that is
        # entirely blocked must lock at most five providers and spend no attempt.
        sql("DELETE FROM worker_candidates WHERE mail_recovery_kind='legacy'; UPDATE discovered_apis SET invited=true WHERE id::text LIKE '00000004-%';")
        attempts_before = sql("SELECT sum((mail_intake->>'attempts')::integer) FROM worker_providers;")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            blocker = pool.submit(sql,"SET application_name='perf_blocked_barrier'; BEGIN; SELECT pg_advisory_xact_lock(905012); SELECT pg_sleep(1.8); COMMIT;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_blocked_barrier' AND wait_event='PgSleep';") == '1','blocked slice barrier')
            blocked_claim = pool.submit(sql,f"SET application_name='perf_blocked_claim'; BEGIN; SELECT mahshar_worker_mail_claim_recovery('{run_id}','legacy'); SELECT pg_advisory_xact_lock(905012); COMMIT;")
            wait_for(lambda: sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='perf_blocked_claim' AND wait_event='advisory';") == '1','blocked due slice')
            REPORT['blocked_slice_provider_locks'] = int(sql("SELECT count(*) FROM pgrowlocks('worker_providers');"))
            assert REPORT['blocked_slice_provider_locks'] <= 5
            assert json.loads(blocked_claim.result(timeout=3).splitlines()[0]) == []
            blocker.result(timeout=3)
        assert sql("SELECT sum((mail_intake->>'attempts')::integer) FROM worker_providers;") == attempts_before
        # Export non-sensitive synthetic metrics only when explicitly requested.
        REPORT['status'] = 'PASS'
        output = os.environ.get('MAHSHAR_MAIL_PERFORMANCE_REPORT')
        if output:
            pathlib.Path(output).write_text(json.dumps(REPORT,indent=2)+'\n')
        print(json.dumps(REPORT,indent=2),flush=True)
    finally:
        if started:
            run([BIN / 'pg_ctl','-D',socket / 'data','-m','immediate','-w','stop'])
