"""Offline authentication and compatibility suite; all service boundaries are mocked."""
import concurrent.futures
import json
import os
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
cases = []
def add(files, registers=()):
    for file in files.split():
        cases.append((file, registers))
add('tests/provider-auth/authentication.test.ts tests/provider-auth/request-size.test.ts tests/provider-auth/p1-isolation.test.ts tests/provider-auth/listing-body.test.ts', ['tests/provider-auth/register.mjs'])
add('tests/provider-auth/paid.test.ts', ['tests/provider-auth/paid-register.mjs'])
add('src/lib/marketplace/upstream-auth.test.ts src/lib/marketplace/request-contract.test.ts src/lib/marketplace/buyer-proxy-request.test.ts src/lib/proxy-response.test.ts src/lib/proxy-policy.test.ts src/lib/request-body.test.ts src/lib/groq.test.ts src/lib/seo/listing.test.ts', ['tests/marketplace/register.mjs'])
add('tests/marketplace/security.test.ts tests/marketplace/listing-creation-security.test.ts tests/marketplace/listing-security-match.test.ts tests/marketplace/listing-contract.test.ts tests/marketplace/session-auth.test.ts tests/marketplace/seller-onboarding.test.ts tests/marketplace/seller-analysis.test.ts', ['tests/marketplace/register.mjs'])
add('tests/marketplace/verification-contract.test.ts tests/marketplace/verification-size.test.ts', ['tests/marketplace/register.mjs', 'tests/marketplace/verification-contract-register.mjs'])
add('tests/marketplace/proxy-diagnostic.test.ts', ['tests/marketplace/register.mjs', 'tests/marketplace/proxy-diagnostic-register.mjs'])
add('tests/dashboard/edit-listing.test.ts', ['tests/marketplace/register.mjs', 'tests/dashboard/edit-listing-register.mjs'])
add('tests/x402/integration.test.ts tests/x402/settlement.test.ts tests/x402/errors.test.ts tests/x402/delivery-migration.test.ts tests/mcp/phase2-proxy.test.ts', ['tests/x402/register.mjs'])
cases = list(dict.fromkeys((file, tuple(registers)) for file, registers in cases))
if os.environ.get('MAHSHAR_AUTH_FILTER'):
    cases = [case for case in cases if re.search(os.environ['MAHSHAR_AUTH_FILTER'], case[0])]
ENV = dict(os.environ, ENCRYPTION_KEY='ab'*32, MARKETPLACE_ORIGIN='https://mahshar.xyz',
           NEXT_PUBLIC_SUPABASE_URL='https://disposable.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY='fixture',
           SUPABASE_SERVICE_ROLE_KEY='fixture', GROQ_API_KEY='fixture',
           ARC_MAINNET_RPC_URL='https://rpc.disposable.invalid', PLATFORM_WALLET_PRIVATE_KEY='0x'+'ab'*32,
           PLATFORM_WALLET_ADDRESS='0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6')
with tempfile.TemporaryDirectory(prefix='mahshar-auth-regression-') as logdir:
    def run(case):
        file, registers = case
        cmd = ['node', '--test-reporter=tap', '--import', 'tsx']
        for register in registers:
            cmd += ['--import', './' + register]
        # Explicit CJS entry preserves the boundary hooks on Node 24 too.
        # Its ESM entry translator can bypass Module._load for nested imports.
        cmd += ['--eval', 'require(' + json.dumps('./' + file) + ')']
        try:
            completed = subprocess.run(cmd, cwd=ROOT, env=ENV, text=True, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, timeout=240)
        except subprocess.TimeoutExpired as error:
            return {'file': file, 'exit': 124, 'tests': 0, 'passed': 0, 'failure': 'Test process exceeded 240 seconds'}
        text = completed.stdout
        match = re.search(r'^# tests (\d+)$', text, re.M)
        result = {'file': file, 'exit': completed.returncode, 'tests': int(match[1]) if match else 0,
                  'passed': int(re.search(r'^# pass (\d+)$', text, re.M)[1]) if '# pass ' in text else 0}
        if completed.returncode:
            result['failure'] = text[-20000:]
        print(json.dumps({key: value for key, value in result.items() if key != 'failure'}), flush=True)
        return result
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run, cases))
output = {'files': len(results), 'tests': sum(row['tests'] for row in results),
          'passed': sum(row['passed'] for row in results), 'failed_files': sum(row['exit'] != 0 for row in results), 'results': results}
path = pathlib.Path(os.environ.get('MAHSHAR_AUTH_RESULTS', '/tmp/mahshar-provider-auth-regressions.json'))
path.write_text(json.dumps(output, indent=2))
print(json.dumps({key: value for key, value in output.items() if key != 'results'}))
for row in results:
    if row['exit']:
        print(json.dumps(row))
raise SystemExit(1 if output['failed_files'] else 0)
