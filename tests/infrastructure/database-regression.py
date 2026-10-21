"""All disposable DB regression entrypoints, including embedded Worker suites."""
import concurrent.futures,json,os,pathlib,subprocess,sys,time,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=pathlib.Path(tempfile.mkdtemp(prefix='mahshar-database-regression-'))
GUARD=str(pathlib.Path(__file__).resolve().parent/'network-guard.cjs')
cases=[['tests/database/postgres.py'],['tests/admin-worker/postgres.py'],['tests/admin-worker/mail-list-postgres.py'],['tests/admin-worker/multi-source-postgres.py','--expanded','--additional','--recovery','--timing'],['tests/admin-worker/mail-list-performance.py'],['tests/admin/commission-withdrawal-postgres.py'],['tests/x402/postgres.py']]
if (ROOT/'tests/infrastructure/postgres.py').exists():cases+=[['tests/infrastructure/postgres.py']]
if (ROOT/'tests/infrastructure/recovery-rehearsal.py').exists():cases+=[['tests/infrastructure/recovery-rehearsal.py']]
if len(sys.argv)>1:cases=[x for x in cases if x[0] in sys.argv[1:]]
def run(args):
 env={k:v for k,v in os.environ.items() if not any(x in k for x in ['TOKEN','SECRET','PRIVATE_KEY']) and not k.startswith(('SUPABASE_','GROQ_','CIRCLE_','ARC_','PLATFORM_','ADMIN_','BREVO_','VERCEL_','NEXT_PUBLIC_','MAHSHAR_','PG','DATABASE_'))}
 env['NODE_OPTIONS']='--require='+GUARD
 start=time.monotonic()
 try:r=subprocess.run(['python3',*args],cwd=ROOT,env=env,capture_output=True,text=True,timeout=600);code=r.returncode;output=r.stdout+r.stderr
 except subprocess.TimeoutExpired as e:code=124;output=str(e.stdout or '')+str(e.stderr or '')+'TIMEOUT'
 path=OUT/(args[0].replace('/','__')+'.log');path.write_text(output)
 row=dict(command=args,exit=code,seconds=round(time.monotonic()-start,1),log=str(path));print(json.dumps(row),flush=True);return row
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,cases))
(OUT/'summary.json').write_text(json.dumps(results,indent=2));print(json.dumps({'harnesses':len(results),'nonzero':sum(x['exit']!=0 for x in results)}),flush=True)

print("Report:",OUT,flush=True)
raise SystemExit(1 if any(r["exit"] for r in results) else 0)
