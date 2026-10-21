-- Operator invocation: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- READ ONLY. Execute only against the independently verified Production project.
-- Must return ready_to_apply=true before migration approval. No ledger repair.
-- A missing/inaccessible migration ledger is an error and a STOP condition.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '500ms';
WITH expected(version) AS (
  SELECT jsonb_array_elements_text('["20240626000000","20240627","20240627000001","20260710","20260823","20260823000001","20260918","20260919","20260919000001","20260923000300","20260926000100","20260926000200","20260926000300","20260926000400","20260926000500","20260928000100","20260928000200","20260928000300","20261001000000","20261001000030","20261001000100","20261001000110","20261002000100","20261004000100","20261005000100","20261005000200","20261005000300","20261007000100","20261007000200","20261008000100","20261008000200","20261014000100","20261014000200","20261014000300","20261014000400","20261014000500","20261014000600","20261014000700","20261015000100","20261015000200","20261015000300","20261015000400","20261015000500","20261015000600","20261017000100","20261018000100","20261018000200","20261018000300","20261018000400","20261019000100","20261019000200","20261020000100"]'::jsonb)
), actual(version) AS (
  SELECT version::text FROM supabase_migrations.schema_migrations
), missing AS (SELECT version FROM expected EXCEPT SELECT version FROM actual),
extra AS (SELECT version FROM actual EXCEPT SELECT version FROM expected),
objects AS (
  SELECT to_regclass('public.resource_budget_buckets') IS NULL
    AND to_regclass('public.resource_budget_leases') IS NULL
    AND to_regprocedure('public.mahshar_reserve_resource(jsonb,bigint,text,integer)') IS NULL
    AND to_regprocedure('public.mahshar_release_resource(uuid)') IS NULL
    AND to_regprocedure('public.mahshar_prune_resource_records(integer)') IS NULL AS absent
)
SELECT jsonb_build_object(
  'read_only', current_setting('transaction_read_only')='on',
  'expected_historical_versions', (SELECT count(*) FROM expected),
  'actual_versions', (SELECT count(*) FROM actual),
  'missing_versions', (SELECT count(*) FROM missing),
  'unexpected_versions', (SELECT count(*) FROM extra),
  'new_objects_absent', objects.absent,
  'new_index_absent', to_regclass('public.rate_limit_bucket_retention') IS NULL,
  'ready_to_apply', NOT EXISTS(SELECT 1 FROM missing) AND NOT EXISTS(SELECT 1 FROM extra)
    AND (SELECT count(*) FROM actual)=52 AND objects.absent
    AND to_regclass('public.rate_limit_bucket_retention') IS NULL
) FROM objects;
ROLLBACK;
