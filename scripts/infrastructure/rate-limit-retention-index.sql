-- PREPARED ONLY. Separate explicit live approval required.
-- Run outside any transaction, on the verified Production project, after snapshot/backup review.
-- This does not replace or change the existing primary key or rate-limit semantics.
SET lock_timeout = '2s';
SET statement_timeout = '60s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS rate_limit_bucket_retention
  ON public.mahshar_rate_limits(bucket_start);
RESET lock_timeout;
RESET statement_timeout;

-- Verify valid/ready status. IF NOT EXISTS alone does not repair an invalid index.
SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
FROM pg_catalog.pg_index i
WHERE i.indexrelid = to_regclass('public.rate_limit_bucket_retention');
