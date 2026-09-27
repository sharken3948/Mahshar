"""Local-only disposable DB; no network listener or existing cluster access."""
import concurrent.futures
import json
import os
import pathlib
import subprocess
import tempfile
import uuid

binaries = pathlib.Path('/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin')
env = dict(os.environ, LD_LIBRARY_PATH=str(binaries.parents[2] / 'x86_64-linux-gnu'))
with tempfile.TemporaryDirectory(prefix='mahshar-x402-test-') as root:
    root = pathlib.Path(root)
    data = root / 'data'
    def run(args, **kw):
        return subprocess.run([str(x) for x in args], env=env, check=True, text=True, capture_output=True, timeout=30, **kw)
    run([binaries/'initdb','-D',data,'-U','x402_test','-A','trust','--no-sync'])
    started = False
    try:
        run([binaries/'pg_ctl','-D',data,'-l',root/'postgres.log','-o',f"-k {root} -p 55459 -c listen_addresses=''",'-w','start'])
        started = True
        def sql(s):
            return run([binaries/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-p','55459','-U','x402_test','-d','postgres'],input=s).stdout.strip()
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        sql(pathlib.Path('supabase/schema.sql').read_text())
        sql('ALTER TABLE purchases ADD COLUMN seller_share_usdc numeric; CREATE UNIQUE INDEX idx_purchases_tx_hash ON purchases(tx_hash);')
        api = '00000000-0000-4000-8000-000000000001'
        payer, seller, payto, asset = ['0x'+s*40 for s in ['1','2','4','3']]
        sql(f"INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,endpoint_url) VALUES('{api}','fixture','fixture','test',0.001,'pay-per-call','{seller}','public','https://example.com');")
        sql(f"INSERT INTO purchases(buyer_wallet,api_id,amount_usdc,tx_hash) VALUES('{payer}','{api}',1,'historical-tx');")
        historical = sql("SELECT row_to_json(purchases) FROM purchases WHERE tx_hash='historical-tx';")
        sql(pathlib.Path('supabase/migrations/20260923000300_x402_settlement_durability.sql').read_text())
        def binding(n):
            return dict(fingerprint=f'{n:064x}', authorization_key=f'{n+100:064x}', proof_hash='a'*64, api_id=api,
                        payer=payer,seller=seller,network='eip155:5042',asset=asset,pay_to=payto,nonce='0x'+f'{n:064x}',
                        amount_atomic='1100',seller_atomic='900',platform_atomic='200',
                        authorization=dict(from_=payer),requirements={})
        def prepare(n):
            b=binding(n)
            b['authorization']={'from':payer,'to':payto,'value':'1100','nonce':b['nonce'],'validAfter':'1','validBefore':'9999999999'}
            b['requirements']={'asset':asset,'payTo':payto,'network':'eip155:5042','amount':'1100'}
            return sql("SET ROLE service_role; SELECT (public.x402_prepare('"+json.dumps(b)+"'::jsonb)).id;")
        a=prepare(1)
        assert prepare(1)==a
        tokens=[str(uuid.uuid4()),str(uuid.uuid4())]
        def claim(token): return sql(f"SET ROLE service_role; SELECT (public.x402_claim('{a}','{token}')).id;")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: claims=list(pool.map(claim,tokens))
        assert sum(bool(x) for x in claims)==1
        token=tokens[0] if claims[0] else tokens[1]
        sql(f"SET ROLE service_role; SELECT public.x402_confirm('{a}','{token}','circle-tx');")
        # Simulate purchase write failure after confirmation in a separate commit.
        sql("CREATE FUNCTION fail_purchase() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('test.fail_purchase',true)='on' THEN RAISE EXCEPTION 'injected purchase failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_purchase BEFORE INSERT ON purchases FOR EACH ROW EXECUTE FUNCTION fail_purchase();")
        try:
            sql(f"SET ROLE service_role; SET test.fail_purchase='on'; SELECT public.x402_recover('{a}');")
            raise AssertionError('failure injection did not fire')
        except subprocess.CalledProcessError: pass
        assert sql(f"SELECT state FROM x402_settlement_attempts WHERE id='{a}';")=='SETTLEMENT_CONFIRMED'
        assert claim(str(uuid.uuid4()))==''
        def recover(_): return sql(f"SET ROLE service_role; SELECT (public.x402_recover('{a}')).purchase_id;")
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: purchases=list(pool.map(recover,range(4)))
        assert len(set(purchases))==1 and purchases[0]
        assert sql(f"SELECT count(*) FROM purchases WHERE settlement_attempt_id='{a}';")=='1'
        assert sql(f"SELECT amount_usdc=0.0011 AND seller_share_usdc=0.0009 FROM purchases WHERE settlement_attempt_id='{a}';")=='t'
        assert sql(f"SELECT transaction_id FROM x402_settlement_attempts WHERE id='{a}';")=='circle-tx'
        # Same batch transaction, distinct authorization, distinct accounting.
        b=prepare(2); t=str(uuid.uuid4())
        sql(f"SET ROLE service_role; SELECT public.x402_claim('{b}','{t}'); SELECT public.x402_confirm('{b}','{t}','circle-tx'); SELECT public.x402_recover('{b}');")
        assert sql('SELECT count(*) FROM purchases WHERE settlement_attempt_id IS NOT NULL;')=='2'
        # Missing transaction: stable fallback; repeated recovery has one purchase.
        c=prepare(3); t=str(uuid.uuid4())
        sql(f"SET ROLE service_role; SELECT public.x402_claim('{c}','{t}'); SELECT public.x402_confirm('{c}','{t}',NULL); SELECT public.x402_recover('{c}'); SELECT public.x402_recover('{c}');")
        assert sql(f"SELECT settlement_identity FROM x402_settlement_attempts WHERE id='{c}';")=='x402:'+f'{3:064x}'
        # Crash after submit, unknown response and malformed confirmation fail closed.
        d=prepare(4); t=str(uuid.uuid4())
        sql(f"SET ROLE service_role; SELECT public.x402_claim('{d}','{t}');")
        sql(f"UPDATE x402_settlement_attempts SET submitted_at=now()-interval '3 minutes' WHERE id='{d}';")
        assert sql(f"SET ROLE service_role; SELECT (public.x402_recover('{d}')).state;")=='MANUAL_REVIEW'
        assert sql(f"SET ROLE service_role; SELECT (public.x402_claim('{d}','{uuid.uuid4()}')).id;")==''
        e=prepare(5); te=str(uuid.uuid4())
        sql(f"SET ROLE service_role; SELECT public.x402_claim('{e}','{te}'); SELECT public.x402_confirm('{e}','{te}','historical-tx');")
        assert sql(f"SET ROLE service_role; SELECT (public.x402_recover('{e}')).state;")=='MANUAL_REVIEW'
        try:
            sql(f"SET ROLE service_role; SELECT public.x402_confirm('{d}','{uuid.uuid4()}','forged');")
            raise AssertionError('forged confirmation accepted')
        except subprocess.CalledProcessError: pass
        for role in ['anon','authenticated']:
            assert sql(f"SELECT has_function_privilege('{role}','public.x402_recover(uuid)','EXECUTE');")=='f'
            assert sql(f"SELECT has_table_privilege('{role}','public.x402_settlement_attempts','SELECT');")=='f'
        assert sql("SELECT has_table_privilege('service_role','public.x402_settlement_attempts','UPDATE');")=='f'
        rollback=pathlib.Path('supabase/rollbacks/20260923000300_x402_settlement_durability.sql').read_text()
        try:
            sql('BEGIN;'+rollback+'COMMIT;')
            raise AssertionError('rollback discarded financial evidence')
        except subprocess.CalledProcessError: pass
        # Apply every new agent-facing migration to a real disposable PostgreSQL
        # cluster, then exercise delivery leases, stats, grants, and rate limits.
        for migration in [
            '20260926000100_private_listing_configuration.sql',
            '20260926000200_x402_delivery_state.sql',
            '20260926000300_agent_listing_metadata.sql',
            '20260926000400_machine_rate_limits.sql',
            '20260926000500_agent_listing_stats.sql',
        ]:
            sql(pathlib.Path('supabase/migrations', migration).read_text())
        assert sql("SELECT delivery_state FROM x402_settlement_attempts WHERE id='"+a+"';")=='UNKNOWN'
        f=prepare(6); tf=str(uuid.uuid4())
        sql(f"SET ROLE service_role; SELECT public.x402_claim('{f}','{tf}'); SELECT public.x402_confirm('{f}','{tf}','circle-delivery'); SELECT public.x402_recover('{f}');")
        delivery_token=str(uuid.uuid4()); request_hash='b'*64
        assert sql(f"SET ROLE service_role; SELECT (public.x402_delivery_claim('{f}','{delivery_token}','{request_hash}')).delivery_state;")=='IN_PROGRESS'
        assert sql(f"SET ROLE service_role; SELECT (public.x402_delivery_complete('{f}','{delivery_token}','FAILED_RETRYABLE',502,'upstream_unreachable')).delivery_state;")=='FAILED_RETRYABLE'
        delivery_token=str(uuid.uuid4())
        assert sql(f"SET ROLE service_role; SELECT (public.x402_delivery_claim('{f}','{delivery_token}','{request_hash}')).delivery_state;")=='IN_PROGRESS'
        assert sql(f"SET ROLE service_role; SELECT (public.x402_delivery_complete('{f}','{delivery_token}','SUCCEEDED',200,NULL)).delivery_state;")=='SUCCEEDED'
        assert sql(f"SET ROLE service_role; SELECT (public.x402_delivery_claim('{f}','{uuid.uuid4()}','{request_hash}')).delivery_state;")=='SUCCEEDED'
        try:
            sql(f"SET ROLE service_role; SELECT public.x402_delivery_claim('{f}','{uuid.uuid4()}','{'c'*64}');")
            raise AssertionError('delivery request mismatch accepted')
        except subprocess.CalledProcessError: pass
        limits=[sql("SET ROLE service_role; SELECT allowed FROM public.mahshar_take_rate_limit('"+'d'*64+"',2,60);") for _ in range(3)]
        assert limits==['t','t','f']
        sql(f"INSERT INTO api_calls(api_id,buyer_wallet,payment_type,latency_ms,success) VALUES('{api}','{payer}','pay-per-call',25,true),('{api}','{payer}','pay-per-call',75,false);")
        assert sql(f"SET ROLE service_role; SELECT count(*) FROM public.mahshar_agent_listing_stats(ARRAY['{api}'::uuid]);")=='1'
        assert sql(f"SET ROLE service_role; SELECT total_calls=2 AND successful_calls=1 AND avg_latency_ms=50 FROM public.mahshar_agent_listing_stats(ARRAY['{api}'::uuid]);")=='t'
        for role in ['anon','authenticated']:
            assert sql(f"SELECT has_table_privilege('{role}','public.api_listings','SELECT');")=='f'
            assert sql(f"SELECT has_function_privilege('{role}','public.x402_delivery_claim(uuid,uuid,text)','EXECUTE');")=='f'
            assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_take_rate_limit(text,integer,integer)','EXECUTE');")=='f'
        # Remove the later additive migrations only inside this disposable DB so
        # the original pre-use settlement rollback invariant can still be tested.
        sql("""
          DROP FUNCTION public.mahshar_agent_listing_stats(uuid[]);
          DROP FUNCTION public.mahshar_take_rate_limit(text,integer,integer);
          DROP TABLE public.mahshar_rate_limits;
          ALTER TABLE public.api_listings
            DROP CONSTRAINT api_listings_request_schema_object,
            DROP CONSTRAINT api_listings_response_schema_object,
            DROP CONSTRAINT api_listings_path_parameters_array,
            DROP CONSTRAINT api_listings_query_parameters_array,
            DROP COLUMN request_schema, DROP COLUMN response_schema,
            DROP COLUMN body_required, DROP COLUMN dynamic_path_supported,
            DROP COLUMN path_parameters, DROP COLUMN query_parameters;
          DROP FUNCTION public.x402_delivery_claim(uuid,uuid,text),
            public.x402_delivery_complete(uuid,uuid,text,integer,text);
          ALTER TABLE public.x402_settlement_attempts
            DROP COLUMN delivery_state, DROP COLUMN delivery_request_hash,
            DROP COLUMN delivery_token, DROP COLUMN delivery_started_at,
            DROP COLUMN delivery_completed_at, DROP COLUMN delivery_http_status,
            DROP COLUMN delivery_error_code;
        """)
        # Remove ONLY synthetic records in this disposable cluster to test pre-use rollback.
        sql('UPDATE x402_settlement_attempts SET state=\'PREPARED\',purchase_id=NULL; DELETE FROM purchases WHERE settlement_attempt_id IS NOT NULL; DELETE FROM x402_settlement_attempts;')
        sql('BEGIN;'+rollback+'COMMIT;')
        assert sql("SELECT row_to_json(purchases) FROM purchases WHERE tx_hash='historical-tx';")==historical
        print('PASS: serialized settlement; durable accounting; delivery retry/fencing; request binding; migration grants; rate limiting; aggregate stats; guarded rollback; historical purchase preserved')
    finally:
        if started: run([binaries/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
