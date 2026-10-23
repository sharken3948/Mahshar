"""P1-only migration compatibility; disposable socket-only PostgreSQL, no database URL."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
BIN = Path(os.environ['MAHSHAR_PG_BIN'])
ENV = dict(os.environ, LD_LIBRARY_PATH=str(BIN.parents[2] / 'x86_64-linux-gnu'))
checks = 0
with tempfile.TemporaryDirectory(prefix='mahshar-p1-migration-') as directory:
    folder = Path(directory)
    def run(args, **kwargs):
        return subprocess.run(list(map(str,args)), text=True, capture_output=True, check=True, timeout=45, env=ENV, **kwargs)
    run([BIN/'initdb','-D',folder/'data','-U','p1_test','-A','trust','--no-sync'])
    started = False
    try:
        run([BIN/'pg_ctl','-D',folder/'data','-l',folder/'postgres.log','-o',f"-k {folder} -p 55483 -c listen_addresses=''",'-w','start'])
        started = True
        def sql(statement):
            try:
                return run([BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',folder,'-p','55483','-U','p1_test','-d','postgres'],input=statement).stdout.strip()
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error
        def check(ok, message):
            global checks
            assert ok,message
            checks += 1
        def rejects(statement):
            try: sql(statement)
            except AssertionError as error:
                check('api_listings_auth_type_check' in str(error),str(error));return
            raise AssertionError('Unexpected auth acceptance')
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        candidate, = (ROOT/'supabase/migrations').glob('*_provider_authentication_p1.sql')
        prior = sorted([p for p in (ROOT/'supabase/migrations').glob('*.sql') if p != candidate], key=lambda p:p.name.split('_',1)[0])
        versions = [p.name.split('_',1)[0] for p in prior+[candidate]]
        check(len(versions)==len(set(versions)), 'duplicate migration version')
        check(len(prior)==53, 'unexpected canonical baseline migration set')
        for p in prior: sql(p.read_text())
        print(f'Applied all {len(prior)} canonical baseline migrations.',flush=True)
        seller,buyer='0x'+'11'*20,'0x'+'22'*20
        ids = []
        for auth in ['public','apikey','bearer','queryparam']:
            id_ = str(uuid.uuid4());ids.append(id_)
            sql(f"INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,encrypted_key,endpoint_url) VALUES('{id_}','legacy','fixture','Data',0.01,'pay-per-call','{seller}','{auth}','legacy-ciphertext','https://provider.example');")
        sql(f"INSERT INTO purchases(buyer_wallet,api_id,amount_usdc,tx_hash) VALUES('{buyer}','{ids[0]}',0.01,'synthetic-no-money'); INSERT INTO credit_balances(buyer_wallet,balance_usdc) VALUES('{buyer}',1);")
        rows_query = "SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM api_listings l),(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM purchases p),(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM credit_balances c))::text"
        functions_query = "SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.oid)::text,'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'"
        schema_query = """SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid,a.attnotnull,a.attacl,c.relacl,c.relrowsecurity,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)::text,'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped"""
        objects_query = """SELECT jsonb_build_array(
          (SELECT jsonb_agg(to_jsonb(x) ORDER BY indexname) FROM pg_indexes x WHERE schemaname='public'),
          (SELECT jsonb_agg(to_jsonb(x) ORDER BY tablename,policyname) FROM pg_policies x WHERE schemaname='public'),
          (SELECT jsonb_agg(jsonb_build_array(t.oid,pg_get_triggerdef(t.oid)) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
          (SELECT jsonb_agg(jsonb_build_array(c.oid,pg_get_constraintdef(c.oid)) ORDER BY c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname<>'api_listings_auth_type_check'))::text"""
        before = [sql(q) for q in [rows_query,functions_query,schema_query,objects_query]]
        def change_auth(auth):return f"UPDATE api_listings SET auth_type='{auth}' WHERE id='{ids[0]}';"
        for auth in ['basic','headers','authorization','oauth_pkce','oauth_client_credentials']: rejects(change_auth(auth))
        constraint_query = "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='api_listings_auth_type_check'"
        old_check = sql(constraint_query)
        migration = candidate.read_text()
        sql(migration.replace('COMMIT;','ROLLBACK;'))
        check(sql(constraint_query)==old_check, 'transactional rollback changed constraint')
        sql(migration)
        for query, expected, label in zip([rows_query,functions_query,schema_query,objects_query],before,['rows','functions/ACL','columns/RLS/ACL/defaults','indexes/policies/triggers/other constraints']):
            check(sql(query)==expected, f'P1 migration modified existing {label}')
        for auth in ['public','apikey','bearer','queryparam','basic','headers','authorization']:
            sql(change_auth(auth))
            check(sql(f"SELECT auth_type FROM api_listings WHERE id='{ids[0]}'")==auth, f'P1 auth not supported: {auth}')
        for auth in ['oauth_pkce','oauth_client_credentials','digest','unsupported']:rejects(change_auth(auth))
        check(sql("SELECT to_regclass('public.provider_oauth_accounts') IS NULL AND to_regclass('public.provider_oauth_states') IS NULL")=='t','P2 tables unexpectedly installed')
        check(sql("SELECT count(*) FROM pg_proc WHERE proname LIKE 'mahshar_oauth_%'")=='0','P2 functions unexpectedly installed')
        check(sql("SELECT count(*) FROM pg_trigger WHERE tgname='provider_oauth_configuration_changed'")=='0','P2 trigger unexpectedly installed')
        check('oauth' not in sql(constraint_query).lower(),'P2 types in P1 constraint')
        sql(change_auth('public'))
        check(sql(rows_query)==before[0], 'static auth checks changed encrypted credentials or financial rows')
        # Existing roles retain their original restrictions on private listing data.
        for role in ['anon','authenticated']:
            check(sql(f"SELECT has_table_privilege('{role}','public.api_listings','SELECT')")=='f','existing private listing grant changed')
        snapshot=(ROOT/'supabase/schema.sql').read_text()
        check("'basic', 'headers', 'authorization'" in snapshot and 'provider_oauth_' not in snapshot,'schema snapshot mismatch')
        print(f'{checks} P1 migration checks passed: full baseline chain, rollback, old/new auth types, no P2 objects, unchanged legacy credentials/data/functions/ACL/RLS and financial rows. No Production connection.')
    finally:
        if started:run([BIN/'pg_ctl','-D',folder/'data','-m','immediate','-w','stop'])
