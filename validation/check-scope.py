"""Read-only scope/preservation evidence for the isolated P2 candidate."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
original = Path('/mnt/f/Projects/mahshar')
backup = original / 'backup/provider-auth-P1-P2-20261023T091105Z-ss05b9pn'
baseline = '361f92d9a8b3c1f87597fb66d9c62bd230d8097a'
def git(*args, cwd=root):
    return subprocess.check_output(['git', '--no-optional-locks', *args], cwd=cwd)
def digest(data):
    return hashlib.sha256(data).hexdigest()
assert git('rev-parse', 'HEAD').decode().strip() == baseline
restoration = json.loads((root/'validation/evidence/restoration.json').read_text())
assert git('rev-parse', 'HEAD', cwd=original).decode().strip() == restoration['original_head']
assert git('branch', '--show-current', cwd=original).decode().strip() == restoration['original_branch']
assert digest(git('diff', '--binary', cwd=original)) == restoration['original_tracked_diff_sha256']
assert digest(git('diff', '--cached', '--binary', cwd=original)) == restoration['original_index_sha256']
verified = 0
for line in (backup/'SHA256SUMS').read_text().splitlines():
    expected, filename = line.split('  ',1)
    assert digest((backup/filename).read_bytes()) == expected, filename
    verified += 1
historical = git('ls-tree', '-r', '--name-only', baseline, '--', 'supabase/migrations').decode().splitlines()
assert len(historical) == 54
for path in historical:
    assert (root/path).read_bytes() == git('show', baseline+':'+path), path
protected = git('ls-tree', '-r', '--name-only', baseline, '--', 'src/lib/payments', 'src/lib/x402', 'src/app/api/mcp', 'src/app/api/gateway', 'src/app/api/seller/withdraw').decode().splitlines()
protected += ['src/lib/gateway.ts','src/lib/arc.ts','src/lib/chains.ts','src/app/api/agent/discover/route.ts',
    'src/hooks/useBridge.ts','src/hooks/useBridgeBalances.ts','src/app/dashboard/page.tsx','src/lib/crypto.ts',
    'src/lib/marketplace/server.ts','src/lib/marketplace/session-auth.ts','src/lib/marketplace/listing-body.ts',
    'package.json','package-lock.json','next.config.ts']
for path in sorted(set(protected)):
    assert (root/path).read_bytes() == git('show', baseline+':'+path), path
# The paid entrypoints contain exactly two inserted OAuth-only blocks each;
# removing those insertions must reconstruct the complete deployed P1 file.
paid = ['src/app/api/proxy/route.ts', 'src/app/api/proxy/[api_id]/route.ts']
for path in paid:
    text = (root/path).read_text()
    text, n1 = re.subn(r'  let providerBuyerWallet: string \| null = null\n  if \(listing.auth_type === \'oauth_pkce\'.*?\n  }\n\n', '', text, count=1, flags=re.S)
    text, n2 = re.subn(r"  if \(providerBuyerWallet && paymentResult.payer.toLowerCase\(\) !== providerBuyerWallet\) \{.*?\n  }\n", '', text, count=1, flags=re.S)
    assert (n1,n2)==(1,1) and text.encode()==git('show',baseline+':'+path), path
migrations = sorted((root/'supabase/migrations').glob('*.sql'))
new = [str(p.relative_to(root)) for p in migrations if str(p.relative_to(root)) not in historical]
assert new == ['supabase/migrations/20261023162226_provider_oauth_p2.sql']
output = dict(baseline=baseline, original_workspace_head_and_tracked_diff_unchanged=True,
    original_workspace_index_unchanged=True, source_backup_checksum_entries_verified=verified,
    historical_migrations_byte_identical=54, protected_paths_byte_identical=sorted(set(protected)),
    paid_entrypoints_reconstruct_exact_P1_after_removing_two_OAuth_only_insertions=paid,
    new_migration=new, production_connections=0, real_payments=0, real_provider_authorizations=0)
(root/'validation/evidence/scope-integrity.json').write_text(json.dumps(output,indent=2)+'\n')
print(json.dumps({k:v if not isinstance(v,list) else len(v) for k,v in output.items()}))
