-- Public catalog access must go through server routes that return an explicit
-- column allowlist. PostgreSQL row policies do not hide individual columns, so
-- the previous public SELECT policy exposed endpoint_url/encrypted_key to any
-- caller with the Supabase anon key.
DROP POLICY IF EXISTS "public read active listings" ON public.api_listings;
REVOKE SELECT ON public.api_listings FROM anon, authenticated;

-- Server routes use the service role and remain responsible for returning only
-- the public catalog projection. No direct browser table access is required.
