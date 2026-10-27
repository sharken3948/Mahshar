"""Current main + additive Worker schema, in disposable PostgreSQL only."""
import os, pathlib, subprocess, tempfile, sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
BIN=pathlib.Path(os.environ.get('MAHSHAR_PG_BIN','/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
ENV={k:v for k,v in os.environ.items() if not any(x in k for x in ('SUPABASE','DATABASE','PGHOST','PGPORT','PGUSER','PGPASSWORD','SERVICE_ROLE'))}
ENV['LD_LIBRARY_PATH']=str(BIN.parents[2]/'x86_64-linux-gnu')
with tempfile.TemporaryDirectory(prefix='mahshar-worker-replacement-') as temp:
 root=pathlib.Path(temp)
 def run(args,**kw): return subprocess.run([str(v) for v in args],env=ENV,text=True,capture_output=True,check=True,timeout=90,**kw)
 def sql(query):
  try:return run([BIN/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',root,'-p','55476','-U','worker_test','-d','postgres'],input=query).stdout.strip()
  except subprocess.CalledProcessError as error:raise RuntimeError(error.stderr) from error
 run([BIN/'initdb','-D',root/'data','-U','worker_test','-A','trust','--no-sync'])
 try:
  run([BIN/'pg_ctl','-D',root/'data','-l',root/'postgres.log','-o',f"-k {root} -p 55476 -c listen_addresses=''",'-w','start'])
  sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
  migrations=sorted((ROOT/'supabase/migrations').glob('*.sql'),key=lambda p:p.name.split('_',1)[0])
  for migration in migrations:
   sql(migration.read_text())
  assert sql("SELECT status FROM public.free_worker_state")=='stopped'
  assert sql("SELECT has_table_privilege('anon','public.free_worker_apis','SELECT')")=='f'
  sql("INSERT INTO public.api_listings(name,description,category,endpoint_url,price_per_call,payment_model,is_active,seller_wallet,auth_type) VALUES ('Shared fixture','Existing product','Other','https://shared.example.org/books',0.001,'pay-per-call',false,'0x1111111111111111111111111111111111111111','public')")
  before=sql("SELECT md5(row_to_json(t)::text) FROM public.api_listings t")
  env=dict(ENV,FREE_WORKER_TEST_SOCKET=str(root),FREE_WORKER_TEST_PSQL=str(BIN/'psql'))
  if os.environ.get('FREE_WORKER_BROWSER')=='1':env['FREE_WORKER_PLAYWRIGHT_MODULE']=str(next((pathlib.Path.home()/'.npm/_npx').glob('*/node_modules/playwright')))
  result=subprocess.run(['node','--require','./tests/free-api-worker/phase3-register.cjs','--import','tsx','tests/free-api-worker/release-import.test.ts' if os.environ.get('FREE_WORKER_RELEASE_IMPORT') else 'tests/free-api-worker/phase3.test.ts'],cwd=ROOT,env=env,timeout=1200)
  if result.returncode:raise RuntimeError('Release integration failed')
  assert sql("SELECT md5(row_to_json(t)::text) FROM public.api_listings t WHERE free_worker_candidate_id IS NULL")==before
  assert sql("SELECT status FROM public.free_worker_state")=='stopped'
  print('PASS release schema, stopped state, shared-product preservation and current-main Seller integration')
 finally:
  subprocess.run([str(BIN/'pg_ctl'),'-D',str(root/'data'),'-m','immediate','-w','stop'],env=ENV,capture_output=True)
