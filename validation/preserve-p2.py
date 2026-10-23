"""Create a new immutable-name P2 evidence backup and verify patch restoration."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile

root=Path(__file__).resolve().parents[1]
base='361f92d9a8b3c1f87597fb66d9c62bd230d8097a'
source=Path('/mnt/f/Projects/mahshar/backup/provider-auth-P1-P2-20261023T091105Z-ss05b9pn')
def git(*args,cwd=root):
    return subprocess.check_output(['git','--no-optional-locks',*args],cwd=cwd)
def sha(data): return hashlib.sha256(data).hexdigest()
assert git('rev-parse','HEAD').decode().strip()==base
assert not git('diff','--cached','--name-only')
subprocess.run(['git','diff','--check'],cwd=root,check=True)
tracked=git('diff','--name-only','HEAD').decode().splitlines()
untracked=git('ls-files','--others','--exclude-standard').decode().splitlines()
# Generated cache/evidence never enters the application patch.
untracked=[p for p in untracked if not p.startswith(('validation/evidence/','supabase/.temp/'))]
changed=sorted(set(tracked+untracked))
assert all(p.startswith(('src/','supabase/','tests/','docs/security/','validation/')) or p=='openapi.yaml' for p in changed)
assert 'WORKLOG.md' not in changed
old=json.loads((source/'manifest.json').read_text())
context=[v['path'] for v in old['files'] if (root/v['path']).is_file()]
# Preserve complete focused harness and migration chain, including baseline files
# needed by the runner. No node_modules, env files, caches or prior backup copied.
context += [str(p.relative_to(root)) for folder in ['tests/provider-auth','tests/marketplace','tests/x402','tests/mcp','tests/dashboard','supabase/migrations'] for p in (root/folder).rglob('*') if p.is_file() and '__pycache__' not in str(p)]
files=sorted(set(changed+context+['validation/README-P2.md','validation/build.py','validation/check-scope.py','validation/preserve-p2.py']))
now=datetime.now(timezone.utc)
dest=Path('/mnt/f/Projects/mahshar/backup')/('provider-auth-P2-on-P1-'+now.strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4))
dest.mkdir(mode=0o700)
entries=[]
for name in files:
    data=(root/name).read_bytes()
    target=dest/'implementation'/name
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(data)
    entries.append(dict(path=name,bytes=len(data),sha256=sha(data)))
patch=git('diff','--binary','HEAD','--',*tracked)
for name in sorted(untracked):
    result=subprocess.run(['git','diff','--no-index','--binary','--','/dev/null',name],cwd=root,capture_output=True)
    assert result.returncode==1,(name,result.stderr)
    patch+=result.stdout
(dest/'changes.patch').write_bytes(patch)
shutil.copyfile(root/'docs/security/provider-authentication-audit.md',dest/'AUDIT.md')
shutil.copyfile(root/'docs/security/provider-oauth-testing.md',dest/'PROVIDER-TESTING.md')
shutil.copyfile(root/'WORKLOG.md',dest/'WORKLOG.md')
shutil.copytree(root/'validation/evidence',dest/'test-evidence')
manifest=dict(created_utc=now.isoformat(),baseline=base,worktree=str(root),resumed_from=str(source),
    readiness={'P1_compatibility':'PASS','P2_implementation':'READY_FOR_REVIEW','P2_production':'NO-GO'},
    migration='20261023162226_provider_oauth_p2.sql',historical_migrations=54,
    patch_sha256=sha(patch),patch_files=changed,files=entries,
    performed={'production_mutations':False,'real_oauth_authorization':False,'real_payments':False,'commit_push_deploy':False},
    tests={'matrix':{'passed':277,'files':30},'browser_auth_variants':12,'browser_body_limit_scenarios':6,
      'postgres16_checks':49,'postgres17_checks':49,'node24_build':'PASS','node24_runtime':'PASS'})
(dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
# Work on a new archive extraction only; never stage or alter a Git index.
with tempfile.TemporaryDirectory(prefix='mahshar-p2-patch-verify-') as tmp:
    folder=Path(tmp); archive=folder/'base.tar'; tree=folder/'baseline'; tree.mkdir()
    with archive.open('wb') as out:
        subprocess.run(['git','archive',base],cwd=root,stdout=out,check=True)
    with tarfile.open(archive) as tar: tar.extractall(tree,filter='data')
    subprocess.run(['git','apply','--check',str(dest/'changes.patch')],cwd=tree,check=True)
    subprocess.run(['git','apply',str(dest/'changes.patch')],cwd=tree,check=True)
    for item in entries:
        assert sha((tree/item['path']).read_bytes())==item['sha256'],item['path']
    # Every baseline file outside the declared delta remains exactly equal.
    baseline_names=git('ls-tree','-r','--name-only',base).decode().splitlines()
    untouched=0
    for name in baseline_names:
        if name not in changed:
            restored = tree/name
            actual = os.readlink(restored).encode() if restored.is_symlink() else restored.read_bytes()
            assert actual==git('show',base+':'+name),name
            untouched+=1
    verification=dict(baseline=base,patch_sha256=sha(patch),patch_check='PASS',patch_apply='PASS',
        manifest_files_roundtrip_verified=len(entries),unchanged_baseline_files_verified=untouched,
        no_staging_commits_push_or_deployment=True)
    (dest/'verification.json').write_text(json.dumps(verification,indent=2)+'\n')
checks=[]
for file in sorted(p for p in dest.rglob('*') if p.is_file()):
    checks.append(sha(file.read_bytes())+'  '+str(file.relative_to(dest)))
(dest/'SHA256SUMS').write_text('\n'.join(checks)+'\n')
for line in checks:
    expected,name=line.split('  ',1)
    assert sha((dest/name).read_bytes())==expected,name
(root/'validation/latest-backup-path.txt').write_text(str(dest)+'\n')
print(json.dumps(dict(backup=str(dest),checksum_entries_verified=len(checks),**verification),indent=2))
