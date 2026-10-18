"""Pending Emails integration: disposable PostgreSQL only; no credentials or network calls."""
import concurrent.futures
import re
import time
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261017000100_admin_worker_mail_registry.sql'
configured = os.environ.get('MAHSHAR_PG_BIN')
BIN = pathlib.Path(configured) if configured else (
    pathlib.Path(shutil.which('initdb')).resolve().parent if shutil.which('initdb') else
    pathlib.Path('/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
ENV = dict(os.environ)
bundled = BIN.parents[2] / 'x86_64-linux-gnu'
if bundled.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(bundled)

with tempfile.TemporaryDirectory(prefix='mahshar-mail-test-') as directory:
    socket = pathlib.Path(directory)
    def run(args, **kwargs):
        return subprocess.run([str(a) for a in args], env=ENV, text=True, capture_output=True,
                              check=True, timeout=60, **kwargs)
    run([BIN / 'initdb', '-D', socket / 'data', '-U', 'mail_test', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', socket / 'data', '-l', socket / 'postgres.log', '-o',
             f"-k {socket} -p 55463 -c listen_addresses=''", '-w', 'start'])
        started = True
        def sql(statement):
            try:
                return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                            '-p', '55463', '-U', 'mail_test', '-d', 'postgres'], input=statement).stdout.strip()
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error
        def quote(value):
            return "'" + str(value).replace("'", "''") + "'"
        def data(expression):
            projection = "coalesce(json_agg(t),'[]') FROM " + expression + ' t' if expression.startswith('mahshar_worker_mail_discovery_state') else 'to_jsonb(' + expression + ')'
            result = sql('SET ROLE service_role; SELECT ' + projection + ';')
            return json.loads(result) if result else None
        def failure(statement, marker):
            try:
                sql(statement)
            except AssertionError as error:
                assert marker in str(error), str(error)
            else:
                raise AssertionError('Expected failure: ' + marker)

        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        migrations = sorted((ROOT / 'supabase/migrations').glob('*.sql'), key=lambda p: p.name.split('_')[0])
        for migration in migrations:
            if migration.name < MIGRATION.name:
                sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')
        if '--historical-snapshot' in sys.argv:
            # Optional audit mode: replay an explicitly supplied read-only metadata
            # snapshot into this fresh private cluster, never its source database.
            snapshot_file = pathlib.Path(sys.argv[sys.argv.index('--historical-snapshot') + 1])
            observed = json.loads(snapshot_file.read_text())
            assert observed['readOnly'] == 'on' and observed['observedAt']
            tables = ['worker_runs','worker_providers','worker_provider_identities','worker_products',
                      'worker_leads','worker_sources','worker_contacts','worker_decisions',
                      'admin_acquisition_attempts','admin_outreach_threads','admin_outreach_messages',
                      'discovered_apis','outreach_log']
            for table in tables:
                if not observed[table]:
                    continue
                columns = sql(f"SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' AND is_generated='NEVER';")
                payload = quote(json.dumps(observed[table]))
                sql(f"INSERT INTO public.{table}({columns}) OVERRIDING SYSTEM VALUE SELECT {columns} FROM jsonb_populate_recordset(NULL::public.{table},{payload}::jsonb);")
            original = {table: sql(f"SELECT md5(coalesce(string_agg((to_jsonb(t)-'mail_intake'-'mail_refresh'-'mail_reconcile_cursor'-'mail_intake_due_at'-'mail_refresh_due_at')::text,'' ORDER BY id),'')) FROM {table} t;") for table in tables}
            sql('BEGIN;\n' + MIGRATION.read_text() + '\nCOMMIT;')
            query = run(['node','--import','tsx','scripts/reconcile-pending-emails.mts','--print-query'], cwd=ROOT).stdout
            captured = json.loads(sql(query))
            captured['observedAt'] = observed['observedAt']
            captured_path = socket / 'reconciliation-snapshot.json'
            captured_path.write_text(json.dumps(captured))
            historical_csv = (pathlib.Path(sys.argv[sys.argv.index('--historical-csv') + 1])
                if '--historical-csv' in sys.argv else ROOT / 'exports/mahshar-api-provider-shortlist-2026-10-16.csv')
            report = json.loads(run(['node','--import','tsx','scripts/reconcile-pending-emails.mts',
                '--csv',historical_csv,'--snapshot',captured_path], cwd=ROOT).stdout)
            assert all(sql(f"SELECT md5(coalesce(string_agg((to_jsonb(t)-'mail_intake'-'mail_refresh'-'mail_reconcile_cursor'-'mail_intake_due_at'-'mail_refresh_due_at')::text,'' ORDER BY id),'')) FROM {table} t;") == digest for table,digest in original.items())
            assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '0'
            intake = data('mahshar_worker_mail_seed_legacy(' + quote(json.dumps(report['legacyIntake'])) + '::jsonb)')
            assert len(intake) == 26 and all(row['disposition']=='legacy_first_pass' for row in intake)
            assert all(sql(f"SELECT md5(coalesce(string_agg((to_jsonb(t)-'mail_intake'-'mail_refresh'-'mail_reconcile_cursor'-'mail_intake_due_at'-'mail_refresh_due_at')::text,'' ORDER BY id),'')) FROM {table} t;") == digest for table,digest in original.items())
            report_path = pathlib.Path('/tmp/mahshar-pending-emails-historical-report.json')
            with os.fdopen(os.open(report_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), 'w') as output:
                json.dump(report, output, indent=2)
            print(json.dumps({'mode':'historical_read_only_replay','observedAt':observed['observedAt'],
                'count':report['count'],'counts':report['counts'],'assessments':report['assessments'],'legacyIntakeValidated':len(intake),'csvSha256':report['csvSha256'],
                'registryRows':0,'sourceRowsUnchanged':True,'privateReport':str(report_path)}), flush=True)
            sys.exit(0)
        run_id = sql('SELECT (mahshar_worker_create_target_run(false)).id;')
        counter = 0
        def fixture(label, qualification='qualified', contact=True, docs=True, purpose='business', inbox='team'):
            global counter
            counter += 1
            domain = label.replace('_', '-') + '.example'
            provider = sql(f"INSERT INTO worker_providers(canonical_name,canonical_domain) VALUES('Fixture {counter}','{domain}') RETURNING id;")
            product = sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{provider}','product','Unverified Directory Title') RETURNING id;")
            lead = sql(f"""INSERT INTO worker_leads(provider_id,product_id,status,qualification_status,fit_score,
              email_ready,preferred_email,contactability_status,commercial_api)
              VALUES('{provider}','{product}','discovered','{qualification}',90,{str(contact).lower()},
                '{inbox}@{domain}','{'verified_email' if contact else 'unknown'}',true) RETURNING id;""")
            contact_id = None
            if contact:
                contact_id = sql(f"""INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,
                  source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at)
                  VALUES('{provider}','{lead}','email','{inbox}@{domain}','{purpose}','https://{domain}/contact',
                    'official_site','verified',true,true,clock_timestamp(),clock_timestamp()) RETURNING id;""")
            if docs:
                sql(f"""INSERT INTO worker_sources(lead_id,source_type,source_role,url,checked_at,naming_evidence)
                  VALUES('{lead}','website','official_docs','https://{domain}/docs',clock_timestamp(),
                    '[{{"kind":"product","name":"Verified API","basis":"provider_statement","quote":"Our API is called Verified API."}}]');""")
            return {'provider': provider, 'product': product, 'lead': lead, 'contact': contact_id, 'domain': domain}
        def attempt(item, status, reason=None, draft_only=False):
            return sql(f"""INSERT INTO admin_acquisition_attempts(provider_id,lead_id,run_id,status,reason_code,draft_only)
              VALUES('{item['provider']}','{item['lead']}','{run_id}','{status}',{quote(reason) if reason else 'NULL'},{str(draft_only).lower()}) RETURNING id;""")

        eligible = [fixture('eligible-' + str(i)) for i in range(28)]
        recovery = fixture('no-email-recovered'); attempt(recovery, 'skipped', 'no_email')
        invalid = [fixture('review', 'review_candidate'), fixture('deferred', 'deferred'),
                   fixture('unverified', contact=False), fixture('no-docs', docs=False),
                   fixture('privacy', purpose='privacy'), fixture('press', inbox='press'),
                   fixture('data-protection', inbox='dataprotection'), fixture('invalid-address', inbox='bad..mail')]
        rejected = fixture('rejected'); sql(f"UPDATE worker_providers SET status='rejected' WHERE id='{rejected['provider']}';")
        dnc = fixture('dnc'); sql(f"INSERT INTO worker_decisions(provider_id,decision,reason_code) VALUES('{dnc['provider']}','do_not_contact','fixture');")
        for state, reason in [('simulated_sent', None), ('uncertain', None), ('reserved', None),
                              ('failed', 'dispatch_blocked'), ('skipped', 'terminal_rejection')]:
            item = fixture('history-' + state); attempt(item, state, reason); invalid.append(item)
        for state, reason in [('skipped','draft_invalid'), ('failed','provider_failed')]:
            item = fixture('preparation-' + state); attempt(item,state,reason,draft_only=True); eligible.append(item)
        dispatched = fixture('outreach-reserved')
        thread = sql(f"INSERT INTO admin_outreach_threads(provider_id,lead_id,status) VALUES('{dispatched['provider']}','{dispatched['lead']}','draft') RETURNING id;")
        sql(f"""INSERT INTO admin_outreach_messages(thread_id,status,recipient_email,subject,body,approved_at,approved_by,send_reserved_at,send_uncertain_at)
          VALUES('{thread}','ready_to_send','team@{dispatched['domain']}','Original subject','Original draft',clock_timestamp(),
            '0x1111111111111111111111111111111111111111',clock_timestamp(),clock_timestamp());""")
        old_tables = ['worker_providers','worker_leads','worker_products','worker_contacts','worker_sources',
                      'admin_acquisition_attempts','admin_outreach_threads','admin_outreach_messages','worker_control','worker_runs']
        def snapshot(table):
            return sql(f"SELECT md5(coalesce(string_agg((to_jsonb(t)-'mail_intake'-'mail_refresh'-'mail_reconcile_cursor'-'mail_intake_due_at'-'mail_refresh_due_at')::text,'' ORDER BY id),'')) FROM {table} t;")
        before = {table: snapshot(table) for table in old_tables}
        functions = json.loads(sql("""SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
            AND p.proname LIKE 'mahshar_%';"""))
        failure('BEGIN;\n' + MIGRATION.read_text() + "\nDO $$ BEGIN RAISE EXCEPTION 'rollback_mail'; END $$; COMMIT;", 'rollback_mail')
        assert sql("SELECT to_regclass('public.admin_worker_mail_registry');") == ''
        sql('BEGIN;\n' + MIGRATION.read_text() + '\nCOMMIT;')
        assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '0', 'Migration must not import history'
        assert {table: snapshot(table) for table in old_tables} == before
        changed = {'mahshar_acquisition_draft_context(uuid)', 'mahshar_acquisition_claim_next(uuid,uuid)',
                   'mahshar_acquisition_reserve_brevo(uuid,uuid)','mahshar_worker_claim_deferred_candidates(uuid,text,integer)',
                   'mahshar_acquisition_claim_draft(uuid,uuid)',
                   'mahshar_admin_outreach_edit_draft(uuid,text,text)','mahshar_admin_outreach_approve_draft(uuid,text)',
                   'mahshar_admin_outreach_mark_sent(uuid,text)','mahshar_admin_outreach_edit_reply_draft(uuid,text,text)',
                   'mahshar_admin_outreach_mark_reply_sent(uuid,text)','mahshar_admin_outreach_reserve_send(uuid)',
                   'mahshar_admin_outreach_set_status(uuid,uuid,text)','mahshar_admin_outreach_finish_send(uuid,text)'}
        for signature, definition in functions.items():
            if signature not in changed:
                actual = sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);")
                assert actual == definition.strip(), signature
        print('PASS: all 45 migrations, rollback and original data/function preservation', flush=True)
        # Later migrations depend on the registry schema; run eligibility checks
        # against the fully upgraded schema in chronological order.
        for migration in migrations:
            if migration.name > MIGRATION.name:
                sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')

        for role in ['anon', 'authenticated', 'service_role']:
            for privilege in ['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']:
                assert sql(f"SELECT has_table_privilege('{role}','admin_worker_mail_registry','{privilege}');") == 'f'
        for role in ['anon', 'authenticated']:
            for signature in ['mahshar_worker_mail_mark_sent(uuid,text)', 'mahshar_worker_mail_list(uuid,integer)',
                              'mahshar_worker_mail_reconcile(uuid,integer,boolean,uuid[])', 'mahshar_worker_mail_discovery_state(text[])',
                              'mahshar_worker_mail_seed_legacy(jsonb,boolean)','mahshar_worker_mail_recover(uuid,integer)',
                              'mahshar_worker_mail_checkpoint_recovery(uuid,uuid,uuid)',
                              'mahshar_worker_mail_claim_recovery(uuid,text,integer)','mahshar_worker_mail_finish_recovery(uuid,text)']:
                assert sql(f"SELECT has_function_privilege('{role}','{signature}','EXECUTE');") == 'f'
        assert sql("SELECT relrowsecurity FROM pg_class WHERE oid='admin_worker_mail_registry'::regclass;") == 't'
        report = data('mahshar_worker_mail_reconcile()')
        assert sum(row['eligible'] for row in report) == 31
        assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '0'
        report = data('mahshar_worker_mail_reconcile(p_dry_run=>false)')
        assert sql('SELECT count(*) FROM admin_worker_mail_registry;') == '31'
        snapshot_once = snapshot('admin_worker_mail_registry')
        data('mahshar_worker_mail_reconcile(p_dry_run=>false)')
        assert snapshot('admin_worker_mail_registry') == snapshot_once
        query = run(['node', '--import', 'tsx', 'scripts/reconcile-pending-emails.mts', '--print-query'], cwd=ROOT).stdout
        captured = json.loads(sql(query))
        assert captured['readOnly'] == 'on' and len(captured['reconciliation']) == len(report)
        assert snapshot('admin_worker_mail_registry') == snapshot_once
        snapshot_path = socket / 'snapshot.json'
        snapshot_path.write_text(json.dumps(captured))
        csv_path = socket / 'shortlist.csv'
        csv_path.write_text('Company / Provider name,Official website,Verified business email\n'
          + '\n'.join(f"Fixture,https://{item['domain']}/,team@{item['domain']}" for item in [eligible[0], invalid[0]]))
        reconciled = json.loads(run(['node','--import','tsx','scripts/reconcile-pending-emails.mts',
          '--csv',csv_path,'--snapshot',snapshot_path], cwd=ROOT).stdout)
        assert reconciled['counts'] == {'already_pending': 1, 'qualification_or_contact_incomplete': 1}
        assert reconciled['eligibleProviderIds'] == []
        page = data('mahshar_worker_mail_list()')
        assert len(page['items']) == 25 and page['nextCursor']
        second = data(f"mahshar_worker_mail_list('{page['nextCursor']}')")
        assert len(second['items']) == 6 and second['nextCursor'] is None
        assert len({r['id'] for r in page['items'] + second['items']}) == 31
        assert all(r['apiName'] == 'Verified API' for r in page['items'])
        print('PASS: draft-independent complete historical backfill, dry-run, idempotency, exclusions and pagination', flush=True)

        fresh = fixture('new-worker-result')
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{fresh['provider']}';") == '1'
        fallback = fixture('safe-fallback')
        sql(f"UPDATE worker_sources SET naming_evidence=NULL WHERE lead_id='{fallback['lead']}';")
        assert sql(f"SELECT api_name FROM admin_worker_mail_registry WHERE provider_id='{fallback['provider']}';").startswith('Fixture ')
        sql(f"UPDATE worker_sources SET source_role='official_site' WHERE lead_id='{fallback['lead']}';")
        assert sql(f"SELECT mahshar_worker_mail_candidate('{fallback['provider']}')->>'eligible';") == 'true', 'Existing official-site identity proof must remain valid'
        github = fixture('github-contact')
        sql(f"UPDATE worker_contacts SET source_type='official_github',source_url='https://github.com/fixture-owner' WHERE id='{github['contact']}';")
        assert sql(f"SELECT mahshar_worker_mail_candidate('{github['provider']}')->>'eligible';") == 'false'
        sql(f"INSERT INTO worker_provider_identities(provider_id,identity_type,normalized_value,original_value) VALUES('{github['provider']}','github_org','fixture-owner','fixture-owner');")
        assert sql(f"SELECT mahshar_worker_mail_candidate('{github['provider']}')->>'eligible';") == 'true'
        assert sql("SELECT mahshar_worker_mail_business_email('wordpress-support@example.com','support');") == 't'
        future = fixture('future-contact', contact=False)
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{future['provider']}';") == '0'
        sql(f"""INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
          verification_status,preferred,email_ready,discovered_at,verified_at)
          VALUES('{future['provider']}','{future['lead']}','email','team@{future['domain']}','business',
            'https://{future['domain']}/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp());
          UPDATE worker_leads SET email_ready=true,contactability_status='verified_email' WHERE id='{future['lead']}';""")
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{future['provider']}';") == '1'
        # Two concurrent Worker result writes still produce one provider claim.
        def refresh(_):
            return sql(f"UPDATE worker_leads SET updated_at=clock_timestamp() WHERE id='{fresh['lead']}';")
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(refresh, range(3)))
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{fresh['provider']}';") == '1'

        picked = eligible[0]
        mail_id = sql(f"SELECT id FROM admin_worker_mail_registry WHERE provider_id='{picked['provider']}';")
        history_before = {table: snapshot(table) for table in ['worker_contacts','admin_acquisition_attempts','admin_outreach_messages']}
        def mark(_):
            return data(f"mahshar_worker_mail_mark_sent('{mail_id}','0x1111111111111111111111111111111111111111')")
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            marks = list(pool.map(mark, range(4)))
        assert all(m == marks[0] for m in marks)
        assert marks[0]['status'] == 'manual_sent' and marks[0]['manualSentAt']
        assert sql(f"SELECT marked_by FROM admin_worker_mail_registry WHERE id='{mail_id}';") == '0x1111111111111111111111111111111111111111'
        assert {table: snapshot(table) for table in history_before} == history_before
        assert sql(f"SELECT count(*) FROM worker_providers WHERE id='{picked['provider']}';") == '1'
        assert all(r['id'] != mail_id for r in data('mahshar_worker_mail_list(p_limit=>100)')['items'])
        data('mahshar_worker_mail_reconcile(p_dry_run=>false)')
        assert mark(0) == marks[0]
        sql(f"""INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,
          discovered_domain,discovered_product,status) VALUES('{run_id}',299,'api_directory','https://directory.example',
          'Fixture','{picked['domain']}','Different API','pending');
          DELETE FROM worker_candidates WHERE discovered_domain='{picked['domain']}';""")
        assert data(f"mahshar_worker_mail_discovery_state(ARRAY['{picked['domain']}'])")[0]['reason'] == 'manual_mail_history'
        other_product = sql(f"INSERT INTO worker_products(provider_id,normalized_product_key,display_name) VALUES('{picked['provider']}','different','Different API') RETURNING id;")
        sql(f"INSERT INTO worker_leads(provider_id,product_id,status,qualification_status) VALUES('{picked['provider']}','{other_product}','qualified','qualified');")
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{picked['provider']}';") == '1'
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE id='{mail_id}';") == 'manual_sent'
        print('PASS: automatic Worker population, safe names, later contact recovery, concurrent mark and permanent history after cleanup', flush=True)

        suppressed = eligible[1]
        sql(f"INSERT INTO worker_decisions(provider_id,decision,reason_code) VALUES('{suppressed['provider']}','do_not_contact','fixture');")
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{suppressed['provider']}';") == 'excluded'
        failure(f"SET ROLE service_role; SELECT mahshar_worker_mail_mark_sent((SELECT id FROM admin_worker_mail_registry WHERE provider_id='{suppressed['provider']}'),'0x1111111111111111111111111111111111111111');", 'mail_not_pending')
        claimed = eligible[2]
        thread = sql(f"INSERT INTO admin_outreach_threads(provider_id,lead_id,status) VALUES('{claimed['provider']}','{claimed['lead']}','draft') RETURNING id;")
        message = sql(f"""INSERT INTO admin_outreach_messages(thread_id,status,recipient_email,subject,body,approved_at,approved_by)
          SELECT '{thread}','ready_to_send','team@{claimed['domain']}',v->>'subject',v->>'body',clock_timestamp(),
            '0x1111111111111111111111111111111111111111' FROM (SELECT mahshar_invitation_render_v2(NULL,'Verified API') v) x RETURNING id;""")
        failure(f"SET ROLE service_role; SELECT mahshar_admin_outreach_reserve_send('{message}');", 'provider_manual_mail_claimed')
        assert sql(f"SELECT send_reserved_at IS NULL FROM admin_outreach_messages WHERE id='{message}';") == 't'
        at = attempt(claimed, 'investigating')
        failure(f"UPDATE admin_acquisition_attempts SET status='reserved',reserved_at=clock_timestamp() WHERE id='{at}';", 'provider_manual_mail_claimed')
        sql(f"UPDATE worker_runs SET status='running' WHERE id='{run_id}'; UPDATE admin_acquisition_control SET desired_state='running',operating_mode='continuous';")
        epoch = sql('SELECT epoch FROM admin_acquisition_control;')
        # Existing claim functions must select no manual-owned providers, including those without drafts.
        claim = data(f"mahshar_acquisition_claim_draft('{run_id}','{epoch}')")
        assert claim is None or claim['providerId'] not in {i['provider'] for i in eligible}
        assert data(f"mahshar_acquisition_reserve_brevo('{run_id}','{epoch}')") is None
        # An incomplete, due investigation remains eligible for the established retry path.
        due = fixture('retry-due', qualification='deferred', contact=False, docs=False)
        assert data(f"mahshar_worker_mail_discovery_state(ARRAY['{due['domain']}'])")[0]['reason'] is None
        sql(f"UPDATE worker_leads SET qualification_retry_after=clock_timestamp()+interval '1 hour' WHERE id='{due['lead']}';")
        assert data(f"mahshar_worker_mail_discovery_state(ARRAY['{due['domain']}'])")[0]['reason'] == 'provider_retry_not_due'
        legacy_id = sql("INSERT INTO discovered_apis(repo_url,api_name,invited) VALUES('https://legacy-contacted.example/docs','Legacy fixture',true) RETURNING id;")
        assert data("mahshar_worker_mail_discovery_state(ARRAY['legacy-contacted.example'])")[0]['reason'] == 'legacy_outreach_history'
        # Prepare an eligible, unclaimed fixture, then race the actual initial
        # reservation against actual reconciliation. No transport is involved.
        sql('ALTER TABLE worker_sources DISABLE TRIGGER worker_mail_source;')
        race = fixture('reservation-race')
        sql('ALTER TABLE worker_sources ENABLE TRIGGER worker_mail_source;')
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{race['provider']}';") == '0'
        race_thread = sql(f"INSERT INTO admin_outreach_threads(provider_id,lead_id,status) VALUES('{race['provider']}','{race['lead']}','draft') RETURNING id;")
        race_message = sql(f"""INSERT INTO admin_outreach_messages(thread_id,status,recipient_email,subject,body,approved_at,approved_by)
          SELECT '{race_thread}','ready_to_send','team@{race['domain']}',v->>'subject',v->>'body',clock_timestamp(),
            '0x1111111111111111111111111111111111111111' FROM (SELECT mahshar_invitation_render_v2(NULL,'Verified API') v) x RETURNING id;""")
        def race_action(action):
            if action == 'manual':
                return data(f"mahshar_worker_mail_reconcile(p_dry_run=>false,p_provider_ids=>ARRAY['{race['provider']}']::uuid[])")
            try:
                return data(f"mahshar_admin_outreach_reserve_send('{race_message}')")
            except AssertionError as error:
                assert 'provider_manual_mail_claimed' in str(error)
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(race_action, ['manual','outreach']))
        pending = sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{race['provider']}' AND status='pending';") == '1'
        reserved = sql(f"SELECT send_reserved_at IS NOT NULL FROM admin_outreach_messages WHERE id='{race_message}';") == 't'
        assert pending != reserved, 'Exactly one invitation channel must own the provider'
        print('PASS: DNC, cross-channel reservation/selection exclusion, and safe deferred recovery; no transport exists in this harness', flush=True)
        # Recoverable errors must never latch an existing pending entry to excluded.
        prep = fixture('recoverable-sync')
        at = attempt(prep, 'failed', 'provider_failed', draft_only=True)
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{prep['provider']}';") == 'pending'
        sql(f"UPDATE admin_acquisition_attempts SET status='skipped',reason_code='draft_invalid' WHERE id='{at}';")
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{prep['provider']}';") == 'pending'
        terminal = fixture('unknown-failure'); attempt(terminal,'failed',None,draft_only=True)
        assert sql(f"SELECT mahshar_worker_mail_block_reason('{terminal['provider']}');") == 'acquisition_history'

        # Stop existing fixture providers from competing with focused recovery claims.
        sql("UPDATE worker_providers SET status='rejected';")
        sql(f"UPDATE worker_runs SET status='running',deadline_at=clock_timestamp()+interval '10 minutes' WHERE id='{run_id}'; UPDATE worker_control SET desired_state='running';")
        # A draft claim expires by passage of time only: no attempt or run UPDATE fires a trigger.
        sql('ALTER TABLE worker_sources DISABLE TRIGGER worker_mail_source;')
        expiry = fixture('expired-draft')
        sql('ALTER TABLE worker_sources ENABLE TRIGGER worker_mail_source;')
        sql(f"""INSERT INTO admin_acquisition_attempts(provider_id,lead_id,run_id,status,draft_only,draft_claim_expires_at)
          VALUES('{expiry['provider']}','{expiry['lead']}','{run_id}','investigating',true,clock_timestamp()+interval '400 milliseconds');""")
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{expiry['provider']}';") == '0'
        sql('SELECT pg_sleep(0.5);')
        # Sweep/checkpoint use separate transactions. Losing the checkpoint
        # replays a bounded slice without losing or duplicating registry history.
        first_slice = data(f"mahshar_worker_mail_recover('{run_id}')")
        assert first_slice['processed'] <= 25
        assert data(f"mahshar_worker_mail_recover('{run_id}')") == first_slice
        for _ in range(20):
            part = data(f"mahshar_worker_mail_recover('{run_id}')")
            before = quote(part['cursorBefore'])+'::uuid' if part['cursorBefore'] else 'NULL::uuid'
            after = quote(part['cursorAfter'])+'::uuid' if part['cursorAfter'] else 'NULL::uuid'
            data(f"mahshar_worker_mail_checkpoint_recovery('{run_id}',{before},{after})")
            if part['cursorAfter'] is None:
                break
        else:
            raise AssertionError('Bounded sweep failed to wrap its durable cursor')
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{expiry['provider']}';") == 'pending'
        print('PASS: recoverable preparation errors and expired claim recovery without attempt/run writes', flush=True)

        stale = fixture('stale-contact')
        sql(f"""UPDATE worker_contacts SET verified_at=clock_timestamp()-interval '31 days' WHERE lead_id='{stale['lead']}';
          UPDATE worker_sources SET checked_at=clock_timestamp()-interval '31 days' WHERE lead_id='{stale['lead']}';
          UPDATE worker_leads SET contact_checked_at=clock_timestamp()-interval '31 days' WHERE id='{stale['lead']}';
          DELETE FROM worker_candidates WHERE lead_id='{stale['lead']}';""")
        assert all(row['emailAddress']!='team@stale-contact.example' for row in data('mahshar_worker_mail_list(p_limit=>100)')['items'])
        recovered = data(f"mahshar_worker_mail_claim_recovery('{run_id}','contact')")
        selected = next(row for row in recovered if row['lead_id']==stale['lead'])
        replay = data(f"mahshar_worker_mail_claim_recovery('{run_id}','contact')")
        assert [r['id'] for r in replay] == [r['id'] for r in recovered]
        assert json.loads(sql(f"SELECT mail_refresh FROM worker_leads WHERE id='{stale['lead']}';"))['attempts'] == 1
        # A local synthetic evidence refresh uses new observations, never the CSV address or old timestamps.
        sql(f"""UPDATE worker_contacts SET verified_at=clock_timestamp() WHERE lead_id='{stale['lead']}';
          UPDATE worker_sources SET checked_at=clock_timestamp() WHERE lead_id='{stale['lead']}';""")
        data(f"mahshar_worker_mail_finish_recovery('{selected['id']}','contact_enriched')")
        assert any(row['emailAddress']=='team@stale-contact.example' for row in data('mahshar_worker_mail_list(p_limit=>100)')['items'])
        # Retained old addresses do not make a failed current email-readiness check successful.
        obsolete = fixture('retained-address-not-ready')
        sql(f"UPDATE worker_leads SET email_ready=false WHERE id='{obsolete['lead']}'; DELETE FROM worker_candidates WHERE lead_id='{stale['lead']}';")
        obsolete_claim=next(row for row in data(f"mahshar_worker_mail_claim_recovery('{run_id}','contact')") if row['lead_id']==obsolete['lead'])
        data(f"mahshar_worker_mail_finish_recovery('{obsolete_claim['id']}','contact_enriched')")
        assert json.loads(sql(f"SELECT mail_refresh FROM worker_leads WHERE id='{obsolete['lead']}';"))['lastReason']=='no_email'
        sql(f"UPDATE worker_providers SET status='rejected' WHERE id='{obsolete['provider']}'; DELETE FROM worker_candidates WHERE id='{obsolete_claim['id']}';")
        # Permanent retry state survives cleanup and prevents endless failed refreshes.
        missing = fixture('missing-contact-retry', contact=False)
        for attempt_number in range(1,4):
            sql(f"UPDATE worker_leads SET mail_refresh=coalesce(mail_refresh,'{{}}')- 'retryAfter' WHERE id='{missing['lead']}';")
            claim = data(f"mahshar_worker_mail_claim_recovery('{run_id}','contact')")
            item = next(row for row in claim if row['lead_id']==missing['lead'])
            data(f"mahshar_worker_mail_finish_recovery('{item['id']}','contact_research_temporary_failure')")
            sql(f"DELETE FROM worker_candidates WHERE id='{item['id']}';")
        assert json.loads(sql(f"SELECT mail_refresh FROM worker_leads WHERE id='{missing['lead']}';"))['state'] == 'exhausted'
        assert not any(r['lead_id']==missing['lead'] for r in data(f"mahshar_worker_mail_claim_recovery('{run_id}','contact')"))
        print('PASS: stale email-ready evidence refresh, candidate-independent recovery, replay and bounded failed attempts', flush=True)

        # Intake seeds only permanent identities and assertions. Actual Worker qualification is still required.
        legacy = sql("INSERT INTO discovered_apis(repo_url,api_name) VALUES('https://retained-legacy.example/original','Original legacy name') RETURNING id;")
        original_legacy = snapshot('discovered_apis')
        payload = quote(json.dumps([{'identity':'retained-legacy.example','legacyIds':[legacy], 'providerName':'Retained Legacy',
           'productName':'Retained Legacy API','docsUrl':'https://retained-legacy.example/openapi.json',
           'officialUrl':'https://retained-legacy.example/','csvSha256':'a'*64}])) + '::jsonb'
        dry = data(f"mahshar_worker_mail_seed_legacy({payload})")
        assert dry[0]['disposition']=='legacy_first_pass' and dry[0]['providerId'] is None
        seeded = data(f"mahshar_worker_mail_seed_legacy({payload},false)")[0]
        assert data(f"mahshar_worker_mail_seed_legacy({payload},false)")[0]['disposition']=='already_seeded'
        assert snapshot('discovered_apis') == original_legacy
        lp = seeded['providerId']
        assert sql(f"SELECT count(*) FROM worker_leads WHERE provider_id='{lp}';") == '0'
        assert sql(f"SELECT count(*) FROM worker_contacts WHERE provider_id='{lp}';") == '0'
        assert sql(f"SELECT count(*) FROM admin_worker_mail_registry WHERE provider_id='{lp}';") == '0'
        claim = data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')")
        lc = next(row for row in claim if row['provider_id']==lp)
        assert lc['source_url']=='https://retained-legacy.example/original' and lc['mail_recovery_kind']=='legacy'
        assert data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')")[0]['id']==lc['id']
        assert data("mahshar_worker_mail_discovery_state(ARRAY['retained-legacy.example'])")[0]['reason']=='legacy_intake_retained'
        resolved = data(f"mahshar_worker_resolve_discovery_lead('{lc['id']}','{lc['processing_lease_id']}', 'retained-legacy.example','retained-legacy','Retained Legacy','retained-legacy.example','Retained Legacy API')")
        lead, product = resolved['leadId'], resolved['productId']
        sql(f"""INSERT INTO worker_sources(lead_id,source_type,source_role,url,checked_at)
          VALUES('{lead}','website','official_docs','https://retained-legacy.example/openapi.json',clock_timestamp());
          INSERT INTO worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,verification_status,preferred,email_ready,discovered_at,verified_at)
          VALUES('{lp}','{lead}','email','business@retained-legacy.example','business','https://retained-legacy.example/contact','official_site','verified',true,true,clock_timestamp(),clock_timestamp());
          UPDATE worker_leads SET email_ready=true,preferred_email='business@retained-legacy.example',contactability_status='verified_email' WHERE id='{lead}';""")
        q = quote(json.dumps({'fitScore':90,'commercialApi':True,'agentUtility':'high','payPerCallFit':'high',
           'integrationDifficulty':'low','providerCredibility':'high','reasonCodes':[],'summary':'Synthetic observed API qualification.'}))+'::jsonb'
        def qualification_call(cid, lease, provider, product, lead):
            return f"mahshar_worker_persist_qualification_v2('{run_id}','{cid}','{lease}','{provider}','{product}','{lead}',{q},NULL,'verified_email','fixture-model',true,NULL)"
        assert data(qualification_call(lc['id'],lc['processing_lease_id'],lp,product,lead))['reasonCode']=='qualified'
        data(f"mahshar_worker_mail_finish_recovery('{lc['id']}','qualified')")
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE provider_id='{lp}';") == 'pending'
        sql(f"DELETE FROM worker_qualified_contributions WHERE candidate_id='{lc['id']}'; DELETE FROM worker_candidates WHERE id='{lc['id']}';")
        assert not any(row['provider_id']==lp for row in data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')"))
        assert snapshot('discovered_apis') == original_legacy
        print('PASS: idempotent legacy intake, original identity/source preservation, actual Worker qualification and draft-free enqueue', flush=True)

        more = []
        for n in range(7):
            domain = f'bounded-legacy-{n}.example'
            legacy_id = sql(f"INSERT INTO discovered_apis(repo_url,api_name) VALUES('https://{domain}/original','Legacy fixture') RETURNING id;")
            more.append({'identity':domain,'legacyIds':[legacy_id],'providerName':'Legacy fixture','productName':'Legacy API',
                'docsUrl':f'https://{domain}/openapi.json','officialUrl':f'https://{domain}/','csvSha256':'b'*64})
        more_payload=quote(json.dumps(more))+'::jsonb'
        data(f"mahshar_worker_mail_seed_legacy({more_payload},false)")
        bounded=data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')")
        assert len(bounded)==5
        assert [r['id'] for r in bounded]==[r['id'] for r in data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')")]
        picked_legacy=bounded[0]
        data(f"mahshar_worker_mail_finish_recovery('{picked_legacy['id']}','research_budget_exhausted')")
        assert json.loads(sql(f"SELECT mail_intake FROM worker_providers WHERE id='{picked_legacy['provider_id']}';"))['attempts']==0
        sql(f"UPDATE worker_providers SET status='rejected' WHERE mail_intake IS NOT NULL AND id<>'{picked_legacy['provider_id']}'; DELETE FROM worker_candidates WHERE mail_recovery_kind='legacy';")
        for n in range(3):
            sql(f"UPDATE worker_providers SET mail_intake=mail_intake-'retryAfter' WHERE id='{picked_legacy['provider_id']}';")
            item=data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')")[0]
            data(f"mahshar_worker_mail_finish_recovery('{item['id']}','groq_qualification_failed')")
            sql(f"DELETE FROM worker_candidates WHERE id='{item['id']}';")
        assert json.loads(sql(f"SELECT mail_intake FROM worker_providers WHERE id='{picked_legacy['provider_id']}';"))['state']=='exhausted'
        assert data(f"mahshar_worker_mail_claim_recovery('{run_id}','legacy')")==[]
        original_input=next(row for row in more if row['identity']==picked_legacy['discovered_domain'])
        assert data(f"mahshar_worker_mail_seed_legacy({quote(json.dumps([original_input]))}::jsonb,false)")[0]['disposition']=='already_seeded'
        assert json.loads(sql(f"SELECT mail_intake FROM worker_providers WHERE id='{picked_legacy['provider_id']}';"))['state']=='exhausted'
        new_input={**original_input,'docsUrl':f"https://{picked_legacy['discovered_domain']}/reviewed-openapi.json"}
        new_payload=quote(json.dumps([new_input]))+'::jsonb'
        assert data(f"mahshar_worker_mail_seed_legacy({new_payload})")[0]['disposition']=='legacy_input_changed'
        assert json.loads(sql(f"SELECT mail_intake FROM worker_providers WHERE id='{picked_legacy['provider_id']}';"))['state']=='exhausted'
        data(f"mahshar_worker_mail_seed_legacy({new_payload},false)")
        revised=json.loads(sql(f"SELECT mail_intake FROM worker_providers WHERE id='{picked_legacy['provider_id']}';"))
        assert revised['attempts']==0 and revised['state']=='ready' and len(revised['inputHistory'])==1
        assert revised['inputHistory'][0]['attempts']==3
        print('PASS: five-per-batch legacy intake, resumable claims, budget pause refund, durable retry cap and reviewed input recovery',flush=True)

        # Exercise the ACTUAL historical inversion: claim holds the selected lead while
        # pausing at its attempt INSERT; qualification must wait on its provider,
        # with the claimant already holding provider before lead. Both actual RPCs execute.
        sql("UPDATE worker_providers SET status='rejected';")
        sql('ALTER TABLE worker_sources DISABLE TRIGGER worker_mail_source;')
        inversion = fixture('acquisition-worker-race')
        sql('ALTER TABLE worker_sources ENABLE TRIGGER worker_mail_source;')
        lease = sql('SELECT gen_random_uuid();')
        cid = sql(f"""INSERT INTO worker_candidates(discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,
          discovered_product,provider_id,product_id,lead_id,processing_lease_id)
          VALUES('{run_id}',298,'api_directory','https://directory.example','Fixture','{inversion['domain']}','Verified API',
            '{inversion['provider']}','{inversion['product']}','{inversion['lead']}','{lease}') RETURNING id;""")
        sql("""CREATE FUNCTION test_pause_acquisition_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$;
          CREATE TRIGGER test_pause_acquisition_claim BEFORE INSERT ON admin_acquisition_attempts FOR EACH ROW EXECUTE FUNCTION test_pause_acquisition_claim();""")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            acquiring = pool.submit(data,f"mahshar_acquisition_claim_draft('{run_id}','{epoch}')")
            deadline = time.monotonic()+5
            while time.monotonic()<deadline:
                if sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%mahshar_acquisition_claim_draft%';")!='0': break
                time.sleep(0.02)
            else: raise AssertionError('Actual Acquisition claim did not reach its lead-held INSERT pause')
            failure(f"SELECT 1 FROM worker_providers WHERE id='{inversion['provider']}' FOR UPDATE NOWAIT;", 'could not obtain lock')
            failure(f"SELECT 1 FROM worker_leads WHERE id='{inversion['lead']}' FOR UPDATE NOWAIT;", 'could not obtain lock')
            saving = pool.submit(data,qualification_call(cid,lease,inversion['provider'],inversion['product'],inversion['lead']))
            deadline=time.monotonic()+0.6
            while time.monotonic()<deadline:
                if sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%mahshar_worker_persist_qualification_v2%';")!='0': break
                time.sleep(0.02)
            else: raise AssertionError('Concurrent Worker save did not wait on the provider lock')
            assert acquiring.result(timeout=5)['providerId']==inversion['provider']
            assert saving.result(timeout=5)['reasonCode']=='qualified'
        sql('DROP TRIGGER test_pause_acquisition_claim ON admin_acquisition_attempts; DROP FUNCTION test_pause_acquisition_claim();')
        # A rolled-back enqueue leaves neither ownership nor an excluded tombstone.
        rollback = fixture('rollback-and-retry')
        mid = sql(f"SELECT id FROM admin_worker_mail_registry WHERE provider_id='{rollback['provider']}';")
        failure(f"BEGIN; SELECT mahshar_worker_mail_mark_sent('{mid}','0x1111111111111111111111111111111111111111'); DO $$ BEGIN RAISE EXCEPTION 'interrupted_mail'; END $$; COMMIT;",'interrupted_mail')
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE id='{mid}';")=='pending'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(data,f"mahshar_worker_mail_reconcile(p_dry_run=>false,p_provider_ids=>ARRAY['{rollback['provider']}']::uuid[])"),
                     pool.submit(data,f"mahshar_worker_mail_mark_sent('{mid}','0x1111111111111111111111111111111111111111')")]
            for future in futures: future.result(timeout=5)
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE id='{mid}';")=='manual_sent'
        print('PASS: actual Acquisition claim versus Worker save lock interleaving, enqueue versus mark, interrupted transaction rollback and retry', flush=True)
        # Internal intake retries cannot leak into the older unlimited deferred claim path.
        sql(f"INSERT INTO worker_candidates(discovery_batch_id,ordinal,mail_recovery_kind,source_type,source_url,discovered_name,discovered_domain,discovered_product,discovered_docs_url,status,reason_code) VALUES('{run_id}',305,'legacy','api_directory','https://retained-incomplete.example/original','Retained incomplete','retained-incomplete.example','Retained API','https://retained-incomplete.example/openapi.json','deferred','research_budget_exhausted'); UPDATE worker_runs SET status='stopped' WHERE id='{run_id}';")
        next_run=sql('SELECT (mahshar_worker_create_target_run(false)).id;')
        sql(f"UPDATE worker_runs SET status='running' WHERE id='{next_run}';")
        assert sql(f"SELECT count(*) FROM mahshar_worker_claim_deferred_candidates('{next_run}','exclude-internal',5);")=='0'
        print('PASS: retained intake cannot bypass bounded retries through ordinary deferred claims',flush=True)
        # Exercise the actual existing lifecycle RPCs with the new migration
        # installed, not only source-contract assertions or the 44-file baseline.
        advanced = data(f"mahshar_worker_advance_target_run('{next_run}',0,10,10,0,0,0,0,0,0,0,false,false,false)")
        assert advanced['status']=='running' and advanced['checkpoint']['nextIndex']==10
        assert data('mahshar_worker_request_stop()')['status']=='stop_requested'
        stopped = data(f"mahshar_worker_advance_target_run('{next_run}',10,10,0,0,0,0,0,0,0,0,false,false,false)")
        assert stopped['status']=='stopped' and stopped['checkpoint']['nextIndex']==10
        resumed = data('mahshar_worker_create_target_run(true)')
        assert resumed['status']=='queued' and resumed['discovery_batch_id']==next_run
        assert resumed['checkpoint']==stopped['checkpoint'] and resumed['processed_count']==10
        assert resumed['research_fetch_count']==stopped['research_fetch_count']
        assert sql(f"SELECT status FROM admin_worker_mail_registry WHERE id='{mid}';")=='manual_sent'
        print('PASS: actual post-migration Start/Stop/Resume RPCs preserve checkpoint, batch, budgets and permanent manual history',flush=True)


    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', socket / 'data', '-m', 'immediate', '-w', 'stop'])
