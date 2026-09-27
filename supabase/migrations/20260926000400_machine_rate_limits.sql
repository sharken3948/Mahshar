CREATE TABLE IF NOT EXISTS public.mahshar_rate_limits (
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  bucket_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (key_hash, bucket_start)
);
ALTER TABLE public.mahshar_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mahshar_rate_limits FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.mahshar_take_rate_limit(p_key_hash text, p_limit integer, p_window_seconds integer)
RETURNS TABLE(allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE bucket timestamptz; current_count integer; elapsed integer;
BEGIN
  IF p_key_hash !~ '^[a-f0-9]{64}$' OR p_limit < 1 OR p_limit > 10000 OR p_window_seconds < 1 OR p_window_seconds > 3600
  THEN RAISE EXCEPTION 'invalid rate limit input'; END IF;
  bucket := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds);
  -- Bound storage per identity without requiring a scheduler or an external
  -- rate-limit service. The primary-key prefix makes this a small indexed delete.
  DELETE FROM public.mahshar_rate_limits
    WHERE key_hash=p_key_hash AND bucket_start < bucket-interval '1 hour';
  INSERT INTO public.mahshar_rate_limits(key_hash,bucket_start,request_count)
    VALUES(p_key_hash,bucket,1)
    ON CONFLICT(key_hash,bucket_start) DO UPDATE
      SET request_count=public.mahshar_rate_limits.request_count+1
      WHERE public.mahshar_rate_limits.request_count < p_limit
    RETURNING request_count INTO current_count;
  IF current_count IS NULL THEN
    SELECT request_count INTO current_count FROM public.mahshar_rate_limits
      WHERE key_hash=p_key_hash AND bucket_start=bucket;
    elapsed := floor(extract(epoch FROM clock_timestamp()-bucket));
    RETURN QUERY SELECT false, 0, greatest(1,p_window_seconds-elapsed);
  ELSE
    RETURN QUERY SELECT true, greatest(0,p_limit-current_count), 0;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_take_rate_limit(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_take_rate_limit(text,integer,integer) TO service_role;
