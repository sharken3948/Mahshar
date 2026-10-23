"""Disposable Unix-socket PostgreSQL only. Never reads application env/database URLs."""
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
elif shutil.which('pg_config'):
    BIN = pathlib.Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
else:
    raise RuntimeError('Set MAHSHAR_PG_BIN to local PostgreSQL binaries; no database URL is accepted')
ENV = dict(os.environ)
library = BIN.parents[2] / 'x86_64-linux-gnu'
if library.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(library)
checks = 0

with tempfile.TemporaryDirectory(prefix='mahshar-oauth-pg-') as directory:
    folder = pathlib.Path(directory)
    def run(args, **kwargs):
        return subprocess.run([str(x) for x in args], check=True, text=True, capture_output=True, timeout=45, env=ENV, **kwargs)
    run([BIN / 'initdb', '-D', folder / 'data', '-U', 'auth_test', '-A', 'trust', '--no-sync'])
    started = False
    try:
        run([BIN / 'pg_ctl', '-D', folder / 'data', '-l', folder / 'postgres.log', '-o',
             f"-k {folder} -p 55482 -c listen_addresses=''", '-w', 'start'])
        started = True
        def sql(statement):
            try:
                return run([BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', folder, '-p', '55482',
                            '-U', 'auth_test', '-d', 'postgres'], input=statement).stdout.strip()
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error
        def check(condition, message):
            global checks
            assert condition, message
            checks += 1
        def denied(statement):
            try:
                sql(statement)
            except AssertionError as error:
                check('permission denied' in str(error), str(error))
                return
            raise AssertionError('statement unexpectedly permitted')
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        if os.environ.get('MAHSHAR_AUTH_FULL_MIGRATIONS', '1') == '1':
            migrations = sorted((ROOT / 'supabase/migrations').glob('*.sql'), key=lambda p: p.name.split('_', 1)[0])
            prior = [p for p in migrations if p.name.split('_', 1)[0] < '20261023162226']
            assert len(prior) == 54, 'expected exact deployed P1 chain of 54 migrations'
            versions = [p.name.split('_', 1)[0] for p in migrations]
            assert len(versions) == len(set(versions)), 'duplicate migration versions'
            for migration_file in prior:
                sql(migration_file.read_text())
            print(f'Applied all {len(prior)} canonical baseline migrations in version order.', flush=True)
        else:
            sql((ROOT / 'supabase/migrations/20240626000000_core_schema_baseline.sql').read_text())
            sql('ALTER TABLE public.api_listings ADD COLUMN verified_at timestamptz;')
        seller, buyer = '0x' + '11' * 20, '0x' + '22' * 20
        old_ids = [str(uuid.uuid4()) for _ in range(7)]
        for id_, auth in zip(old_ids, ['public', 'apikey', 'bearer', 'queryparam', 'basic', 'headers', 'authorization']):
            sql(f"INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,encrypted_key,endpoint_url) VALUES('{id_}','legacy','fixture','Data',0.01,'pay-per-call','{seller}','{auth}','ciphertext','https://provider.example');")
        sql(f"INSERT INTO purchases(buyer_wallet,api_id,amount_usdc,tx_hash) VALUES('{buyer}','{old_ids[0]}',0.01,'fixture-hash');")
        fingerprint = sql("SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) FROM purchases p")
        legacy = sql("SELECT md5(string_agg(row_to_json(l)::text,'' ORDER BY id)) FROM api_listings l")
        functions_query = """SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.oid)::text,'[]')
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT LIKE 'mahshar_oauth_%'"""
        columns_query = """SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid,a.attnotnull,a.attacl,c.relacl,c.relrowsecurity,
          pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)::text
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
          LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
          WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
          AND c.relname NOT IN ('provider_oauth_accounts','provider_oauth_states')"""
        prior_functions, prior_columns = sql(functions_query), sql(columns_query)
        migration = (ROOT / 'supabase/migrations/20261023162226_provider_oauth_p2.sql').read_text()
        # Verify rollback before applying to the disposable database.
        sql(migration.replace('COMMIT;', 'ROLLBACK;'))
        check(sql("SELECT to_regclass('public.provider_oauth_accounts') IS NULL") == 't', 'rollback created table')
        check('oauth_pkce' not in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='api_listings_auth_type_check' AND conrelid='api_listings'::regclass"), 'rollback did not restore P1 auth constraint')
        sql(migration)
        check(sql("SELECT md5(string_agg(row_to_json(l)::text,'' ORDER BY id)) FROM api_listings l") == legacy, 'legacy listing modified')
        check(sql(functions_query) == prior_functions, 'existing function definition or ACL changed')
        check(sql(columns_query) == prior_columns, 'existing column/default/RLS/ACL changed')
        # P1 static credentials require the additive auth CHECK, not an OAuth
        # account/profile. Exercise its real trigger with the full migration.
        for auth in ['basic', 'headers', 'authorization']:
            p1_id = str(uuid.uuid4())
            sql(f"INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,encrypted_key,endpoint_url) VALUES('{p1_id}','P1','fixture','Data',0.01,'pay-per-call','{seller}','{auth}','p1-cipher','https://provider.example');")
            sql(f"UPDATE api_listings SET encrypted_key='p1-replacement' WHERE id='{p1_id}';")
            check(sql(f"SELECT encrypted_key='p1-replacement' FROM api_listings WHERE id='{p1_id}'") == 't', 'P1 credential edit failed with OAuth trigger')
            sql(f"DELETE FROM api_listings WHERE id='{p1_id}';")
        check(sql('SELECT count(*) FROM provider_oauth_accounts') == '0', 'P1 created OAuth accounts')
        for role in ['anon', 'authenticated']:
            for table in ['provider_oauth_accounts', 'provider_oauth_states']:
                denied(f'SET ROLE {role}; SELECT * FROM public.{table};')
                denied(f'SET ROLE {role}; DELETE FROM public.{table};')
            denied(f"SET ROLE {role}; SELECT * FROM mahshar_oauth_disconnect('{old_ids[0]}','{seller}','seller');")
        check(sql("SELECT count(*) FROM pg_class WHERE relname IN ('provider_oauth_accounts','provider_oauth_states') AND relrowsecurity") == '2', 'RLS not enabled')
        # Populate both tables before granting SELECT: an empty-table count
        # would not prove that RLS actually hides credential/state rows.
        sql(f"INSERT INTO provider_oauth_accounts(api_id,owner_wallet,account_mode,config_hash,encrypted_tokens) VALUES('{old_ids[0]}','{seller}','seller','{'c'*64}','private-fixture');")
        sql(f"INSERT INTO provider_oauth_states(state_hash,api_id,owner_wallet,account_mode,config_hash,session_hash,browser_hash,encrypted_verifier,expires_at) VALUES('{'d'*64}','{old_ids[0]}','{seller}','seller','{'c'*64}','private-session','private-browser','private-verifier',now()+interval '5 minutes');")
        check(sql('SELECT (SELECT count(*)=1 FROM provider_oauth_accounts) AND (SELECT count(*)=1 FROM provider_oauth_states)') == 't', 'RLS fixtures missing')
        # Grant table access deliberately; RLS still denies every populated row.
        sql('GRANT SELECT ON provider_oauth_accounts,provider_oauth_states TO anon,authenticated;')
        for role in ['anon', 'authenticated']:
            check(sql(f'SET ROLE {role}; SELECT count(*) FROM provider_oauth_accounts') == '0', 'RLS access leak')
            check(sql(f'SET ROLE {role}; SELECT count(*) FROM provider_oauth_states') == '0', 'RLS state leak')
        sql('REVOKE SELECT ON provider_oauth_accounts,provider_oauth_states FROM anon,authenticated;')
        sql(f"DELETE FROM provider_oauth_accounts WHERE api_id='{old_ids[0]}'; DELETE FROM provider_oauth_states WHERE api_id='{old_ids[0]}';")
        listing = str(uuid.uuid4())
        sql(f"INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,encrypted_key,endpoint_url,is_active) VALUES('{listing}','OAuth','fixture','Data',0.01,'pay-per-call','{seller}','oauth_client_credentials','oauth-cipher','https://provider.example',true);")
        hash_ = 'a' * 64
        def claim(wallet=seller, mode='seller', create=True, lease=None):
            lease = lease or str(uuid.uuid4())
            rows = sql(f"SET ROLE service_role; SELECT row_to_json(a) FROM mahshar_oauth_claim('{listing}','{wallet}','{mode}','{hash_}','oauth-cipher',{str(create).lower()},'{lease}') a;")
            return lease, json.loads(rows) if rows else None
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            claims = list(pool.map(lambda _: claim(), range(32)))
        owners = [(lease, a) for lease, a in claims if a['lease_id'] == lease]
        check(len(owners) == 1, 'refresh lease acquired by multiple callers')
        lease, account = owners[0]
        check(len({a['id'] for _, a in claims}) == 1, 'duplicate accounts under concurrency')
        check(claim(buyer, 'buyer', False)[1] is None, 'seller account shared with buyer')
        def finish(lease_value=lease, revision=None, tokens="'encrypted-token'"):
            return sql(f"SET ROLE service_role; SELECT mahshar_oauth_finish('{account['id']}','{lease_value}',{revision or account['revision']},'oauth-cipher',{tokens},now()+interval '1 hour');")
        check(finish(str(uuid.uuid4())) == 'f', 'unowned lease finished')
        check(finish(revision=account['revision'] + 1) == 'f', 'wrong revision finished')
        check(finish() == 't', 'owned lease failed')
        check(finish() == 'f', 'lease replay accepted')
        cached_lease, cached = claim()
        check(cached['lease_id'] is None and cached['encrypted_tokens'] == 'encrypted-token', 'cache missed')
        # Expired worker leases become terminal; no possibly-consumed rotating token retry.
        sql(f"UPDATE provider_oauth_accounts SET expires_at=now()-interval '1 hour',lease_id='{uuid.uuid4()}',lease_until=now()-interval '1 second' WHERE id='{account['id']}';")
        _, expired = claim()
        check(expired['status'] == 'reauthorization_required' and expired['encrypted_tokens'] is None, 'expired lease reused')
        # Buyer consent completion and concurrent replay use the exact state row.
        sql(f"UPDATE api_listings SET auth_type='oauth_pkce' WHERE id='{listing}';")
        state_hash = 'b' * 64
        def add_state():
            sql(f"INSERT INTO provider_oauth_states(state_hash,api_id,owner_wallet,account_mode,config_hash,session_hash,browser_hash,encrypted_verifier,expires_at,used_at) VALUES('{state_hash}','{listing}','{buyer}','buyer','{hash_}','session-hash','browser-hash','encrypted-verifier',now()+interval '5 minutes',now());")
        add_state()
        def complete():
            return sql(f"SET ROLE service_role; SELECT mahshar_oauth_complete('{state_hash}','oauth-cipher','buyer-encrypted-token',now()+interval '1 hour');")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            completions = list(pool.map(lambda _: complete(), range(16)))
        check(completions.count('t') == 1, 'consent replay accepted')
        check(sql(f"SELECT count(*) FROM provider_oauth_accounts WHERE owner_wallet='{buyer}' AND account_mode='buyer'") == '1', 'buyer account missing')
        add_state()
        sql(f"SET ROLE service_role; SELECT count(*) FROM mahshar_oauth_disconnect('{listing}','{buyer}','buyer');")
        check(complete() == 'f', 'disconnected pending callback restored tokens')
        check(sql(f"SELECT encrypted_tokens IS NULL AND status='disconnected' FROM provider_oauth_accounts WHERE owner_wallet='{buyer}'") == 't', 'disconnect retained tokens')
        check(sql(f"SELECT is_active FROM api_listings WHERE id='{listing}'") == 't', 'buyer disconnect deactivated seller listing')
        sql(f"UPDATE provider_oauth_accounts SET status='active',expires_at=now()-interval '1 hour',lease_id=NULL WHERE id='{account['id']}';")
        lease, account = claim(create=False)
        sql(f"SET ROLE service_role; SELECT count(*) FROM mahshar_oauth_disconnect('{listing}','{seller}','seller');")
        check(finish() == 'f', 'disconnect failed to fence refresh')
        check(sql(f"SELECT is_active FROM api_listings WHERE id='{listing}'") == 'f', 'seller disconnect did not deactivate listing')
        add_state()
        check(complete() == 't', 'fresh buyer consent after disconnect failed')
        add_state()
        sql(f"UPDATE api_listings SET name='Cosmetic edit' WHERE id='{listing}';")
        check(sql(f"SELECT status FROM provider_oauth_accounts WHERE api_id='{listing}' AND owner_wallet='{buyer}'") == 'active', 'cosmetic edit invalidated tokens')
        sql(f"UPDATE api_listings SET encrypted_key='replaced-ciphertext' WHERE id='{listing}';")
        check(sql(f"SELECT count(*) FROM provider_oauth_accounts WHERE api_id='{listing}' AND (encrypted_tokens IS NOT NULL OR lease_id IS NOT NULL OR status<>'disconnected')") == '0', 'credential edit retained tokens or refresh leases')
        check(sql(f"SELECT count(*) FROM provider_oauth_states WHERE api_id='{listing}'") == '0', 'credential edit retained pending consent')
        sql(f"UPDATE api_listings SET encrypted_key='oauth-cipher',is_active=true,verified_at=now() WHERE id='{listing}';")
        sql(f"INSERT INTO provider_oauth_states(state_hash,api_id,owner_wallet,account_mode,config_hash,session_hash,browser_hash,encrypted_verifier,expires_at,used_at) VALUES('{state_hash}','{listing}','{seller}','seller','{hash_}','session-hash','browser-hash','encrypted-verifier',now()+interval '5 minutes',now());")
        check(complete() == 't', 'seller consent failed')
        check(sql(f"SELECT NOT is_active AND verified_at IS NULL FROM api_listings WHERE id='{listing}'") == 't', 'seller reconnect retained old verification')
        check(sql(f"SELECT encrypted_tokens IS NOT NULL AND status='active' FROM provider_oauth_accounts WHERE api_id='{listing}' AND owner_wallet='{seller}'") == 't', 'reconnect erased fresh tokens')
        check(sql("SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) FROM purchases p") == fingerprint, 'financial fixture modified')
        print(f'{checks} disposable PostgreSQL checks passed: migration, rollback, legacy preservation, ACL/RLS, concurrency, tenant isolation, token fencing, callback replay and disconnect. No Production connection.')
    finally:
        if started:
            run([BIN / 'pg_ctl', '-D', folder / 'data', '-m', 'immediate', '-w', 'stop'])
