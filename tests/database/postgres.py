"""Fresh-schema and concurrency checks in a disposable socket-only PostgreSQL."""
import concurrent.futures
import decimal
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
        assert sql("SELECT has_function_privilege('service_role','public.mahshar_reserve_seller_withdrawal(text,numeric,text)','EXECUTE');") == 't'
        for role in ['anon', 'authenticated']:
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_reserve_seller_withdrawal(text,numeric,text)','EXECUTE');") == 'f'

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
        assert sql(f"SELECT coalesce(sum(amount_usdc),0) FROM seller_withdrawals WHERE lower(seller_wallet)='{seller}' AND status IN ('pending_mint','minted','failed');") == '4'

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

        print('PASS: fresh schema, concurrent withdrawal reservation, and atomic credit accounting')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
