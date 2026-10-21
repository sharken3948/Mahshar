"""Synthetic offline backup/restore + release rehearsal. Never accepts a remote URL.

This tests application recovery on plain PG, not Supabase's managed schemas,
real Production data, storage objects, keys, or disaster recovery readiness.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
BIN = Path(os.environ.get('MAHSHAR_PG_BIN', '/home/gurka/.local/state/mahshar-canary/pg/lib/postgresql/16/bin'))
GPG = shutil.which('gpg')
assert GPG and all((BIN / name).is_file() for name in ('initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore'))
ENV = {k: v for k, v in os.environ.items() if not k.startswith((
    'PG', 'SUPABASE_', 'DATABASE_', 'VERCEL_', 'CIRCLE_', 'GROQ_', 'BREVO_', 'ARC_',
)) and not any(word in k for word in ('TOKEN', 'SECRET', 'PRIVATE_KEY'))}
library = BIN.parents[2] / 'x86_64-linux-gnu'
if library.is_dir():
    ENV['LD_LIBRARY_PATH'] = str(library)
REPORT = {'scope': 'synthetic_offline_only', 'production_backup_verified': False}
started_at = time.monotonic()

with tempfile.TemporaryDirectory(prefix='mahshar-recovery-') as directory:
    temp = Path(directory)
    keyring = temp / 'keyring'
    keyring.mkdir(mode=0o700)
    def run(args, **kwargs):
        result = subprocess.run([str(a) for a in args], env=ENV, capture_output=True,
                                check=True, timeout=120, **kwargs)
        return result.stdout
    def pg(name, *args, **kwargs):
        return run([BIN / name, *args], **kwargs)
    def sql(statement, database='recovery_source'):
        return pg('psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', temp, '-p', '55471',
                  '-U', 'rehearsal_owner', '-d', database, input=statement.encode()).decode().strip()
    def digest(data):
        return hashlib.sha256(data).hexdigest()
    def table_state(database):
        names = sql("SELECT tablename FROM pg_tables WHERE schemaname IN ('public','supabase_migrations') ORDER BY schemaname,tablename;", database).splitlines()
        # Ledger is separate; all public business tables are fingerprinted.
        return {name: sql(f'SELECT md5(coalesce(string_agg(to_jsonb(t)::text,\'\' ORDER BY to_jsonb(t)::text),\'\')) FROM public."{name}" t;', database)
                for name in names if name != 'schema_migrations'}
    def metadata(database):
        return sql("""
          SELECT jsonb_build_object(
            'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),
                (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a)) ORDER BY p.oid::regprocedure::text)
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'),
            'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),
                (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(c.relacl,acldefault('r',c.relowner))) a)) ORDER BY c.relname)
              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
            'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(indexname,indexdef) ORDER BY indexname) FROM pg_indexes WHERE schemaname='public')
          );
        """, database)
    pg('initdb', '-D', temp / 'cluster', '-U', 'rehearsal_owner', '-A', 'trust', '--no-sync')
    started = False
    try:
        pg('pg_ctl', '-D', temp / 'cluster', '-l', temp / 'postgres.log', '-o',
           f"-k {temp} -p 55471 -c listen_addresses=''", '-w', 'start')
        started = True
        for name in ('recovery_source', 'recovery_target'):
            pg('createdb', '-h', temp, '-p', '55471', '-U', 'rehearsal_owner', name)
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
        migration = ROOT / 'supabase/migrations/20261021000100_resource_cost_protection.sql'
        historical = sorted((p for p in (ROOT / 'supabase/migrations').glob('*.sql') if p != migration), key=lambda p: p.name.split('_')[0])
        assert len(historical) == 52
        for path in historical:
            sql('BEGIN;\n' + path.read_text() + '\nCOMMIT;')
        # Minimal synthetic migration ledger; no claim about a live ledger.
        sql('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);')
        for path in historical:
            sql("INSERT INTO supabase_migrations.schema_migrations VALUES ('" + path.name.split('_')[0] + "');")
        sql((ROOT / 'tests/infrastructure/recovery-fixture.sql').read_text())
        preflight = (ROOT / 'scripts/infrastructure/migration-preflight.sql').read_text()
        postflight = (ROOT / 'scripts/infrastructure/migration-postflight.sql').read_text()
        assert json.loads(sql(preflight))['ready_to_apply'] is True
        assert json.loads(sql(postflight))['ready_for_application'] is False
        original = table_state('recovery_source')
        original_metadata = metadata('recovery_source')
        archive = temp / 'source.dump'
        pg('pg_dump', '-h', temp, '-p', '55471', '-U', 'rehearsal_owner', '-d', 'recovery_source',
           '--format=custom', '--lock-wait-timeout=2s', '--file', archive)
        # A temporary test key only. Nothing here is an operator recovery key.
        run([GPG, '--homedir', keyring, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
             '--quick-generate-key', 'Offline Rehearsal <fixture@offline.invalid>', 'default', 'default', '1d'])
        listing = run([GPG, '--homedir', keyring, '--batch', '--with-colons', '--list-keys']).decode()
        recipient = next(line.split(':')[9] for line in listing.splitlines() if line.startswith('fpr:'))
        encrypted = temp / 'source.dump.gpg'
        run([GPG, '--homedir', keyring, '--batch', '--yes', '--trust-model', 'always',
             '--recipient', recipient, '--output', encrypted, '--encrypt', archive])
        decrypted = temp / 'restored.dump'
        run([GPG, '--homedir', keyring, '--batch', '--yes', '--output', decrypted, '--decrypt', encrypted])
        assert digest(archive.read_bytes()) == digest(decrypted.read_bytes())
        corrupt = temp / 'corrupt.gpg'
        contents = bytearray(encrypted.read_bytes())
        contents[-1] ^= 1
        corrupt.write_bytes(contents)
        try:
            run([GPG, '--homedir', keyring, '--batch', '--decrypt', corrupt])
            raise AssertionError('corrupted encrypted archive accepted')
        except subprocess.CalledProcessError:
            pass
        restore_start = time.monotonic()
        pg('pg_restore', '-h', temp, '-p', '55471', '-U', 'rehearsal_owner', '-d', 'recovery_target',
           '--exit-on-error', '--single-transaction', decrypted)
        REPORT['synthetic_restore_seconds'] = round(time.monotonic() - restore_start, 3)
        assert table_state('recovery_target') == original
        restored_metadata = metadata('recovery_target')
        if restored_metadata != original_metadata:
            expected, actual = json.loads(original_metadata), json.loads(restored_metadata)
            for kind in expected:
                if expected[kind] == actual[kind]:
                    continue
                before, after = expected[kind] or [], actual[kind] or []
                print(json.dumps({'metadata_mismatch': kind, 'source_objects': len(before), 'restored_objects': len(after)}), flush=True)
                if kind in ('tables', 'functions'):
                    left, right = {row[0]: row for row in before}, {row[0]: row for row in after}
                    for name in sorted(set(left) | set(right)):
                        if left.get(name) != right.get(name):
                            print(json.dumps({'object': name, 'source_acl': left.get(name, [None])[-1], 'restored_acl': right.get(name, [None])[-1],
                                              'definition_equal': kind != 'functions' or left[name][1] == right[name][1]}), flush=True)
                            break
            raise AssertionError('Restored metadata differs; assertions are not bypassed')
        assert json.loads(sql(preflight, 'recovery_target'))['ready_to_apply'] is True
        assert sql('SELECT count(*) FROM supabase_migrations.schema_migrations;', 'recovery_target') == '52'
        # Negative gate: unexpected ledger entries must never invite history repair.
        sql("INSERT INTO supabase_migrations.schema_migrations VALUES('99999999999999');", 'recovery_target')
        assert json.loads(sql(preflight, 'recovery_target'))['ready_to_apply'] is False
        sql("DELETE FROM supabase_migrations.schema_migrations WHERE version='99999999999999';", 'recovery_target')
        sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;', 'recovery_target')
        # Existing production runner will record only this NEW version after approval.
        sql("INSERT INTO supabase_migrations.schema_migrations VALUES('20261021000100');", 'recovery_target')
        assert json.loads(sql(postflight, 'recovery_target'))['ready_for_application'] is False
        sql((ROOT / 'scripts/infrastructure/rate-limit-retention-index.sql').read_text(), 'recovery_target')
        assert json.loads(sql(postflight, 'recovery_target'))['ready_for_application'] is True
        sql('GRANT EXECUTE ON FUNCTION public.mahshar_release_resource(uuid) TO anon;', 'recovery_target')
        assert json.loads(sql(postflight, 'recovery_target'))['ready_for_application'] is False
        sql('REVOKE EXECUTE ON FUNCTION public.mahshar_release_resource(uuid) FROM anon;', 'recovery_target')
        assert json.loads(sql(postflight, 'recovery_target'))['ready_for_application'] is True
        assert sql("SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid='public.rate_limit_bucket_retention'::regclass;", 'recovery_target') == 't'
        assert json.loads(sql(preflight, 'recovery_target'))['ready_to_apply'] is False
        after = table_state('recovery_target')
        assert all(after[name] == value for name, value in original.items())
        sql("INSERT INTO resource_budget_buckets VALUES('expired',now()-interval '3 days',now()-interval '2 days',1,1); INSERT INTO resource_budget_leases(scope,expires_at) VALUES('expired',now()-interval '1 day'); INSERT INTO mahshar_rate_limits VALUES(repeat('e',64),now()-interval '3 days',1);", 'recovery_target')
        assert sql('SET ROLE service_role; SELECT * FROM mahshar_prune_resource_records(1000);', 'recovery_target') == '1|1|1'
        after = table_state('recovery_target')
        assert all(after[name] == value for name, value in original.items())
        assert table_state('recovery_source') == original
        assert metadata('recovery_source') == original_metadata
        REPORT.update(status='PASS', historical_migrations_restored=52, additive_migration_rehearsed=True,
                      concurrent_index_valid=True, encrypted_roundtrip_and_corruption_detection=True,
                      business_tables_preserved=len(original), grants_rls_functions_indexes_restored=True,
                      unexpected_ledger_and_reapplication_blocked=True,
                      postflight_permission_drift_rejected=True,
                      bounded_cleanup_after_restore=True,
                      synthetic_total_seconds=round(time.monotonic() - started_at, 3))
    finally:
        subprocess.run(['gpgconf', '--homedir', str(keyring), '--kill', 'gpg-agent'], env=ENV, capture_output=True)
        if started:
            pg('pg_ctl', '-D', temp / 'cluster', '-m', 'immediate', '-w', 'stop')

print(json.dumps(REPORT, indent=2))
