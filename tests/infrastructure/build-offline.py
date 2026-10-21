"""Build using synthetic credentials, blocked fetch, and offline font fixtures."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
env = {k: v for k, v in os.environ.items() if not k.startswith((
    'NEXT_PUBLIC_', 'SUPABASE_', 'GROQ_', 'CIRCLE_', 'ARC_', 'PLATFORM_', 'ADMIN_', 'BREVO_', 'VERCEL_',
))}
env.update({
    'NEXT_PUBLIC_SUPABASE_URL': 'https://offline.invalid',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'offline-fixture',
    'SUPABASE_SERVICE_ROLE_KEY': 'offline-fixture',
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID': 'offline-fixture',
    'MARKETPLACE_ORIGIN': 'https://mahshar.xyz',
    'PLATFORM_WALLET_ADDRESS': '0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6',
    'PLATFORM_WALLET_PRIVATE_KEY': '0x' + 'ab' * 32,
    'ENCRYPTION_KEY': 'ab' * 32,
    'ARC_MAINNET_RPC_URL': 'https://offline.invalid',
    'NEXT_TELEMETRY_DISABLED': '1',
    'NEXT_FONT_GOOGLE_MOCKED_RESPONSES': str(root / 'tests/infrastructure/fonts.cjs'),
    'NODE_OPTIONS': '--require=' + str(root / 'tests/infrastructure/offline-build.cjs'),
})
raise SystemExit(subprocess.run(['node', 'node_modules/next/dist/bin/next', 'build', '--webpack'],
                              cwd=root, env=env).returncode)
