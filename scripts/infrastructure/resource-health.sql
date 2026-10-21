-- READ-ONLY manual check, after the additive migration. No user/financial data or query texts.
-- Run only in the separately approved Production project through a secure operator connection.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '3s';
SELECT now() AS observed_at,
       pg_database_size(current_database()) AS database_bytes,
       current_setting('max_connections')::integer AS max_connections;
SELECT backend_type, state, wait_event_type, count(*) AS connections
FROM pg_stat_activity WHERE datname = current_database()
GROUP BY backend_type, state, wait_event_type;
SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, temp_bytes,
       deadlocks, stats_reset
FROM pg_stat_database WHERE datname = current_database();
SELECT scope, sum(requests) AS reserved_requests, sum(units) AS reserved_units
FROM public.resource_budget_buckets
WHERE expires_at > now() AND scope LIKE 'groq:%'
GROUP BY scope ORDER BY scope;
SELECT scope, count(*) AS live_leases FROM public.resource_budget_leases
WHERE expires_at > now() GROUP BY scope;
SELECT count(*) AS expired_budget_buckets FROM public.resource_budget_buckets
WHERE expires_at < now() - interval '1 day';
SELECT count(*) AS expired_rate_buckets FROM public.mahshar_rate_limits
WHERE bucket_start < now() - interval '2 days';
SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
  WHERE i.indexrelid = to_regclass('public.rate_limit_bucket_retention')
    AND i.indrelid = 'public.mahshar_rate_limits'::regclass
    AND i.indisvalid AND i.indisready AND i.indnkeyatts = 1 AND i.indpred IS NULL
    AND pg_get_indexdef(i.indexrelid, 1, true) = 'bucket_start') AS retention_index_ready;
ROLLBACK;
