SET lock_timeout = '2s';
SET statement_timeout = '15s';

-- Additive operational accounting only. No payment, listing, or historical schema changes.
CREATE TABLE public.resource_budget_buckets (
  scope text NOT NULL, bucket_start timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  units bigint NOT NULL DEFAULT 0 CHECK (units >= 0), PRIMARY KEY (scope, bucket_start)
);
CREATE INDEX resource_budget_expiry ON public.resource_budget_buckets(expires_at);
CREATE TABLE public.resource_budget_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX resource_lease_scope_expiry ON public.resource_budget_leases(scope, expires_at);
ALTER TABLE public.resource_budget_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_budget_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.resource_budget_buckets, public.resource_budget_leases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.resource_budget_buckets, public.resource_budget_leases TO service_role;

CREATE FUNCTION public.mahshar_reserve_resource(p_buckets jsonb, p_units bigint DEFAULT 0,
  p_lease_scope text DEFAULT NULL, p_concurrency integer DEFAULT 0)
RETURNS TABLE(allowed boolean, lease_id uuid, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE b jsonb; t timestamptz; start_at timestamptz; seconds integer;
  max_requests bigint; max_units bigint; existing public.resource_budget_buckets%ROWTYPE; lease uuid;
BEGIN
  IF jsonb_typeof(p_buckets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_buckets) NOT BETWEEN 1 AND 4
    OR p_units IS NULL OR p_units NOT BETWEEN 0 AND 100000000
    OR p_concurrency IS NULL OR p_concurrency NOT BETWEEN 0 AND 32
    OR (p_lease_scope IS NULL) <> (p_concurrency = 0)
    OR (p_lease_scope IS NOT NULL AND p_lease_scope !~ '^[a-z0-9:_-]{1,96}$') THEN
    RAISE EXCEPTION 'invalid_resource_budget';
  END IF;
  IF (SELECT count(DISTINCT value->>'scope') FROM jsonb_array_elements(p_buckets)) <> jsonb_array_length(p_buckets)
    THEN RAISE EXCEPTION 'duplicate_resource_scope'; END IF;
  -- Canonical ordering avoids deadlock between feature and shared reservations.
  FOR b IN SELECT value FROM jsonb_array_elements(p_buckets) ORDER BY value->>'scope' LOOP
    IF b->>'scope' IS NULL OR b->>'scope' !~ '^[a-z0-9:_-]{1,96}$'
      OR b->>'window_seconds' IS NULL OR (b->>'window_seconds')::integer NOT IN (60,3600,86400)
      OR b->>'request_limit' IS NULL OR (b->>'request_limit')::bigint NOT BETWEEN 1 AND 100000000
      OR b->>'unit_limit' IS NULL OR (b->>'unit_limit')::bigint NOT BETWEEN 1 AND 100000000 THEN
      RAISE EXCEPTION 'invalid_resource_bucket'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('resource:' || (b->>'scope'), 0));
  END LOOP;
  IF p_lease_scope IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('resource-lease:' || p_lease_scope, 0));
  END IF;
  t := clock_timestamp();
  IF p_lease_scope IS NOT NULL AND
    (SELECT count(*) FROM public.resource_budget_leases WHERE scope = p_lease_scope AND expires_at > t) >= p_concurrency THEN
    RETURN QUERY SELECT false, NULL::uuid, 60; RETURN;
  END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p_buckets) LOOP
    seconds := (b->>'window_seconds')::integer;
    start_at := to_timestamp(floor(extract(epoch FROM t) / seconds) * seconds);
    SELECT * INTO existing FROM public.resource_budget_buckets WHERE scope = b->>'scope' AND bucket_start = start_at;
    max_requests := (b->>'request_limit')::bigint; max_units := (b->>'unit_limit')::bigint;
    IF coalesce(existing.requests, 0) + 1 > max_requests OR coalesce(existing.units, 0) + p_units > max_units THEN
      RETURN QUERY SELECT false, NULL::uuid, greatest(1, ceil(extract(epoch FROM start_at + make_interval(secs => seconds) - t))::integer);
      RETURN;
    END IF;
  END LOOP;
  FOR b IN SELECT value FROM jsonb_array_elements(p_buckets) LOOP
    seconds := (b->>'window_seconds')::integer;
    start_at := to_timestamp(floor(extract(epoch FROM t) / seconds) * seconds);
    INSERT INTO public.resource_budget_buckets(scope, bucket_start, expires_at, requests, units)
      VALUES(b->>'scope', start_at, start_at + make_interval(secs => seconds), 1, p_units)
      ON CONFLICT(scope, bucket_start) DO UPDATE SET requests = resource_budget_buckets.requests + 1,
        units = resource_budget_buckets.units + excluded.units;
  END LOOP;
  IF p_lease_scope IS NOT NULL THEN
    INSERT INTO public.resource_budget_leases(scope, expires_at) VALUES(p_lease_scope, t + interval '60 seconds') RETURNING id INTO lease;
  END IF;
  RETURN QUERY SELECT true, lease, 0;
END $$;

CREATE FUNCTION public.mahshar_release_resource(p_lease_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.resource_budget_leases WHERE id = p_lease_id;
$$;

-- Explicit maintenance RPC: bounded batches, no automatic job and no financial records.
CREATE FUNCTION public.mahshar_prune_resource_records(p_batch integer DEFAULT 500)
RETURNS TABLE(budgets integer, leases integer, rate_limits integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE n1 integer; n2 integer; n3 integer;
BEGIN
  IF p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid_batch'; END IF;
  DELETE FROM public.resource_budget_buckets WHERE ctid IN
    (SELECT ctid FROM public.resource_budget_buckets WHERE expires_at < now() - interval '1 day'
     ORDER BY expires_at LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n1 = ROW_COUNT;
  DELETE FROM public.resource_budget_leases WHERE ctid IN
    (SELECT ctid FROM public.resource_budget_leases WHERE expires_at < now()
     ORDER BY expires_at LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n2 = ROW_COUNT;
  n3 := 0;
  -- The existing limiter is used by payment ingress too. Build its new expiry
  -- index CONCURRENTLY in the separately approved operational step, never under
  -- a transaction-wide write-blocking index build. Skip retention until valid.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = to_regclass('public.rate_limit_bucket_retention')
      AND i.indrelid = 'public.mahshar_rate_limits'::regclass
      AND i.indisvalid AND i.indisready AND i.indnkeyatts = 1 AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'bucket_start') THEN
    DELETE FROM public.mahshar_rate_limits WHERE ctid IN
      (SELECT ctid FROM public.mahshar_rate_limits WHERE bucket_start < now() - interval '2 days'
       ORDER BY bucket_start LIMIT p_batch FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS n3 = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT n1,n2,n3;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_reserve_resource(jsonb,bigint,text,integer),
  public.mahshar_release_resource(uuid), public.mahshar_prune_resource_records(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_reserve_resource(jsonb,bigint,text,integer),
  public.mahshar_release_resource(uuid), public.mahshar_prune_resource_records(integer) TO service_role;

RESET lock_timeout;
RESET statement_timeout;
