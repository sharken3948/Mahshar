"""Local Node 24 build using synthetic, non-routable configuration only."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
node_dir = Path(os.environ.get('MAHSHAR_NODE_BIN', '/tmp/mahshar-provider-tools/node-v24.22.1-linux-x64/bin'))
env = dict(os.environ, PATH=str(node_dir) + ':' + os.environ['PATH'],
    NODE_ENV='production', NEXT_TELEMETRY_DISABLED='1', ENCRYPTION_KEY='ab' * 32,
    MARKETPLACE_ORIGIN='https://mahshar.xyz', NEXT_PUBLIC_SUPABASE_URL='https://disposable.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY='fixture', SUPABASE_SERVICE_ROLE_KEY='fixture', GROQ_API_KEY='fixture',
    ARC_MAINNET_RPC_URL='https://rpc.disposable.invalid',
    PLATFORM_WALLET_PRIVATE_KEY='0x' + 'ab' * 32,
    PLATFORM_WALLET_ADDRESS='0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6')
for name in list(env):
    if name.startswith('VERCEL') or name in ('DATABASE_URL', 'DIRECT_URL', 'SUPABASE_DB_URL'):
        del env[name]
command = [str(node_dir / 'node'), 'node_modules/next/dist/bin/next', 'build']
if '--webpack' in sys.argv:
    command.append('--webpack')
print(subprocess.check_output([str(node_dir / 'node'), '--version'], text=True).strip(), flush=True)
print('Synthetic build configuration; no real provider credentials or database URL.', flush=True)
raise SystemExit(subprocess.run(command, cwd=root, env=env).returncode)
