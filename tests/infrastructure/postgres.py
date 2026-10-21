"""Offline, disposable PostgreSQL admission/concurrency/retention verification. No TCP."""
import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
configured = os.environ.get('MAHSHAR_PG_BIN')
BIN = pathlib.Path(configured) if configured else pathlib.Path('/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin')
if not BIN.is_dir():
    found = shutil.which('initdb')
    if not found:
        raise RuntimeError('Set MAHSHAR_PG_BIN to an installed PostgreSQL bin directory')
    BIN = pathlib.Path(found).parent
ENV = dict(os.environ)
library = BIN.parents[2] / 'x86_64-linux-gnu'
if library.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(library)

with tempfile.TemporaryDirectory(prefix='mahshar-resource-test-') as temporary:
    root = pathlib.Path(temporary)
    data = root / 'data'
    def run(args, **kwargs):
        return subprocess.run([str(arg) for arg in args], env=ENV, text=True,
                              capture_output=True, check=True, timeout=45, **kwargs)
    run([BIN / 'initdb', '-D', data, '-U', 'resource_test', '-A', 'trust', '--no-sync'])
    started = False
    checks = 0
    try:
        run([BIN / 'pg_ctl', '-D', data, '-l', root / 'postgres.log', '-o',
             f"-k {root} -p 55469 -c listen_addresses=''", '-w', 'start'])
        started = True
        def sql(statement):
            try:
                return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', root,
                            '-p', '55469', '-U', 'resource_test', '-d', 'postgres'], input=statement).stdout.strip()
            except subprocess.CalledProcessError as error:
                raise RuntimeError(error.stderr) from error
        def check(condition):
            global checks
            assert condition
            checks += 1
        def denied(statement):
            try:
                sql(statement)
            except RuntimeError:
                check(True)
                return
            raise AssertionError('Expected denied operation')
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role;')
        for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql'), key=lambda p: p.name.split('_', 1)[0]):
            sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')
        check(True)  # full canonical historical chain plus this one additive migration
        # Non-empty synthetic financial/replay/recovery history, including old
        # records. Operational pruning must preserve every other public table.
        sql("""
          INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,endpoint_url)
          VALUES('00000000-0000-4000-8000-000000000001','Fixture','Fixture','test',0.001,'pay-per-call','0x2222222222222222222222222222222222222222','public','https://fixture.invalid');
          INSERT INTO x402_settlement_attempts(id,fingerprint,authorization_key,api_id,binding,created_at,updated_at)
          VALUES('00000000-0000-4000-8000-000000000002',repeat('a',64),repeat('b',64),'00000000-0000-4000-8000-000000000001','{}',now()-interval '90 days',now()-interval '90 days');
          INSERT INTO purchases(id,buyer_wallet,api_id,amount_usdc,tx_hash,created_at)
          VALUES('00000000-0000-4000-8000-000000000003','0x1111111111111111111111111111111111111111','00000000-0000-4000-8000-000000000001',0.001,'offline-fixture',now()-interval '90 days');
          INSERT INTO api_calls(api_id,buyer_wallet,payment_type,latency_ms,success,purchase_id,delivery_attempt_id,response_body,response_expires_at,created_at)
          VALUES('00000000-0000-4000-8000-000000000001','0x1111111111111111111111111111111111111111','pay-per-call',1,true,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','{"fixture":"recovery"}',now()-interval '80 days',now()-interval '90 days');
          INSERT INTO withdraw_used_nonces(nonce,seller_wallet,created_at)
          VALUES('offline-replay-fixture','0x2222222222222222222222222222222222222222',now()-interval '90 days');
          INSERT INTO seller_withdrawals(seller_wallet,network_id,amount_usdc,net_amount_usdc,gas_cost_usdc,burn_intent,status,created_at)
          VALUES('0x2222222222222222222222222222222222222222','eip155:5042',1,1,0,'{}','pending_mint',now()-interval '90 days');
        """)
        protected = sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('resource_budget_buckets','resource_budget_leases','mahshar_rate_limits') ORDER BY tablename;").splitlines()
        def snapshots():
            return {table: sql(f'SELECT md5(coalesce(string_agg(to_jsonb(t)::text,\'\' ORDER BY to_jsonb(t)::text),\'\')) FROM public."{table}" t;') for table in protected}
        original = snapshots()
        for table in ('purchases','api_calls','withdraw_used_nonces','seller_withdrawals','x402_settlement_attempts'):
            check(int(sql(f'SELECT count(*) FROM public.{table};')) > 0)
        sql("INSERT INTO public.mahshar_rate_limits VALUES(repeat('f',64), now()-interval '3 days', 1);")
        check(sql('SELECT rate_limits FROM public.mahshar_prune_resource_records(1);') == '0')
        sql((ROOT / 'scripts/infrastructure/rate-limit-retention-index.sql').read_text())
        check(sql('SELECT rate_limits FROM public.mahshar_prune_resource_records(1);') == '1')
        def bucket(scope, requests=10, units=100, window=86400):
            return dict(scope=scope, window_seconds=window, request_limit=requests, unit_limit=units)
        def reserve(buckets, units=1, lease=None, concurrency=0, role='service_role'):
            # Fixtures only; no untrusted input or Production connection string.
            encoded = json.dumps(buckets)
            lease_sql = 'NULL' if lease is None else "'" + lease + "'"
            return json.loads(sql(f"SET ROLE {role}; SELECT row_to_json(r) FROM public.mahshar_reserve_resource('{encoded}'::jsonb,{units},{lease_sql},{concurrency}) r;"))

        # Atomic shared caps: rotating feature/wallet identities still consume the same bucket.
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(lambda i: reserve([bucket('shared', 7), bucket(f'wallet:{i}', 20)]), range(40)))
        check(sum(row['allowed'] for row in results) == 7)
        check(sql("SELECT requests FROM public.resource_budget_buckets WHERE scope='shared'") == '7')
        check(sql("SELECT count(*) FROM public.resource_budget_buckets WHERE scope LIKE 'wallet:%'") == '7')
        check(not reserve([bucket('too-small', units=1)], units=2)['allowed'])
        check(sql("SELECT count(*) FROM public.resource_budget_buckets WHERE scope='too-small'") == '0')
        check(reserve([bucket('tokens', units=10)], units=7)['allowed'])
        check(not reserve([bucket('tokens', units=10)], units=4)['allowed'])
        check(sql("SELECT units FROM public.resource_budget_buckets WHERE scope='tokens'") == '7')

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            leases = list(pool.map(lambda _: reserve([bucket('leased', 100)], lease='groq:all', concurrency=3), range(20)))
        check(sum(row['allowed'] for row in leases) == 3)
        lease_id = next(row['lease_id'] for row in leases if row['allowed'])
        sql(f"SET ROLE service_role; SELECT public.mahshar_release_resource('{lease_id}');")
        check(reserve([bucket('leased', 100)], lease='groq:all', concurrency=3)['allowed'])
        sql("UPDATE public.resource_budget_leases SET expires_at=now()-interval '1 second';")
        check(reserve([bucket('leased', 100)], lease='groq:all', concurrency=3)['allowed'])
        # Expired leases release slots but never refund consumed request/token reservations.
        check(sql("SELECT requests FROM public.resource_budget_buckets WHERE scope='leased'") == '5')
        sql("UPDATE public.resource_budget_buckets SET bucket_start=now()-interval '3 days',expires_at=now()-interval '2 days' WHERE scope='tokens';")
        check(reserve([bucket('tokens', units=10)], units=7)['allowed'])

        for role in ('anon', 'authenticated'):
            denied(f"SET ROLE {role}; SELECT * FROM public.resource_budget_buckets;")
            denied(f"SET ROLE {role}; INSERT INTO public.resource_budget_leases(scope,expires_at) VALUES('abuse', now());")
            denied(f"SET ROLE {role}; SELECT public.mahshar_reserve_resource('[]'::jsonb);")
            denied(f"SET ROLE {role}; SELECT public.mahshar_release_resource(gen_random_uuid());")
            denied(f"SET ROLE {role}; SELECT public.mahshar_prune_resource_records(1);")
        for args in ([], [bucket('a'), bucket('a')], [bucket('bad/scope')], [bucket('window', window=2)], [bucket('zero', requests=0)]):
            denied(f"SELECT * FROM public.mahshar_reserve_resource('{json.dumps(args)}'::jsonb);")
        denied("SELECT * FROM public.mahshar_reserve_resource('[{}]'::jsonb);")
        denied("SELECT * FROM public.mahshar_prune_resource_records(1001);")

        sql("INSERT INTO public.mahshar_rate_limits VALUES(repeat('a',64), now()-interval '3 days', 1),(repeat('b',64), now(), 1);")
        before = int(sql('SELECT count(*) FROM public.resource_budget_leases;'))
        cleaned = json.loads(sql('SET ROLE service_role; SELECT row_to_json(r) FROM public.mahshar_prune_resource_records(1) r;'))
        check(cleaned == dict(budgets=1, leases=1, rate_limits=1))
        check(int(sql('SELECT count(*) FROM public.resource_budget_leases;')) == before - 1)
        check(sql('SELECT count(*) FROM public.mahshar_rate_limits;') == '1')
        check(sql("SELECT count(*) FROM public.resource_budget_buckets WHERE scope='tokens'") == '1')
        check(sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.resource_budget_buckets'::regclass") == 't')
        sql('SET ROLE service_role;\n' + (ROOT / 'scripts/infrastructure/resource-health.sql').read_text())
        check(True)
        check(snapshots() == original)
        print(f'PASS: {checks} PostgreSQL checks; atomic requests/tokens, 40-client rotation, 20-client concurrency, lease expiry, RLS/grants, retention.')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
