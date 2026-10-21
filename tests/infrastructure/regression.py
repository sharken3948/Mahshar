"""Run focused suites in isolated processes with their own established offline fixtures."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[2]
REPORT = Path(tempfile.mkdtemp(prefix='mahshar-protection-results-'))
SUITES = [
    ('marketplace', 'tests/marketplace/register.mjs', 'tests/marketplace/run.mjs'),
    ('resource-unit', 'tests/infrastructure/register.mjs', 'tests/infrastructure/protection.test.ts'),
    ('groq', 'tests/infrastructure/register.mjs', 'src/lib/groq.test.ts'),
    ('public-readers', 'tests/marketplace/register.mjs', 'tests/infrastructure/run-public.mjs'),
    ('x402', 'tests/x402/register.mjs', 'tests/infrastructure/run-x402.mjs'),
    ('onramp', 'tests/onramp/register.mjs', 'tests/onramp/onramp.test.ts'),
    ('mcp-discovery', 'tests/marketplace/register.mjs', 'tests/mcp/phase1.test.ts'),
    ('mcp-payments', 'tests/marketplace/register.mjs', 'tests/mcp/phase2.test.ts'),
    ('mcp-proxy', 'tests/x402/register.mjs', 'tests/mcp/phase2-proxy.test.ts'),
    ('mcp-recovery', 'tests/marketplace/register.mjs', 'tests/mcp/recovery-errors.test.ts'),
    ('worker-foundation', 'tests/admin-worker/register.mjs', 'tests/admin-worker/foundation.test.ts'),
    ('worker-auth', 'tests/admin-worker/register.mjs', 'tests/admin-worker/auth.test.ts'),
    ('worker-drafts', 'tests/admin-worker/register.mjs', 'tests/admin-worker/continuous-draft.test.ts'),
    ('worker-brevo', 'tests/admin-worker/register.mjs', 'tests/admin-worker/brevo-delivery.test.ts'),
    ('worker-step', 'tests/admin-worker/register.mjs', 'tests/admin-worker/acquisition-step.test.ts'),
    ('worker-daily-limit', 'tests/admin-worker/register.mjs', 'tests/admin-worker/daily-run-limit.test.ts'),
    ('worker-discovery', 'tests/admin-worker/contact-coverage-register.mjs', 'src/lib/admin-worker/discovery/discovery.test.ts'),
    ('worker-naming', 'tests/admin-worker/contact-coverage-register.mjs', 'tests/admin-worker/name-evidence.test.ts'),
    ('worker-dedup', 'tests/admin-worker/contact-coverage-register.mjs', 'tests/admin-worker/research-dedup.test.ts'),
    ('mainnet-flows', 'tests/mainnet/register.mjs', 'tests/mainnet/flows.test.ts'),
    ('withdrawals', ['tests/marketplace/register.mjs', 'tests/marketplace/withdrawal-register.mjs'], 'tests/marketplace/withdrawal.test.ts'),
    ('maintenance', 'tests/marketplace/register.mjs', 'tests/marketplace/maintenance.test.ts'),
    ('purchase-recovery', 'tests/marketplace/register.mjs', 'tests/marketplace/purchase-recovery.test.ts'),
    ('resource-routes', 'tests/marketplace/register.mjs', 'tests/infrastructure/routes.test.ts'),
]

def run(suite):
    name, register, test = suite
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('SUPABASE_', 'GROQ_', 'CIRCLE_', 'ARC_', 'PLATFORM_', 'ADMIN_', 'BREVO_', 'VERCEL_', 'NEXT_PUBLIC_')):
            del env[key]
    registers = [register] if isinstance(register, str) else register
    arguments = ['node', '--import', 'tsx']
    for entry in registers:
        arguments += ['--import', './' + entry]
    result = subprocess.run(arguments + ['./' + test],
                            cwd=ROOT, env=env, text=True, capture_output=True, timeout=300)
    output = result.stdout + result.stderr
    path = REPORT / (name + '.log')
    path.write_text(output)
    counts = dict(re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', output, re.M))
    summary = dict(name=name, exit_code=result.returncode, counts=counts, log=str(path))
    print(json.dumps(summary), flush=True)
    return summary

if len(sys.argv) > 1:
    SUITES = [suite for suite in SUITES if suite[0] in sys.argv[1:]]

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    results = list(pool.map(run, SUITES))
(REPORT / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
print('Report:', REPORT, flush=True)
raise SystemExit(1 if any(result['exit_code'] for result in results) else 0)
