"""Full offline TypeScript inventory; independent fixtures, no Production traffic."""
import concurrent.futures,json,os,pathlib,re,subprocess,sys,time,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
if len(sys.argv)>1 and pathlib.Path(sys.argv[1]).is_dir(): ROOT=pathlib.Path(sys.argv.pop(1)).resolve()
OUT=pathlib.Path(tempfile.mkdtemp(prefix='mahshar-full-regression-'))
OUT.mkdir(exist_ok=True)
BASIC=str(pathlib.Path(__file__).resolve().parent/'basic.mjs')
GUARD=str(pathlib.Path(__file__).resolve().parent/'network-guard.cjs')
MP='tests/marketplace/register.mjs'; ADMIN='tests/admin/register.mjs'; WORKER='tests/admin-worker/register.mjs'; CONTACT='tests/admin-worker/contact-coverage-register.mjs'
files=sorted(set(list(ROOT.glob('tests/**/*.test.ts'))+list(ROOT.glob('tests/**/*.test.tsx'))+list(ROOT.glob('src/**/*.test.ts'))))
def registers(path):
 s=(ROOT/path).read_text();r=[BASIC]
 if path.startswith('tests/infrastructure/'):
  return ['tests/marketplace/register.mjs'] if path.endswith('routes.test.ts') else ['tests/infrastructure/register.mjs']
 if path=='src/lib/groq.test.ts':return ['tests/infrastructure/register.mjs'] if (ROOT/'tests/infrastructure').exists() else [MP]
 if path.startswith('tests/x402/') or path=='tests/mcp/phase2-proxy.test.ts':return ['tests/x402/register.mjs']
 if path.startswith('tests/mcp/'):return [MP]
 if path.startswith('tests/onramp/'):return ['tests/onramp/register.mjs']
 if path.startswith('tests/marketplace/'):
  r=[MP]
  for key,addon in [('withdrawal.test','withdrawal'),('verification-contract.test','verification-contract'),('seller-analysis.test','seller-analysis'),('proxy-diagnostic.test','proxy-diagnostic'),('wallet-switch.test','wallet-switch')]:
   if key in path:r+=['tests/marketplace/'+addon+'-register.mjs']
  return r
 if path.startswith('tests/admin-worker/') or path.startswith('src/lib/admin-worker/'):
  r=[CONTACT]
  if 'mail-list-ui.test' in path:r=['tests/admin-worker/mail-list-ui-register.mjs']
  elif 'dashboard-ui.test' in path or 'daily-run-limit.test' in path:r=['tests/admin-worker/dashboard-ui-register.mjs']
  elif 'canary-workflow.test' in path:r=[WORKER,'tests/admin-worker/canary-register.mjs']
  return r
 if path.startswith(('tests/admin/','tests/admin-maintenance/','tests/admin-outreach/')) or path.startswith('src/lib/admin-'):
  return [ADMIN,'tests/admin/ui-register.mjs']
 if path.startswith('tests/dashboard/'):
  if path.endswith('transactions.test.ts'):return [MP,'tests/dashboard/transactions-register.mjs']
  for key,addon in [('earnings-ui','earnings'),('edit-listing.test','edit-listing'),('seller-readonly-ui','seller-readonly'),('navbar-refresh.test','navbar-refresh'),('navbar-ui.test','navbar-ui')]:
   if key in path:return ['tests/dashboard/'+addon+'-register.mjs']
  return ['tests/dashboard/register.mjs']
 if path=='tests/mainnet/flows.test.ts' or path in ['tests/bridge-ui/estimate.test.ts','tests/bridge-ui/bridge-state.test.ts']:return ['tests/mainnet/register.mjs']
 if path.startswith('tests/bridge-ui/'):
  for name,addon in [('balance-refresh','balance-refresh'),('interactions','interaction'),('journey',''),('solana','solana'),('ui','ui')]:
   if path==f'tests/bridge-ui/{name}.test.ts':return ['tests/bridge-ui/'+(addon+'-' if addon else '')+'register.mjs']
 return r

def run(p):
 path=str(p.relative_to(ROOT));regs=registers(path)
 env={k:v for k,v in os.environ.items() if not any(x in k for x in ['TOKEN','SECRET','PRIVATE_KEY']) and not k.startswith(('SUPABASE_','GROQ_','CIRCLE_','ARC_','PLATFORM_','ADMIN_','BREVO_','VERCEL_','NEXT_PUBLIC_','MAHSHAR_','NODE_OPTIONS','PG'))}
 env.update(NODE_OPTIONS='--require='+GUARD,NEXT_PUBLIC_SUPABASE_URL='https://offline.invalid',NEXT_PUBLIC_SUPABASE_ANON_KEY='fixture',SUPABASE_SERVICE_ROLE_KEY='fixture',ENCRYPTION_KEY='ab'*32,MARKETPLACE_ORIGIN='https://mahshar.xyz',PLATFORM_WALLET_PRIVATE_KEY='0x'+'ab'*32,PLATFORM_WALLET_ADDRESS='0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6')
 cmd=['node','--import','tsx']
 for reg in regs:cmd+=['--import',reg if reg.startswith('/') else './'+reg]
 cmd+=['./'+path];start=time.monotonic()
 try:
  proc=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,timeout=300);code=proc.returncode;output=proc.stdout+proc.stderr
 except subprocess.TimeoutExpired as e:
  code=124;output=str(e.stdout or '')+'\n'+str(e.stderr or '')+'\nTIMEOUT'
 log=OUT/(path.replace('/','__')+'.log');log.write_text(output)
 counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$',output,re.M)}
 row=dict(file=path,exit=code,counts=counts,seconds=round(time.monotonic()-start,1),registers=regs,log=str(log))
 print(json.dumps(row),flush=True);return row
selection=sys.argv[1:]
if selection:files=[p for p in files if str(p.relative_to(ROOT)) in selection]
print(json.dumps({'inventory':len(files),'root':str(ROOT)}),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(run,files))
(OUT/'summary.json').write_text(json.dumps(results,indent=2))
print(json.dumps({'files':len(results),'nonzero':sum(r['exit']!=0 for r in results),'tests':sum(r['counts'].get('tests',0) for r in results),'failed_cases':sum(r['counts'].get('fail',0) for r in results)}),flush=True)

print("Report:",OUT,flush=True)
raise SystemExit(1 if any(r["exit"] for r in results) else 0)
