-- Admin Worker Agent Foundation V1. These tables are server/Admin-only and
-- intentionally have no browser role policies. The RPCs below serialize the
-- one-active-batch lifecycle and persist compact checkpoints in Supabase.

CREATE TABLE public.worker_control (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  desired_state text NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('stopped', 'running')),
  batch_size integer NOT NULL DEFAULT 50 CHECK (batch_size BETWEEN 1 AND 100),
  current_checkpoint jsonb,
  checkpoint_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    current_checkpoint IS NULL OR (
      jsonb_typeof(current_checkpoint) = 'object'
      AND octet_length(current_checkpoint::text) <= 256
    )
  ),
  CHECK ((current_checkpoint IS NULL) = (checkpoint_run_id IS NULL))
);

INSERT INTO public.worker_control(id, desired_state, batch_size, current_checkpoint, checkpoint_run_id)
VALUES (1, 'stopped', 50, NULL, NULL);

CREATE TABLE public.worker_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  status text NOT NULL CHECK (status IN (
    'queued', 'running', 'stop_requested', 'stopped', 'completed', 'failed'
  )),
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 100),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0 AND processed_count <= batch_size),
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0 AND discovered_count <= processed_count),
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0 AND duplicate_count <= processed_count),
  filtered_count integer NOT NULL DEFAULT 0 CHECK (filtered_count >= 0 AND filtered_count <= processed_count),
  qualified_count integer NOT NULL DEFAULT 0 CHECK (qualified_count >= 0 AND qualified_count <= processed_count),
  persisted_count integer NOT NULL DEFAULT 0 CHECK (persisted_count >= 0 AND persisted_count <= processed_count),
  checkpoint jsonb NOT NULL,
  workflow_run_id text UNIQUE CHECK (
    workflow_run_id IS NULL OR (length(workflow_run_id) BETWEEN 1 AND 128 AND workflow_run_id ~ '^[A-Za-z0-9_-]+$')
  ),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  stopped_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 256),
  CHECK (status <> 'completed' OR processed_count = batch_size),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

ALTER TABLE public.worker_control
  ADD CONSTRAINT worker_control_checkpoint_run_fk
  FOREIGN KEY (checkpoint_run_id) REFERENCES public.worker_runs(id);

CREATE UNIQUE INDEX worker_runs_one_active
  ON public.worker_runs ((true))
  WHERE status IN ('queued', 'running', 'stop_requested');
CREATE INDEX worker_runs_recent ON public.worker_runs(created_at DESC);

CREATE TABLE public.worker_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 200),
  canonical_domain text NOT NULL UNIQUE
    CHECK (length(canonical_domain) BETWEEN 1 AND 253 AND canonical_domain = lower(canonical_domain)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rejected', 'do_not_contact')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.worker_provider_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  identity_type text NOT NULL CHECK (identity_type IN ('domain', 'github_org', 'postman_team', 'rapidapi_org')),
  normalized_value text NOT NULL CHECK (
    length(normalized_value) BETWEEN 1 AND 253 AND normalized_value = lower(normalized_value)
  ),
  original_value text NOT NULL CHECK (length(original_value) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_type, normalized_value)
);

CREATE TABLE public.worker_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  normalized_product_key text NOT NULL CHECK (
    length(normalized_product_key) BETWEEN 1 AND 160 AND normalized_product_key = lower(normalized_product_key)
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'active', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, normalized_product_key),
  UNIQUE (id, provider_id)
);

CREATE TABLE public.worker_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  product_id uuid,
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered', 'qualified', 'reviewed', 'contact_ready', 'contacted',
    'replied', 'interested', 'listed', 'rejected', 'do_not_contact', 'closed'
  )),
  fit_score numeric(5,2) CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100),
  fit_reason text CHECK (fit_reason IS NULL OR length(fit_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, provider_id),
  FOREIGN KEY (product_id, provider_id) REFERENCES public.worker_products(id, provider_id)
);

CREATE TABLE public.worker_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.worker_leads(id),
  source_type text NOT NULL CHECK (source_type IN ('website', 'github', 'postman', 'rapidapi', 'manual')),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  title text CHECK (title IS NULL OR length(title) <= 256),
  factual_summary text CHECK (factual_summary IS NULL OR length(factual_summary) <= 1000),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.worker_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  lead_id uuid,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'do_not_contact', 'reopened')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z0-9_]{1,80}$'),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (lead_id, provider_id) REFERENCES public.worker_leads(id, provider_id)
);

CREATE INDEX worker_provider_identities_provider ON public.worker_provider_identities(provider_id);
CREATE INDEX worker_products_provider ON public.worker_products(provider_id);
CREATE INDEX worker_leads_provider_status ON public.worker_leads(provider_id, status);
CREATE INDEX worker_sources_lead ON public.worker_sources(lead_id);
CREATE INDEX worker_decisions_provider_created ON public.worker_decisions(provider_id, created_at DESC);

ALTER TABLE public.worker_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_provider_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.worker_control, public.worker_runs, public.worker_providers,
  public.worker_provider_identities, public.worker_products, public.worker_leads,
  public.worker_sources, public.worker_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.worker_control, public.worker_runs,
  public.worker_providers, public.worker_provider_identities, public.worker_products,
  public.worker_leads, public.worker_sources, public.worker_decisions TO service_role;
REVOKE ALL ON SEQUENCE public.worker_runs_run_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.worker_runs_run_number_seq TO service_role;

-- A Foundation batch normally completes in seconds. Fifteen minutes is a
-- conservative lease: it permits platform retries without allowing an
-- orphaned active row to block Admin control indefinitely.
CREATE OR REPLACE FUNCTION public.mahshar_worker_reconcile_stale_run()
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  control_row public.worker_control;
  target public.worker_runs;
BEGIN
  SELECT * INTO control_row FROM public.worker_control WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_control_unavailable'; END IF;

  SELECT * INTO target FROM public.worker_runs
  WHERE status IN ('queued', 'running', 'stop_requested')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Reconcile only a recognized active/control pairing whose heartbeat lease
  -- has expired. A healthy or contradictory row is never changed by time alone.
  IF NOT (
      (control_row.desired_state = 'running' AND target.status IN ('queued', 'running'))
      OR (control_row.desired_state = 'stopped' AND target.status = 'stop_requested')
    ) OR target.heartbeat_at >= clock_timestamp() - interval '15 minutes'
  THEN
    RETURN NULL;
  END IF;

  UPDATE public.worker_runs
  SET status = 'failed', error_code = 'worker_run_stale', updated_at = clock_timestamp()
  WHERE id = target.id
  RETURNING * INTO target;
  UPDATE public.worker_control
  SET desired_state = 'stopped', current_checkpoint = target.checkpoint,
    checkpoint_run_id = target.id, updated_at = clock_timestamp()
  WHERE id = 1;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_create_run(p_resume boolean DEFAULT false)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  control_row public.worker_control;
  source_run public.worker_runs;
  checkpoint_value jsonb;
  next_index integer;
  created_run public.worker_runs;
BEGIN
  PERFORM public.mahshar_worker_reconcile_stale_run();
  SELECT * INTO control_row FROM public.worker_control WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_control_unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.worker_runs WHERE status IN ('queued', 'running', 'stop_requested')) THEN
    RAISE EXCEPTION 'worker_already_active';
  END IF;

  IF p_resume THEN
    checkpoint_value := control_row.current_checkpoint;
    IF checkpoint_value IS NULL OR control_row.checkpoint_run_id IS NULL
      OR jsonb_typeof(checkpoint_value) <> 'object'
      OR (checkpoint_value->>'version') IS NULL OR (checkpoint_value->>'version') !~ '^[0-9]+$'
      OR (checkpoint_value->>'nextIndex') IS NULL OR (checkpoint_value->>'nextIndex') !~ '^[0-9]+$'
      OR (checkpoint_value->>'batchSize') IS NULL OR (checkpoint_value->>'batchSize') !~ '^[0-9]+$'
    THEN RAISE EXCEPTION 'worker_checkpoint_invalid'; END IF;
    next_index := (checkpoint_value->>'nextIndex')::integer;
    IF (checkpoint_value->>'version')::integer <> 1
      OR (checkpoint_value->>'batchSize')::integer <> control_row.batch_size
      OR next_index <= 0 OR next_index >= control_row.batch_size
    THEN RAISE EXCEPTION 'worker_not_resumable'; END IF;

    SELECT * INTO source_run FROM public.worker_runs
    WHERE id = control_row.checkpoint_run_id FOR UPDATE;
    IF NOT FOUND OR source_run.status NOT IN ('stopped', 'failed')
      OR source_run.batch_size <> control_row.batch_size
      OR source_run.processed_count <> next_index
      OR source_run.checkpoint <> checkpoint_value
    THEN RAISE EXCEPTION 'worker_checkpoint_provenance_invalid'; END IF;
  ELSE
    next_index := 0;
    checkpoint_value := jsonb_build_object(
      'version', 1, 'nextIndex', next_index, 'batchSize', control_row.batch_size
    );
  END IF;

  INSERT INTO public.worker_runs(status, batch_size, processed_count, checkpoint, heartbeat_at)
  VALUES ('queued', control_row.batch_size, next_index, checkpoint_value, clock_timestamp())
  RETURNING * INTO created_run;
  UPDATE public.worker_control
  SET desired_state = 'running', current_checkpoint = checkpoint_value,
    checkpoint_run_id = created_run.id, updated_at = clock_timestamp()
  WHERE id = 1;
  RETURN created_run;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_request_stop()
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE active_run public.worker_runs;
BEGIN
  PERFORM 1 FROM public.worker_control WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_control_unavailable'; END IF;
  UPDATE public.worker_control SET desired_state = 'stopped', updated_at = clock_timestamp() WHERE id = 1;
  UPDATE public.worker_runs
  SET status = 'stop_requested', heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE status IN ('queued', 'running')
  RETURNING * INTO active_run;
  RETURN active_run;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_run(p_run_id uuid)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE control_row public.worker_control; target public.worker_runs;
BEGIN
  SELECT * INTO control_row FROM public.worker_control WHERE id = 1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status IN ('stopped', 'completed', 'failed') THEN RETURN target; END IF;
  IF control_row.desired_state = 'stopped' OR target.status = 'stop_requested' THEN
    UPDATE public.worker_runs SET status = 'stopped', stopped_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
    UPDATE public.worker_control SET current_checkpoint = target.checkpoint,
      checkpoint_run_id = target.id, updated_at = clock_timestamp() WHERE id = 1;
    RETURN target;
  END IF;
  IF target.status = 'queued' THEN
    UPDATE public.worker_runs SET status = 'running', started_at = clock_timestamp(),
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
  ELSIF target.status = 'running' THEN
    UPDATE public.worker_runs SET heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
  END IF;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_advance_run(
  p_run_id uuid,
  p_expected_next_index integer,
  p_next_index integer
)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE control_row public.worker_control; target public.worker_runs; current_index integer; next_checkpoint jsonb;
BEGIN
  SELECT * INTO control_row FROM public.worker_control WHERE id = 1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status IN ('stopped', 'completed', 'failed') THEN RETURN target; END IF;
  IF control_row.desired_state = 'stopped' OR target.status = 'stop_requested' THEN
    UPDATE public.worker_runs SET status = 'stopped', stopped_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
    UPDATE public.worker_control SET current_checkpoint = target.checkpoint,
      checkpoint_run_id = target.id, updated_at = clock_timestamp() WHERE id = 1;
    RETURN target;
  END IF;
  IF target.status <> 'running' THEN RAISE EXCEPTION 'worker_run_not_running'; END IF;
  IF jsonb_typeof(target.checkpoint) <> 'object'
    OR (target.checkpoint->>'version') <> '1'
    OR (target.checkpoint->>'batchSize') IS NULL
    OR (target.checkpoint->>'batchSize') !~ '^[0-9]+$'
    OR (target.checkpoint->>'batchSize')::integer <> target.batch_size
    OR (target.checkpoint->>'nextIndex') IS NULL
    OR (target.checkpoint->>'nextIndex') !~ '^[0-9]+$'
  THEN RAISE EXCEPTION 'worker_checkpoint_invalid'; END IF;
  current_index := (target.checkpoint->>'nextIndex')::integer;
  IF target.processed_count <> current_index
    OR control_row.checkpoint_run_id IS DISTINCT FROM target.id
    OR control_row.current_checkpoint IS DISTINCT FROM target.checkpoint
  THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  IF p_expected_next_index < 0 OR p_next_index <= p_expected_next_index
    OR p_next_index <> least(p_expected_next_index + 10, target.batch_size)
  THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  IF current_index >= p_next_index THEN
    UPDATE public.worker_runs SET heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = p_run_id RETURNING * INTO target;
    RETURN target;
  END IF;
  IF current_index <> p_expected_next_index THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;

  next_checkpoint := jsonb_build_object(
    'version', 1, 'nextIndex', p_next_index, 'batchSize', target.batch_size
  );
  UPDATE public.worker_runs SET processed_count = p_next_index, checkpoint = next_checkpoint,
    heartbeat_at = clock_timestamp(),
    updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
  UPDATE public.worker_control SET current_checkpoint = next_checkpoint,
    checkpoint_run_id = target.id, updated_at = clock_timestamp() WHERE id = 1;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_complete_run(p_run_id uuid)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE control_row public.worker_control; target public.worker_runs;
BEGIN
  SELECT * INTO control_row FROM public.worker_control WHERE id = 1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status IN ('stopped', 'completed', 'failed') THEN RETURN target; END IF;
  IF control_row.desired_state = 'stopped' OR target.status = 'stop_requested' THEN
    UPDATE public.worker_runs SET status = 'stopped', stopped_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
  ELSE
    IF target.status <> 'running' OR target.processed_count <> target.batch_size
      OR (target.checkpoint->>'nextIndex')::integer <> target.batch_size
    THEN RAISE EXCEPTION 'worker_run_incomplete'; END IF;
    UPDATE public.worker_runs SET status = 'completed', completed_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
  END IF;
  UPDATE public.worker_control SET desired_state = 'stopped', current_checkpoint = target.checkpoint,
    checkpoint_run_id = target.id, updated_at = clock_timestamp() WHERE id = 1;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_fail_run(p_run_id uuid, p_error_code text)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target public.worker_runs;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,80}$' THEN
    RAISE EXCEPTION 'worker_error_code_invalid';
  END IF;
  PERFORM 1 FROM public.worker_control WHERE id = 1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status IN ('queued', 'running', 'stop_requested') THEN
    UPDATE public.worker_runs SET status = 'failed', error_code = p_error_code,
      updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
    UPDATE public.worker_control SET desired_state = 'stopped', current_checkpoint = target.checkpoint,
      checkpoint_run_id = target.id, updated_at = clock_timestamp() WHERE id = 1;
  END IF;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_attach_workflow_run(
  p_run_id uuid,
  p_workflow_run_id text
)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target public.worker_runs;
BEGIN
  IF p_workflow_run_id IS NULL OR length(p_workflow_run_id) > 128
    OR p_workflow_run_id !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'workflow_run_id_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.workflow_run_id IS NOT NULL AND target.workflow_run_id <> p_workflow_run_id THEN
    RAISE EXCEPTION 'workflow_run_id_conflict';
  END IF;
  UPDATE public.worker_runs SET workflow_run_id = p_workflow_run_id,
    heartbeat_at = CASE WHEN status IN ('queued', 'running', 'stop_requested')
      THEN clock_timestamp() ELSE heartbeat_at END,
    updated_at = clock_timestamp() WHERE id = p_run_id RETURNING * INTO target;
  RETURN target;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_reconcile_stale_run() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_create_run(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_request_stop() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_advance_run(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_complete_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_fail_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mahshar_worker_attach_workflow_run(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_reconcile_stale_run() TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_create_run(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_request_stop() TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_advance_run(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_complete_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_fail_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_attach_workflow_run(uuid, text) TO service_role;
