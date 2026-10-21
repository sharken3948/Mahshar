-- Operator invocation: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- READ ONLY. Must return ready_for_application=true before deployment approval.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '500ms';
WITH expected(version) AS (
  SELECT jsonb_array_elements_text('["20240626000000","20240627","20240627000001","20260710","20260823","20260823000001","20260918","20260919","20260919000001","20260923000300","20260926000100","20260926000200","20260926000300","20260926000400","20260926000500","20260928000100","20260928000200","20260928000300","20261001000000","20261001000030","20261001000100","20261001000110","20261002000100","20261004000100","20261005000100","20261005000200","20261005000300","20261007000100","20261007000200","20261008000100","20261008000200","20261014000100","20261014000200","20261014000300","20261014000400","20261014000500","20261014000600","20261014000700","20261015000100","20261015000200","20261015000300","20261015000400","20261015000500","20261015000600","20261017000100","20261018000100","20261018000200","20261018000300","20261018000400","20261019000100","20261019000200","20261020000100"]'::jsonb)
  UNION ALL SELECT '20261021000100'
), actual(version) AS (SELECT version::text FROM supabase_migrations.schema_migrations),
ledger AS (
  SELECT (SELECT count(*) FROM actual)=53
    AND NOT EXISTS(SELECT version FROM expected EXCEPT SELECT version FROM actual)
    AND NOT EXISTS(SELECT version FROM actual EXCEPT SELECT version FROM expected) AS ready
), permissions AS (
  SELECT coalesce(bool_and(p.prosecdef
    AND has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')),false)
    AND count(*)=3 AS ready
  FROM pg_proc p WHERE p.oid IN (
    to_regprocedure('public.mahshar_reserve_resource(jsonb,bigint,text,integer)'),
    to_regprocedure('public.mahshar_release_resource(uuid)'),
    to_regprocedure('public.mahshar_prune_resource_records(integer)'))
), tables AS (
  SELECT coalesce(bool_and(c.relrowsecurity
    AND has_table_privilege('service_role',c.oid,'SELECT')
    AND NOT has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),false)
    AND count(*)=2 AS ready
  FROM pg_class c WHERE c.oid IN (to_regclass('public.resource_budget_buckets'),to_regclass('public.resource_budget_leases'))
), retention AS (
  SELECT EXISTS(SELECT 1 FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.rate_limit_bucket_retention')
      AND i.indrelid='public.mahshar_rate_limits'::regclass
      AND i.indisvalid AND i.indisready AND i.indnkeyatts=1 AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid,1,true)='bucket_start') AS ready
)
SELECT jsonb_build_object(
  'read_only',current_setting('transaction_read_only')='on',
  'ledger_53_versions',ledger.ready,'service_only_functions',permissions.ready,
  'operational_table_rls_and_grants',tables.ready,'retention_index_valid',retention.ready,
  'ready_for_application',ledger.ready AND permissions.ready AND tables.ready AND retention.ready
) FROM ledger,permissions,tables,retention;
ROLLBACK;
