"""Durable Bulk List and optional Chromium tests in disposable PostgreSQL only."""
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = pathlib.Path(os.environ.get('MAHSHAR_PG_BIN', '/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
ENV = {k: v for k, v in os.environ.items() if not any(s in k for s in ('SUPABASE', 'DATABASE', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'SERVICE_ROLE', 'GROQ_API_KEY'))}
ENV['LD_LIBRARY_PATH'] = str(BIN.parents[2] / 'x86_64-linux-gnu')

with tempfile.TemporaryDirectory(prefix='mahshar-worker-replacement-bulk-') as temp:
    root = pathlib.Path(temp)
    def run(args, **kwargs):
        return subprocess.run([str(a) for a in args], env=ENV, text=True, capture_output=True, check=True, timeout=60, **kwargs)
    def sql(query):
        try:
            return run([BIN/'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', root, '-p', '55476', '-U', 'worker_test', '-d', 'postgres'], input=query).stdout.strip()
        except subprocess.CalledProcessError as error:
            print(error.stderr)
            raise
    run([BIN/'initdb', '-D', root/'data', '-U', 'worker_test', '-A', 'trust', '--no-sync'])
    try:
        run([BIN/'pg_ctl', '-D', root/'data', '-l', root/'postgres.log', '-o', f"-k {root} -p 55476 -c listen_addresses=''", '-w', 'start'])
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        for migration in sorted((ROOT/'supabase/migrations').glob('*.sql'), key=lambda p: p.name.split('_', 1)[0]):
            sql(migration.read_text())
        env = dict(ENV, FREE_WORKER_TEST_SOCKET=str(root), FREE_WORKER_TEST_PSQL=str(BIN/'psql'), GROQ_API_KEY='offline-fixture')
        result = subprocess.run(['node', '--require', './tests/free-api-worker/phase3-register.cjs', '--import', 'tsx', 'tests/free-api-worker/bulk-resume.test.ts'], cwd=ROOT, env=env, timeout=300)
        if result.returncode:
            raise RuntimeError('Bulk resume integration failed')
        print('PASS disposable PostgreSQL: durable Bulk List resume and real Seller paths')
    finally:
        subprocess.run([str(BIN/'pg_ctl'), '-D', str(root/'data'), '-m', 'immediate', '-w', 'stop'], env=ENV, capture_output=True)
