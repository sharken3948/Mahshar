"""Launch and stop only this test's local server and Chromium. Never loads app env files."""
import os
from pathlib import Path
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parents[2]
node = os.environ.get('MAHSHAR_NODE', '/tmp/mahshar-provider-tools/node-v24.22.1-linux-x64/bin/node')
env = dict(os.environ, NEXT_PUBLIC_SUPABASE_URL='https://disposable.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY='fixture',
    SUPABASE_SERVICE_ROLE_KEY='fixture', MAHSHAR_BROWSER_PORT=os.environ.get('MAHSHAR_BROWSER_PORT', '3068'),
    MAHSHAR_BROWSER_BUNDLE='/tmp/mahshar-auth-p1-browser.js')
subprocess.run([node, 'tests/provider-auth/browser-build.mjs'], cwd=root, env=env, check=True)
with (root / 'validation/evidence/browser-server-final.log').open('w') as log:
    server = subprocess.Popen([node, '--import', 'tsx', 'tests/provider-auth/browser-server.mjs'], cwd=root, env=env,
        stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 240
        while True:
            if server.poll() is not None:
                raise RuntimeError('Browser fixture startup failed; see browser-server-final.log')
            try:
                urllib.request.urlopen('http://127.0.0.1:' + env['MAHSHAR_BROWSER_PORT'] + '/fixture/evidence', timeout=1).close()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Browser fixture startup timed out')
                time.sleep(0.2)
        result = subprocess.run([node, 'tests/provider-auth/browser.mjs'], cwd=root, env=env)
        raise SystemExit(result.returncode)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill(); server.wait()
