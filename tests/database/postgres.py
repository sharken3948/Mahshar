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
        sql((ROOT / 'supabase/schema.sql').read_text())
        for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
            sql(migration.read_text())

        assert sql("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='api_listings' AND column_name='is_active';") == 'false'
        for column in ['purchase_id', 'delivery_attempt_id', 'response_body', 'response_expires_at']:
            assert sql(f"SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='api_calls' AND column_name='{column}';") == '1'
        for column in ['gateway_transfer_id', 'gateway_submitted_at', 'last_error']:
            assert sql(f"SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_withdrawals' AND column_name='{column}';") == '1'
        for table in ['wallet_auth_challenges', 'wallet_sessions']:
            assert sql(f"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='{table}';") == '1'
            assert sql(f"SELECT has_table_privilege('anon','public.{table}','SELECT');") == 'f'
            assert sql(f"SELECT has_table_privilege('authenticated','public.{table}','SELECT');") == 'f'
            assert sql(f"SELECT has_table_privilege('service_role','public.{table}','INSERT');") == 't'
        assert sql("SELECT has_function_privilege('service_role','public.mahshar_reserve_seller_withdrawal(text,numeric,text)','EXECUTE');") == 't'
        assert sql("SELECT has_function_privilege('service_role','public.mahshar_take_rate_limits(jsonb)','EXECUTE');") == 't'
        assert sql("SELECT has_function_privilege('service_role','public.mahshar_prune_wallet_auth(integer)','EXECUTE');") == 't'
        assert sql("SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid='public.mahshar_prune_wallet_auth(integer)'::regprocedure;") == 'search_path=pg_catalog, public'
        for role in ['anon', 'authenticated']:
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_reserve_seller_withdrawal(text,numeric,text)','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_take_rate_limits(jsonb)','EXECUTE');") == 'f'
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_prune_wallet_auth(integer)','EXECUTE');") == 'f'

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

        print('PASS: fresh schema, wallet sessions/pruning, concurrent/unknown withdrawal accounting, independent rate limits, bounded response pruning, and atomic credits')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
