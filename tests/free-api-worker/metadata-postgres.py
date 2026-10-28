"""Focused Bulk List metadata tests in a new disposable PostgreSQL cluster only."""
import os
import json
import pathlib
import subprocess
import tempfile
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = pathlib.Path(os.environ.get('MAHSHAR_PG_BIN', '/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
ENV = {k: v for k, v in os.environ.items() if not any(s in k for s in ('SUPABASE', 'DATABASE', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'SERVICE_ROLE', 'GROQ_API_KEY'))}
ENV['LD_LIBRARY_PATH'] = str(BIN.parents[2] / 'x86_64-linux-gnu')

with tempfile.TemporaryDirectory(prefix='mahshar-worker-replacement-metadata-') as temp:
    root = pathlib.Path(temp)
    def run(args, **kwargs):
        return subprocess.run([str(a) for a in args], env=ENV, text=True, capture_output=True, check=True, timeout=60, **kwargs)
    def sql(query):
        try:
            return run([BIN/'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', root, '-p', '55476', '-U', 'worker_test', '-d', 'postgres'], input=query).stdout.strip()
        except subprocess.CalledProcessError as error:
            print(error.stderr)
            raise
    run([BIN/'initdb', '-D', root/'data', '-U', 'worker_test', '-A', 'trust', '--no-sync'])
    try:
        run([BIN/'pg_ctl', '-D', root/'data', '-l', root/'postgres.log', '-o', f"-k {root} -p 55476 -c listen_addresses=''", '-w', 'start'])
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        for migration in sorted((ROOT/'supabase/migrations').glob('*.sql'), key=lambda p: p.name.split('_', 1)[0]):
            sql(migration.read_text())
        env = dict(ENV, FREE_WORKER_TEST_SOCKET=str(root), FREE_WORKER_TEST_PSQL=str(BIN/'psql'), GROQ_API_KEY='offline-fixture')
        test_file = sys.argv[1] if len(sys.argv) > 1 else 'tests/free-api-worker/metadata.test.ts'
        result = subprocess.run(['node', '--require', './tests/free-api-worker/phase3-register.cjs', '--import', 'tsx', test_file], cwd=ROOT, env=env, timeout=180)
        if result.returncode:
            raise RuntimeError('Metadata integration failed')
        print(f'PASS disposable PostgreSQL integration: {test_file}')
        # Optional, real Groq preparation artifact. Apply it only to local snapshot fixtures.
        plan_dir = os.environ.get('MAHSHAR_METADATA_PLAN_DIR')
        if plan_dir:
            plan = pathlib.Path(plan_dir).resolve()
            prepared = json.loads((plan/'results.json').read_text())
            assert len(prepared) == 5 and all(row['ready'] for row in prepared)
            correction = (plan/'corrections.sql').read_text()
            def literal(value):
                return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"
            fields = ['id','name','description','category','score','seller_wallet','price_per_call','endpoint_url','method','auth_type','is_active','verified_at','free_worker_candidate_id','example_request','example_response']
            for entry in prepared:
                row = entry['before']
                # Test-only provenance permits the production listing trigger to run normally.
                lead = dict(id=row['free_worker_candidate_id'], name=row['name'], description=row['description'], providerId='snapshot-fixture', docs=row['endpoint_url'], sources=[], auth='none')
                evidence = dict(technical='PASSED', freeAccess='VERIFIED', permission='UNKNOWN', termsChecked=True, endpoint=row['endpoint_url'])
                receipt = dict(version='paid-api-access-v1', confirmed=True, owner=row['seller_wallet'], candidateId=row['free_worker_candidate_id'], endpoint=row['endpoint_url'], confirmedAt='fixture-only')
                sql(f"INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead,result) VALUES ({literal(lead['id'])},'snapshot-fixture',{literal(row['name'])},{literal(row['endpoint_url'])},{literal(json.dumps(lead))}::jsonb,{literal(json.dumps(evidence))}::jsonb)")
                values = ','.join(literal(row[k]) for k in fields)
                sql(f"INSERT INTO public.api_listings({','.join(fields)},payment_model,owner_rights_confirmation) VALUES ({values},'pay-per-call',{literal(json.dumps(receipt))}::jsonb)")
                for _ in range(row['call_count']):
                    sql(f"INSERT INTO public.api_calls(api_id,buyer_wallet,payment_type,latency_ms,success) VALUES ({literal(row['id'])},'fixture-buyer','pay-per-call',42,true)")
                for index in range(row['purchase_count']):
                    reference = f"fixture-only-{row['id']}-{index}"
                    sql(f"INSERT INTO public.purchases(api_id,buyer_wallet,amount_usdc,tx_hash) VALUES ({literal(row['id'])},'fixture-buyer',0.0011,{literal(reference)})")
            ids = ','.join(literal(entry['id']) for entry in prepared)
            def preserved():
                return sql(f"SELECT md5(jsonb_agg(to_jsonb(t)-'category'-'score' ORDER BY id)::text) FROM public.api_listings t WHERE id IN ({ids})")
            def history():
                return [sql(f"SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM public.{table} t") for table in ['api_calls','purchases']]
            before, before_history = preserved(), history()
            conflict = prepared[1]['id']
            original_price = prepared[1]['before']['price_per_call']
            sql(f"UPDATE public.api_listings SET price_per_call=price_per_call+0.000001 WHERE id={literal(conflict)}")
            try:
                sql(correction)
                raise AssertionError('A changed snapshot must reject the complete correction')
            except subprocess.CalledProcessError as error:
                assert 'Listing changed' in error.stderr
            assert sql(f"SELECT count(*) FROM public.api_listings WHERE id IN ({ids}) AND category='Other' AND score IS NULL") == '5'
            sql(f"UPDATE public.api_listings SET price_per_call={literal(original_price)} WHERE id={literal(conflict)}")
            sql(correction)
            for entry in prepared:
                assert sql(f"SELECT category || ':' || score::int FROM public.api_listings WHERE id={literal(entry['id'])}") == f"{entry['category']}:{entry['score']}"
            assert preserved() == before
            assert history() == before_history
            try:
                sql(correction)
                raise AssertionError('Already-corrected records must not be overwritten by a stale plan')
            except subprocess.CalledProcessError as error:
                assert 'Listing changed' in error.stderr
            assert preserved() == before and history() == before_history
            print('PASS five real-Groq correction plans: exact category/score values; all other listing fields and histories unchanged; concurrent drift and repeat application roll back atomically')
    finally:
        subprocess.run([str(BIN/'pg_ctl'), '-D', str(root/'data'), '-m', 'immediate', '-w', 'stop'], env=ENV, capture_output=True)
