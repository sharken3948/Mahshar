"""Read-only release boundary checks against the canonical Git object database."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASELINE = 'e77788a7f4342b2e4d23a7b384be38dab13f5759'
def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout

assert git('rev-parse', 'HEAD').decode().strip() == BASELINE
assert git('diff', '--cached', '--name-only') == b''
paths = [
    'src/lib/gateway.ts', 'src/lib/arc.ts', 'src/lib/chains.ts',
    'src/lib/platform-wallet-config.ts', 'src/lib/rate-limit.ts',
    'src/lib/marketplace/server.ts', 'src/lib/marketplace/operation-authorization.ts',
    'src/lib/mcp/paid-client.ts', 'src/lib/mcp/request-builder.ts',
    'src/hooks/useBridge.ts', 'src/hooks/useBridgeBalances.ts', 'src/app/dashboard/page.tsx',
    'src/lib/onramp-server.ts', 'src/lib/onramp-policy.ts',
    'src/lib/admin-outreach/transport.ts', 'src/lib/admin-worker/acquisition-delivery.ts',
    'src/lib/admin-worker/workflow.ts',
    'package.json', 'package-lock.json', 'next.config.ts', 'vercel.json', 'tsconfig.json',
]
prefixes = ['supabase/migrations/', 'src/lib/payments/', 'src/app/api/proxy/',
            'src/app/api/payments/', 'src/app/api/gateway/', 'src/app/api/seller/withdraw/']
tracked = git('ls-tree', '-r', '--name-only', BASELINE).decode().splitlines()
paths += [path for path in tracked if any(path.startswith(prefix) for prefix in prefixes)]
paths = [path for path in set(paths) if path in tracked]
for path in paths:
    assert (ROOT / path).read_bytes() == git('show', BASELINE + ':' + path), path

historical_migrations = {path for path in tracked if path.startswith('supabase/migrations/') and path.endswith('.sql')}
assert len(historical_migrations) == 52
assert {str(path.relative_to(ROOT)) for path in (ROOT / 'supabase/migrations').glob('*.sql')} == historical_migrations | {
    'supabase/migrations/20261021000100_resource_cost_protection.sql',
}
for path in (ROOT / 'src').rglob('*.ts'):
    if path.name == 'groq-completion.ts' or path.name.endswith('.test.ts'):
        continue
    assert 'groq.chat.completions.create(' not in path.read_text(), f'Inference bypasses optional budget wrapper: {path}'
package = json.loads((ROOT / 'package.json').read_text())
lock = json.loads((ROOT / 'package-lock.json').read_text())['packages']
for name in package.get('dependencies', {}) | package.get('devDependencies', {}):
    key = 'node_modules/' + name
    assert json.loads((ROOT / key / 'package.json').read_text())['version'] == lock[key]['version'], name
print(f'PASS: {len(paths)} financial/security/configuration/historical-migration files byte-identical; exactly 52 historical plus one additive migration; canonical HEAD; empty index; all inference routed through optional budget wrapper; installed top-level dependencies match lockfile.')
