-- Supabase's public-schema default ACL grants service_role all privileges on
-- new tables and sequences. Reset only Worker object ACLs after creation.
REVOKE ALL PRIVILEGES ON TABLE
  public.worker_control,
  public.worker_runs,
  public.worker_providers,
  public.worker_provider_identities,
  public.worker_products,
  public.worker_leads,
  public.worker_sources,
  public.worker_decisions
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.worker_control,
  public.worker_runs,
  public.worker_providers,
  public.worker_provider_identities,
  public.worker_products,
  public.worker_leads,
  public.worker_sources,
  public.worker_decisions
TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.worker_runs_run_number_seq
FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SEQUENCE public.worker_runs_run_number_seq TO service_role;
