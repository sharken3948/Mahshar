CREATE OR REPLACE FUNCTION public.mahshar_agent_listing_stats(p_api_ids uuid[])
RETURNS TABLE(api_id uuid, total_calls bigint, successful_calls bigint, avg_latency_ms numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT calls.api_id,
         count(*) AS total_calls,
         count(*) FILTER (WHERE calls.success) AS successful_calls,
         avg(calls.latency_ms)::numeric AS avg_latency_ms
  FROM public.api_calls AS calls
  WHERE calls.api_id = ANY(p_api_ids)
  GROUP BY calls.api_id
$$;

REVOKE ALL ON FUNCTION public.mahshar_agent_listing_stats(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_agent_listing_stats(uuid[]) TO service_role;
