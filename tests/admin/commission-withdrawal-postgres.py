"""Commission reservation concurrency in a disposable socket-only PostgreSQL database."""
import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
configured = os.environ.get('MAHSHAR_PG_BIN')
if configured:
    BIN = pathlib.Path(configured)
elif shutil.which('initdb'):
    BIN = pathlib.Path(shutil.which('initdb')).resolve().parent
else:
    BIN = pathlib.Path('/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin')
    if not BIN.is_dir():
        raise RuntimeError('PostgreSQL binaries unavailable')

ENV = dict(os.environ)
bundled_lib = BIN.parents[2] / 'x86_64-linux-gnu'
if bundled_lib.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(bundled_lib)

with tempfile.TemporaryDirectory(prefix='mahshar-commission-pg-') as temporary:
    root = pathlib.Path(temporary)
    data = root / 'data'

    def run(args, **kwargs):
        result = subprocess.run([str(value) for value in args], env=ENV, text=True,
                                capture_output=True, timeout=45, **kwargs)
        if result.returncode:
            log = (root / 'postgres.log').read_text() if (root / 'postgres.log').exists() else ''
            raise RuntimeError(f'command failed ({result.returncode}): {result.stderr}\n{log[-1500:]}')
        return result

    run([BIN / 'initdb', '-D', data, '-U', 'commission_test', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', data, '-l', root / 'postgres.log', '-o',
             f"-k {root} -p 55470 -c listen_addresses=''", '-w', 'start'])
        started = True

        def sql(statement):
            return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', root,
                        '-p', '55470', '-U', 'commission_test', '-d', 'postgres'],
                       input=statement).stdout.strip()

        def refused(statement, reason):
            try:
                sql(statement)
            except RuntimeError as error:
                assert reason in str(error), str(error)
                return
            raise AssertionError('financial guard unexpectedly permitted request')

        sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
            CREATE TABLE public.purchases (id text PRIMARY KEY, api_id text, buyer_wallet text,
              amount_usdc numeric, seller_share_usdc numeric, tx_hash text, settlement_attempt_id text UNIQUE,
              created_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE public.seller_withdrawals (amount_usdc numeric, status text,
              created_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE public.x402_settlement_attempts (id text PRIMARY KEY, fingerprint text UNIQUE,
              authorization_key text UNIQUE, api_id text, state text,
              purchase_id text, settlement_identity text, binding jsonb,
              transaction_id text, created_at timestamptz NOT NULL DEFAULT now());
            INSERT INTO public.purchases VALUES ('purchase-1','api-1',
              '0x0000000000000000000000000000000000000001',1.628200,1.135800,
              'x402:one','attempt-1');
            INSERT INTO public.x402_settlement_attempts VALUES ('attempt-1','fingerprint-1',
              'authorization-1','api-1','ACCOUNTING_COMPLETE',
              'purchase-1','x402:one',
              '{"fingerprint":"fingerprint-1","authorization_key":"authorization-1",
                "api_id":"api-1","network":"eip155:5042",
                "pay_to":"0x052650d1764406d702252b20b2294346a594a1ef",
                "asset":"0x3600000000000000000000000000000000000000","payer":"0x0000000000000000000000000000000000000001",
                "amount_atomic":"1628200","seller_atomic":"1135800","platform_atomic":"492400"}');''')
        migration = ROOT / 'supabase/migrations/20261020000100_admin_gateway_commission_withdrawals.sql'
        sql(migration.read_text())
        assert sql("SELECT has_function_privilege('anon','public.mahshar_reserve_admin_commission_withdrawal(uuid,numeric,numeric,numeric,numeric,numeric)','EXECUTE');") == 'f'
        assert sql("SELECT has_function_privilege('authenticated','public.mahshar_admin_commission_limits(numeric)','EXECUTE');") == 'f'
        assert sql("SELECT has_function_privilege('anon','public.mahshar_validate_admin_commission_withdrawal(uuid,numeric)','EXECUTE');") == 'f'
        assert sql("SELECT has_table_privilege('authenticated','public.admin_gateway_commission_withdrawals','SELECT');") == 'f'

        def reserve(key, available='1.679321', amount='0.100000', mint='0.095300'):
            return f"SET ROLE service_role; SELECT (public.mahshar_reserve_admin_commission_withdrawal('{key}',{amount},{mint},0.004700,0.001200,{available})).id;"

        def allowance(available='1.679321'):
            return sql(f"SELECT to_char(allowance_usdc,'FM999999990.000000') FROM mahshar_admin_commission_limits({available});")

        assert allowance() == '0.492400'
        sql("INSERT INTO purchases (id,amount_usdc) VALUES ('legacy-per-purchase-payout',5.000000);")
        assert allowance() == '0.492400'  # No second entitlement inferred from an old payout.
        sql("INSERT INTO x402_settlement_attempts (id,state,binding) VALUES ('unknown', 'SETTLEMENT_UNKNOWN',"
            "'{\"network\":\"eip155:5042\",\"pay_to\":\"0x052650d1764406d702252b20b2294346a594a1ef\",\"asset\":\"0x3600000000000000000000000000000000000000\",\"amount_atomic\":\"110000\",\"seller_atomic\":\"90000\",\"platform_atomic\":\"20000\"}');")
        assert allowance() == '0.492400'
        assert sql("SELECT to_char(confirmed_seller_reserve_usdc,'FM999990.000000') FROM mahshar_admin_commission_limits(1.679321);") == '0.000000'
        sql("UPDATE x402_settlement_attempts SET binding=NULL WHERE id='unknown';")
        assert allowance() == '0.492400'
        sql("UPDATE x402_settlement_attempts SET state='SETTLEMENT_CONFIRMED' WHERE id='unknown';")
        refused(reserve(uuid.uuid4()), 'invalid confirmed settlement liability')
        sql("DELETE FROM x402_settlement_attempts WHERE id='unknown';")
        for index, (amount, seller, platform) in enumerate([
                (110000, 90000, 20000), (1320000, 1080000, 240000),
                (110000, 90000, 20000), (1100, 900, 200), (1100, 900, 200), (1100, 900, 200)]):
            binding = json.dumps(dict(network='eip155:5042',
                pay_to='0x052650d1764406d702252b20b2294346a594a1ef',
                asset='0x3600000000000000000000000000000000000000',
                amount_atomic=str(amount), seller_atomic=str(seller), platform_atomic=str(platform)))
            sql(f"INSERT INTO x402_settlement_attempts (id,state,binding) VALUES ('unknown-{index}','SETTLEMENT_UNKNOWN','{binding}');")
        assert allowance() == '0.492400'
        unknown_snapshot = "SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM x402_settlement_attempts a WHERE state='SETTLEMENT_UNKNOWN';"
        unchanged_unknown = sql(unknown_snapshot)
        assert sql(reserve(uuid.uuid4(), amount='0.492400', mint='0.487700'))
        assert unchanged_unknown == sql(unknown_snapshot)
        assert sql("SELECT count(*) FROM x402_settlement_attempts WHERE state='SETTLEMENT_UNKNOWN';") == '6'
        sql('DELETE FROM admin_gateway_commission_withdrawals;')
        sql("DELETE FROM x402_settlement_attempts WHERE state='SETTLEMENT_UNKNOWN';")

        sql("INSERT INTO x402_settlement_attempts (id,state,binding) VALUES ('confirmed-pending', 'SETTLEMENT_CONFIRMED',"
            "'{\"network\":\"eip155:5042\",\"pay_to\":\"0x052650d1764406d702252b20b2294346a594a1ef\",\"asset\":\"0x3600000000000000000000000000000000000000\",\"amount_atomic\":\"110000\",\"seller_atomic\":\"90000\",\"platform_atomic\":\"20000\"}');")
        assert allowance() == '0.453521'
        assert sql("SELECT confirmed_seller_reserve_usdc = 0.09 FROM mahshar_admin_commission_limits(1.679321);") == 't'
        sql("INSERT INTO purchases (id,settlement_attempt_id,amount_usdc,seller_share_usdc) VALUES ('pending-purchase','confirmed-pending',0.11,0.09);")
        assert allowance() == '0.453521'
        assert sql("SELECT confirmed_seller_reserve_usdc = 0 FROM mahshar_admin_commission_limits(1.679321);") == 't'
        sql("DELETE FROM purchases WHERE id='pending-purchase'; DELETE FROM x402_settlement_attempts WHERE id='confirmed-pending';")
        assert allowance(available='1.628199') == '0.492399'

        refused(reserve(uuid.uuid4(), amount='0.1000001', mint='0.0953001'), 'invalid commission withdrawal reservation')
        refused(reserve(uuid.uuid4(), amount='0.100000', mint='0.100000'), 'invalid commission withdrawal reservation')
        refused(reserve(uuid.uuid4(), available='0.100000'), 'insufficient protected commission')
        key = uuid.uuid4()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(lambda _: sql(reserve(key)), range(2)))
        assert ids[0] == ids[1] and ids[0]
        assert sql('SELECT count(*) FROM admin_gateway_commission_withdrawals;') == '1'
        refused(reserve(key, amount='0.200000', mint='0.195300'), 'idempotency key amount mismatch')
        refused(reserve(uuid.uuid4()), 'platform withdrawal needs reconciliation')
        sql('DELETE FROM admin_gateway_commission_withdrawals;')

        def attempt(statement):
            try:
                return sql(statement)
            except RuntimeError as error:
                assert any(reason in str(error) for reason in
                  ['platform withdrawal needs reconciliation', 'seller withdrawal needs reconciliation',
                   'platform commission submission in progress']), str(error)
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(attempt, [reserve(uuid.uuid4()), reserve(uuid.uuid4())]))
        assert sum(value is not None for value in ids) == 1, ids
        active = ids[0] or ids[1]
        sql(f"UPDATE admin_gateway_commission_withdrawals SET status='preparing' WHERE id='{active}';")
        sql(f"SELECT mahshar_validate_admin_commission_withdrawal('{active}',1.679321);")
        sql("INSERT INTO purchases (id,amount_usdc,seller_share_usdc) VALUES ('new-claim',0.500000,0.500000);")
        refused(f"SELECT mahshar_validate_admin_commission_withdrawal('{active}',1.679321);", 'protected commission allowance changed')
        sql("DELETE FROM purchases WHERE id='new-claim';")
        refused("INSERT INTO seller_withdrawals (amount_usdc,status) VALUES (0.100000,'pending_mint');", 'platform commission submission in progress')
        sql(f"UPDATE admin_gateway_commission_withdrawals SET status='pending_mint' WHERE id='{active}';")
        sql("INSERT INTO seller_withdrawals (amount_usdc,status) VALUES (0.100000,'pending_mint');")
        sql('DELETE FROM seller_withdrawals; DELETE FROM admin_gateway_commission_withdrawals;')

        # Two independently arriving outgoing requests cannot both reserve source funds.
        for _ in range(6):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(attempt, [reserve(uuid.uuid4()),
                  "INSERT INTO seller_withdrawals (amount_usdc,status) VALUES (0.100000,'pending_mint') RETURNING status;"]))
            assert sum(value is not None for value in outcomes) == 1, outcomes
            sql('DELETE FROM seller_withdrawals; DELETE FROM admin_gateway_commission_withdrawals;')

        sql("INSERT INTO admin_gateway_commission_withdrawals (idempotency_key,amount_usdc,mint_value_usdc,"
            "source_fee_cap_usdc,destination_gas_estimate_usdc,status) VALUES "
            f"('{uuid.uuid4()}',0.400000,0.395300,0.004700,0.001200,'minted');")
        assert allowance() == '0.092400'
        refused(reserve(uuid.uuid4(), amount='0.500000', mint='0.495300'), 'insufficient protected commission')
        assert sql(reserve(uuid.uuid4(), amount='0.092400', mint='0.087700'))
        sql("UPDATE admin_gateway_commission_withdrawals SET status='failed' WHERE status='reserved';")
        refused(reserve(uuid.uuid4()), 'platform withdrawal needs reconciliation')
        sql('DELETE FROM admin_gateway_commission_withdrawals;')
        sql("UPDATE x402_settlement_attempts SET binding=jsonb_set(binding,'{platform_atomic}','\"492401\"') WHERE id='attempt-1';")
        refused(reserve(uuid.uuid4()), 'commission settlement accounting conflict')
        sql("UPDATE x402_settlement_attempts SET binding=jsonb_set(binding,'{platform_atomic}','\"492400\"') WHERE id='attempt-1';")
        sql("UPDATE purchases SET settlement_attempt_id='wrong' WHERE id='purchase-1';")
        refused(reserve(uuid.uuid4()), 'commission settlement accounting conflict')
        sql("UPDATE purchases SET settlement_attempt_id='attempt-1' WHERE id='purchase-1';")
        sql("UPDATE x402_settlement_attempts SET binding=jsonb_set(binding,'{pay_to}','\"0x0000000000000000000000000000000000000001\"') WHERE id='attempt-1';")
        refused(reserve(uuid.uuid4()), 'commission settlement accounting conflict')
        sql("UPDATE x402_settlement_attempts SET binding=jsonb_set(binding,'{pay_to}','\"0x052650d1764406d702252b20b2294346a594a1ef\"') WHERE id='attempt-1';")
        for status in ['pending_mint','submission_unknown','mint_unknown','failed']:
            sql(f"INSERT INTO seller_withdrawals (amount_usdc,status) VALUES (0.100000,'{status}');")
            refused(reserve(uuid.uuid4()), 'seller withdrawal needs reconciliation')
            sql('DELETE FROM seller_withdrawals;')
        print('PASS: exact commission and fee caps, preserved unknown attempts excluded from debt, legacy exclusion, RLS, idempotency, '
              'concurrent Admin/seller reservations, fresh-ledger preflight, completed and uncertain withdrawals')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
