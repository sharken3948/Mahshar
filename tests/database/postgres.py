"""Fresh-schema and concurrency checks in a disposable socket-only PostgreSQL."""
import concurrent.futures
import decimal
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]

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
    local_canary = pathlib.Path('/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin')
    if not local_canary.is_dir():
        raise RuntimeError('PostgreSQL tools not found; install PostgreSQL or set MAHSHAR_PG_BIN')
    BIN = local_canary

ENV = dict(os.environ)
bundled_lib = BIN.parents[2] / 'x86_64-linux-gnu'
if bundled_lib.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(bundled_lib)

with tempfile.TemporaryDirectory(prefix='mahshar-schema-test-') as temporary:
    root = pathlib.Path(temporary)
    data = root / 'data'

    def run(args, **kwargs):
        return subprocess.run([str(value) for value in args], env=ENV, check=True, text=True,
                              capture_output=True, timeout=45, **kwargs)

    run([BIN / 'initdb', '-D', data, '-U', 'schema_test', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', data, '-l', root / 'postgres.log', '-o',
             f"-k {root} -p 55461 -c listen_addresses=''", '-w', 'start'])
        started = True

        def sql(statement):
            return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', root, '-p', '55461',
                        '-U', 'schema_test', '-d', 'postgres'], input=statement).stdout.strip()

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
        ]
        repair_versions = ['20261001000000', '20261001000030']
        pre_repair_migrations = [
            migration for migration in migrations
            if migration.name.split('_', 1)[0] not in repair_versions
        ]
        repair_migrations = [
            migration for migration in migrations
            if migration.name.split('_', 1)[0] in repair_versions
        ]
        assert [migration.name.split('_', 1)[0] for migration in repair_migrations] == repair_versions
        for migration in pre_repair_migrations:
            sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')

        drift_inactive_listing = '00000000-0000-4000-8000-000000000011'
        drift_active_listing = '00000000-0000-4000-8000-000000000012'
        drift_call = '00000000-0000-4000-8000-000000000021'
        drift_seller = '0x' + 'c' * 40
        drift_buyer = '0x' + 'd' * 40
        sql(f"""
          INSERT INTO public.api_listings(
            id,name,description,category,price_per_call,payment_model,
            seller_wallet,auth_type,endpoint_url
          ) VALUES(
            '{drift_inactive_listing}','repair inactive','fixture','test',1,
            'pay-per-call','{drift_seller}','public','https://example.com/inactive'
          );
          INSERT INTO public.api_listings(
            id,name,description,category,price_per_call,payment_model,
            seller_wallet,auth_type,endpoint_url,is_active
          ) VALUES(
            '{drift_active_listing}','repair active','fixture','test',1,
            'pay-per-call','{drift_seller}','public','https://example.com/active',true
          );
          INSERT INTO public.api_calls(
            id,api_id,buyer_wallet,payment_type,latency_ms,success
          ) VALUES(
            '{drift_call}','{drift_inactive_listing}','{drift_buyer}',
            'pay-per-call',1,false
          );

          ALTER TABLE public.api_calls
            ALTER COLUMN is_declared_expected DROP NOT NULL,
            ALTER COLUMN is_declared_expected DROP DEFAULT;
          UPDATE public.api_calls
          SET is_declared_expected = NULL
          WHERE id = '{drift_call}';

          ALTER TABLE public.api_listings
            ALTER COLUMN is_active SET DEFAULT true;
        """)

        column_state = lambda table, column: sql(
            "SELECT is_nullable||'|'||coalesce(column_default,'NULL') "
            "FROM information_schema.columns "
            f"WHERE table_schema='public' AND table_name='{table}' AND column_name='{column}';"
        )
        listing_values = lambda: sql(
            "SELECT string_agg(id::text||':'||is_active::text,',' ORDER BY id) "
            "FROM public.api_listings;"
        )

        calls_before = sql('SELECT count(*) FROM public.api_calls;')
        nulls_before = sql('SELECT count(*) FROM public.api_calls WHERE is_declared_expected IS NULL;')
        call_column_before = column_state('api_calls', 'is_declared_expected')
        listings_before = sql('SELECT count(*) FROM public.api_listings;')
        listing_values_before = listing_values()
        listing_column_before = column_state('api_listings', 'is_active')
        assert (calls_before, nulls_before, call_column_before) == ('1', '1', 'YES|NULL')
        assert (listings_before, listing_column_before) == ('2', 'NO|true')
        assert listing_values_before == (
            f'{drift_inactive_listing}:false,{drift_active_listing}:true'
        )

        # Each migration must remain atomic when the migration runner wraps it
        # in a transaction. The injected error occurs after the actual file.
        try:
            sql('BEGIN;\n' + repair_migrations[0].read_text() + '\nSELECT 1 / 0;\nCOMMIT;')
            raise AssertionError('api_calls repair transaction unexpectedly committed')
        except subprocess.CalledProcessError as error:
            assert 'division by zero' in error.stderr
        assert sql('SELECT count(*) FROM public.api_calls WHERE is_declared_expected IS NULL;') == '1'
        assert column_state('api_calls', 'is_declared_expected') == 'YES|NULL'

        try:
            sql('BEGIN;\n' + repair_migrations[1].read_text() + '\nSELECT 1 / 0;\nCOMMIT;')
            raise AssertionError('api_listings repair transaction unexpectedly committed')
        except subprocess.CalledProcessError as error:
            assert 'division by zero' in error.stderr
        assert column_state('api_listings', 'is_active') == 'NO|true'
        assert listing_values() == listing_values_before

        for migration in repair_migrations:
            sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')

        calls_after = sql('SELECT count(*) FROM public.api_calls;')
        nulls_after = sql('SELECT count(*) FROM public.api_calls WHERE is_declared_expected IS NULL;')
        call_column_after = column_state('api_calls', 'is_declared_expected')
        listings_after = sql('SELECT count(*) FROM public.api_listings;')
        listing_values_after = listing_values()
        listing_column_after = column_state('api_listings', 'is_active')
        repaired_call_value = sql(
            f"SELECT is_declared_expected FROM public.api_calls WHERE id='{drift_call}';"
        )
        assert (calls_after, nulls_after, call_column_after, repaired_call_value) == (
            calls_before, '0', 'NO|false', 'f'
        )
        assert (listings_after, listing_column_after, listing_values_after) == (
            listings_before, 'NO|false', listing_values_before
        )

        def assert_columns(table, expected):
            actual = sql(f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position;").splitlines()
            assert actual == expected, (table, actual)

        def assert_rls(table):
            assert sql(f"SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass;") == 't'

        def assert_security_definer(signature):
            assert sql(f"SELECT prosecdef FROM pg_proc WHERE oid='public.{signature}'::regprocedure;") == 't'
            assert sql(f"SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid='public.{signature}'::regprocedure;") == 'search_path=pg_catalog, public'

        assert_columns('api_listings', [
            'id', 'name', 'description', 'category', 'price_per_call',
            'payment_model', 'seller_wallet', 'auth_type', 'encrypted_key',
            'auth_param_name', 'endpoint_url', 'example_request',
            'example_response', 'score', 'uptime', 'created_at', 'is_active',
            'source', 'hourly_limit', 'latency_ms', 'request_schema',
            'response_schema', 'body_required', 'dynamic_path_supported',
            'path_parameters', 'query_parameters', 'method', 'verified_at',
            'expected_status_codes', 'consecutive_transient_count',
        ])
        assert sql("SELECT is_nullable||'|'||column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='api_listings' AND column_name='is_active';") == 'NO|false'
        assert 'queryparam' in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.api_listings'::regclass AND conname='api_listings_auth_type_check';")
        assert sql("SELECT count(*) FROM pg_policy WHERE polrelid='public.api_listings'::regclass;") == '0'
        assert_rls('api_listings')
        for role in ['anon', 'authenticated']:
            assert sql(f"SELECT has_table_privilege('{role}','public.api_listings','SELECT');") == 'f'
        expected_listing_constraints = {
            'api_listings_request_schema_object',
            'api_listings_response_schema_object',
            'api_listings_path_parameters_array',
            'api_listings_query_parameters_array',
            'api_listings_expected_status_codes_safe',
        }
        actual_listing_constraints = set(sql("SELECT conname FROM pg_constraint WHERE conrelid='public.api_listings'::regclass AND conname LIKE 'api_listings_%' AND conname NOT IN ('api_listings_pkey','api_listings_payment_model_check','api_listings_auth_type_check');").splitlines())
        assert expected_listing_constraints == actual_listing_constraints, actual_listing_constraints
        assert sql("SELECT convalidated FROM pg_constraint WHERE conrelid='public.api_listings'::regclass AND conname='api_listings_expected_status_codes_safe';") == 't'

        assert_columns('api_calls', [
            'id', 'api_id', 'buyer_wallet', 'payment_type', 'latency_ms',
            'success', 'created_at', 'is_client_error', 'is_declared_expected',
            'response_body', 'purchase_id', 'delivery_attempt_id',
            'response_expires_at',
        ])
        assert sql("SELECT is_nullable||'|'||column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='api_calls' AND column_name='is_declared_expected';") == 'NO|false'
        for column in ['purchase_id', 'delivery_attempt_id', 'response_body', 'response_expires_at']:
            assert sql(f"SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='api_calls' AND column_name='{column}';") == '1'
        assert 'REFERENCES purchases(id)' in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.api_calls'::regclass AND conname='api_calls_purchase_id_fkey';")
        assert 'REFERENCES x402_settlement_attempts(id)' in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.api_calls'::regclass AND conname='api_calls_delivery_attempt_id_fkey';")

        assert_columns('x402_settlement_attempts', [
            'id', 'fingerprint', 'authorization_key', 'api_id', 'binding',
            'state', 'submission_token', 'submitted_at', 'transaction_id',
            'settlement_identity', 'purchase_id', 'reason', 'created_at',
            'updated_at', 'delivery_state', 'delivery_request_hash',
            'delivery_token', 'delivery_started_at', 'delivery_completed_at',
            'delivery_http_status', 'delivery_error_code',
        ])
        assert_rls('x402_settlement_attempts')
        for index in ['x402_attempts_incomplete', 'x402_attempts_incomplete_delivery']:
            assert sql(f"SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='x402_settlement_attempts' AND indexname='{index}';") == '1'
        x402_functions = [
            'x402_prepare(jsonb)', 'x402_claim(uuid,uuid)',
            'x402_confirm(uuid,uuid,text)', 'x402_unknown(uuid,uuid,text)',
            'x402_recover(uuid)', 'x402_delivery_claim(uuid,uuid,text)',
            'x402_delivery_complete(uuid,uuid,text,integer,text)',
        ]
        for signature in x402_functions:
            assert_security_definer(signature)
            assert sql(f"SELECT has_function_privilege('service_role','public.{signature}','EXECUTE');") == 't'
            for role in ['anon', 'authenticated']:
                assert sql(f"SELECT has_function_privilege('{role}','public.{signature}','EXECUTE');") == 'f'

        assert_columns('seller_withdrawals', [
            'id', 'seller_wallet', 'network_id', 'amount_usdc',
            'net_amount_usdc', 'gas_cost_usdc', 'burn_intent', 'attestation',
            'attestation_signature', 'status', 'mint_tx_hash', 'created_at',
            'minted_at', 'gateway_transfer_id', 'gateway_submitted_at',
            'last_error',
        ])
        for column in ['gateway_transfer_id', 'gateway_submitted_at', 'last_error']:
            assert sql(f"SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_withdrawals' AND column_name='{column}';") == '1'
        assert_rls('seller_withdrawals')
        assert sql("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_withdrawals' AND column_name='attestation';") == 'YES'
        withdrawal_status = sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.seller_withdrawals'::regclass AND conname='seller_withdrawals_status_check';")
        assert 'submission_unknown' in withdrawal_status and 'mint_unknown' in withdrawal_status
        for index in [
            'idx_seller_withdrawals_seller', 'idx_seller_withdrawals_status',
            'idx_seller_withdrawals_mint_tx',
            'seller_withdrawals_gateway_transfer_id_unique',
            'uniq_seller_withdrawals_in_flight',
        ]:
            assert sql(f"SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='seller_withdrawals' AND indexname='{index}';") == '1'
        assert sql("SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_seller_withdrawals_pending_mint';") == '0'
        assert_security_definer('mahshar_reserve_seller_withdrawal(text,numeric,text)')

        for table in ['wallet_auth_challenges', 'wallet_sessions']:
            assert sql(f"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='{table}';") == '1'
            assert_rls(table)
            assert sql(f"SELECT has_table_privilege('anon','public.{table}','SELECT');") == 'f'
            assert sql(f"SELECT has_table_privilege('authenticated','public.{table}','SELECT');") == 'f'
            assert sql(f"SELECT has_table_privilege('service_role','public.{table}','INSERT');") == 't'
        for index in ['wallet_auth_challenges_expiry', 'wallet_sessions_expiry', 'wallet_sessions_wallet_active']:
            assert sql(f"SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='{index}';") == '1'

        assert_columns('mahshar_rate_limits', ['key_hash', 'bucket_start', 'request_count'])
        assert_rls('mahshar_rate_limits')
        for signature in ['mahshar_take_rate_limit(text,integer,integer)', 'mahshar_take_rate_limits(jsonb)']:
            assert_security_definer(signature)
            assert sql(f"SELECT has_function_privilege('service_role','public.{signature}','EXECUTE');") == 't'
            for role in ['anon', 'authenticated']:
                assert sql(f"SELECT has_function_privilege('{role}','public.{signature}','EXECUTE');") == 'f'

        assert sql("SELECT has_function_privilege('service_role','public.mahshar_reserve_seller_withdrawal(text,numeric,text)','EXECUTE');") == 't'
        assert sql("SELECT has_function_privilege('service_role','public.mahshar_take_rate_limits(jsonb)','EXECUTE');") == 't'
        assert sql("SELECT has_function_privilege('service_role','public.mahshar_prune_wallet_auth(integer)','EXECUTE');") == 't'
        assert_security_definer('mahshar_prune_wallet_auth(integer)')
        for role in ['anon', 'authenticated']:
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_reserve_seller_withdrawal(text,numeric,text)','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_take_rate_limits(jsonb)','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_prune_wallet_auth(integer)','EXECUTE');") == 'f'

        sql(f"""
          DELETE FROM public.api_calls WHERE id='{drift_call}';
          DELETE FROM public.api_listings
          WHERE id IN ('{drift_inactive_listing}','{drift_active_listing}');
        """)

        api = '00000000-0000-4000-8000-000000000010'
        seller = '0x' + 'a' * 40
        buyer = '0x' + 'b' * 40
        sql(f"""
          INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,endpoint_url)
          VALUES('{api}','concurrency','fixture','test',1,'pay-per-call','{seller}','public','https://example.com');
          INSERT INTO purchases(buyer_wallet,api_id,amount_usdc,seller_share_usdc,tx_hash)
          VALUES('{buyer}','{api}',5,5,'withdraw-concurrency-earning');
        """)

        statement = f"""
          SET ROLE service_role;
          BEGIN;
          SELECT (public.mahshar_reserve_seller_withdrawal('{seller}',4,'eip155:5042')).id;
          SELECT pg_sleep(1);
          COMMIT;
        """
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(sql, statement) for _ in range(2)]
            outcomes = []
            for future in futures:
                try:
                    outcomes.append(('ok', future.result()))
                except subprocess.CalledProcessError as error:
                    outcomes.append(('error', error.stderr))
        assert [kind for kind, _ in outcomes].count('ok') == 1, outcomes
        assert [kind for kind, _ in outcomes].count('error') == 1, outcomes
        assert sql(f"SELECT count(*) FROM seller_withdrawals WHERE lower(seller_wallet)='{seller}' AND status='pending_mint';") == '1'
        assert sql(f"SELECT coalesce(sum(amount_usdc),0) FROM seller_withdrawals WHERE lower(seller_wallet)='{seller}' AND status IN ('pending_mint','submission_unknown','mint_unknown','minted','failed');") == '4'
        sql(f"UPDATE seller_withdrawals SET status='submission_unknown',created_at=now()-interval '2 minutes' WHERE lower(seller_wallet)='{seller}';")
        try:
            sql(f"SET ROLE service_role; SELECT (public.mahshar_reserve_seller_withdrawal('{seller}',2,'eip155:5042')).id;")
            raise AssertionError('unknown reservation earnings were reused')
        except subprocess.CalledProcessError as error:
            assert 'insufficient withdrawal balance' in error.stderr

        wallet_key = 'a' * 64
        ip_key = 'b' * 64
        buckets = json.dumps([
            {'key_hash': wallet_key, 'limit': 2, 'window_seconds': 60},
            {'key_hash': ip_key, 'limit': 3, 'window_seconds': 60},
        ])
        limits = [sql(f"SET ROLE service_role; SELECT allowed FROM public.mahshar_take_rate_limits('{buckets}'::jsonb);") for _ in range(3)]
        assert limits == ['t', 't', 'f'], limits

        purchase_count = sql('SELECT count(*) FROM purchases;')
        sql(f"""
          INSERT INTO api_calls(api_id,buyer_wallet,payment_type,latency_ms,success,response_body,response_expires_at)
          VALUES
            ('{api}','{buyer}','pay-per-call',1,true,'{{\"expired\":1}}',now()-interval '3 days'),
            ('{api}','{buyer}','pay-per-call',1,true,'{{\"expired\":2}}',now()-interval '2 days'),
            ('{api}','{buyer}','pay-per-call',1,true,'{{\"expired\":3}}',now()-interval '1 day'),
            ('{api}','{buyer}','pay-per-call',1,true,'{{\"live\":true}}',now()+interval '1 day');
        """)
        assert sql("SET ROLE service_role; SELECT public.mahshar_prune_api_call_responses(2);") == '2'
        assert sql("SELECT count(*) FROM api_calls WHERE response_body IS NULL;") == '2'
        assert sql("SELECT count(*) FROM api_calls WHERE response_body IS NOT NULL AND response_expires_at>now();") == '1'
        assert sql('SELECT count(*) FROM purchases;') == purchase_count
        assert sql("SET ROLE service_role; SELECT public.mahshar_prune_api_call_responses(2);") == '1'
        assert sql("SET ROLE service_role; SELECT public.mahshar_prune_api_call_responses(2);") == '0'
        assert sql("SELECT count(*) FROM api_calls;") == '4'

        sql(f"""
          INSERT INTO wallet_auth_challenges(id,wallet,nonce_hash,issued_at,expires_at) VALUES
            ('00000000-0000-4000-8000-000000000101','{seller}','{'1' * 64}',now()-interval '2 minutes',now()-interval '1 minute'),
            ('00000000-0000-4000-8000-000000000102','{seller}','{'2' * 64}',now(),now()+interval '5 minutes');
          INSERT INTO wallet_sessions(id,token_hash,wallet,created_at,expires_at) VALUES
            ('00000000-0000-4000-8000-000000000201','{'3' * 64}','{seller}',now()-interval '9 hours',now()-interval '1 hour'),
            ('00000000-0000-4000-8000-000000000202','{'4' * 64}','{seller}',now(),now()+interval '8 hours');
        """)
        auth_prune = "SET ROLE service_role; WITH pruned AS (SELECT public.mahshar_prune_wallet_auth(1) result) SELECT (result->>'challenges')||','||(result->>'sessions') FROM pruned;"
        assert sql(auth_prune) == '1,1'
        assert sql("SELECT count(*) FROM wallet_auth_challenges WHERE expires_at>now();") == '1'
        assert sql("SELECT count(*) FROM wallet_sessions WHERE expires_at>now() AND revoked_at IS NULL;") == '1'
        assert sql(auth_prune) == '0,0'

        topup = f"SET ROLE service_role; SELECT public.topup_credits_atomic('{buyer}',2);"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            topups = [future.result() for future in [pool.submit(sql, topup), pool.submit(sql, topup)]]
        assert all('"ok" : true' in result for result in topups), topups
        assert decimal.Decimal(sql(f"SELECT balance_usdc FROM credit_balances WHERE buyer_wallet='{buyer}';")) == decimal.Decimal(4)

        credit_tx = 'credit-atomic-purchase'
        deduct = f"SET ROLE service_role; SELECT public.deduct_credits_and_record_purchase('{buyer}',1,'{api}','{credit_tx}');"
        assert '"ok" : true' in sql(deduct)
        assert decimal.Decimal(sql(f"SELECT balance_usdc FROM credit_balances WHERE buyer_wallet='{buyer}';")) == decimal.Decimal(3)
        assert sql(f"SELECT count(*) FROM purchases WHERE tx_hash='{credit_tx}';") == '1'
        try:
            sql(deduct)
            raise AssertionError('duplicate purchase unexpectedly succeeded')
        except subprocess.CalledProcessError:
            pass
        assert decimal.Decimal(sql(f"SELECT balance_usdc FROM credit_balances WHERE buyer_wallet='{buyer}';")) == decimal.Decimal(3)

        print(
            'PASS: production-like drift repaired transactionally; '
            f'api_calls rows {calls_before}->{calls_after}, nulls {nulls_before}->{nulls_after}, '
            f'column {call_column_before}->{call_column_after}; '
            f'api_listings rows {listings_before}->{listings_after}, '
            f'column {listing_column_before}->{listing_column_after}, values preserved'
        )
        print('PASS: fresh schema, wallet sessions/pruning, concurrent/unknown withdrawal accounting, independent rate limits, bounded response pruning, and atomic credits')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
