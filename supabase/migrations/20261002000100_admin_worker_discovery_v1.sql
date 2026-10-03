-- Admin Worker Discovery V1. Adds a compact, durable work queue and structured
-- qualification fields without granting browser roles access to Worker data.

ALTER TABLE public.worker_runs
  ADD COLUMN discovery_batch_id uuid,
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN source_query_count integer NOT NULL DEFAULT 0 CHECK (source_query_count BETWEEN 0 AND 60),
  ADD COLUMN research_fetch_count integer NOT NULL DEFAULT 0 CHECK (research_fetch_count BETWEEN 0 AND 50),
  ADD COLUMN groq_call_count integer NOT NULL DEFAULT 0 CHECK (groq_call_count BETWEEN 0 AND 20);

UPDATE public.worker_runs SET discovery_batch_id = id;
UPDATE public.worker_runs SET deadline_at = coalesce(started_at, created_at) + interval '10 minutes';
ALTER TABLE public.worker_runs ALTER COLUMN discovery_batch_id SET NOT NULL;
ALTER TABLE public.worker_runs ALTER COLUMN deadline_at SET NOT NULL;
ALTER TABLE public.worker_runs ADD CONSTRAINT worker_runs_discovery_batch_fk
  FOREIGN KEY (discovery_batch_id) REFERENCES public.worker_runs(id);
CREATE INDEX worker_runs_discovery_batch ON public.worker_runs(discovery_batch_id);

ALTER TABLE public.worker_providers ADD CONSTRAINT worker_provider_domain_shape CHECK (
  canonical_domain ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$'
);

CREATE TABLE public.worker_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_batch_id uuid NOT NULL REFERENCES public.worker_runs(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  source_type text NOT NULL CHECK (source_type IN ('api_directory')),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  discovered_name text NOT NULL CHECK (length(discovered_name) BETWEEN 1 AND 200),
  discovered_domain text CHECK (discovered_domain IS NULL OR length(discovered_domain) BETWEEN 1 AND 253),
  discovered_product text CHECK (discovered_product IS NULL OR length(discovered_product) BETWEEN 1 AND 200),
  discovered_contract_url text CHECK (discovered_contract_url IS NULL OR length(discovered_contract_url) <= 2048),
  discovered_docs_url text CHECK (discovered_docs_url IS NULL OR length(discovered_docs_url) <= 2048),
  discovered_pricing_url text CHECK (discovered_pricing_url IS NULL OR length(discovered_pricing_url) <= 2048),
  discovered_contact_url text CHECK (discovered_contact_url IS NULL OR length(discovered_contact_url) <= 2048),
  source_summary text CHECK (source_summary IS NULL OR length(source_summary) <= 700),
  normalized_domain text CHECK (normalized_domain IS NULL OR (
    length(normalized_domain) BETWEEN 1 AND 253 AND normalized_domain = lower(normalized_domain)
  )),
  normalized_product_key text CHECK (normalized_product_key IS NULL OR (
    length(normalized_product_key) BETWEEN 1 AND 160 AND normalized_product_key = lower(normalized_product_key)
  )),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'duplicate', 'blocked', 'filtered', 'deferred', 'persisted'
  )),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,80}$'),
  provider_id uuid REFERENCES public.worker_providers(id),
  product_id uuid REFERENCES public.worker_products(id),
  lead_id uuid REFERENCES public.worker_leads(id),
  deferred_claim_batch_id uuid REFERENCES public.worker_runs(id),
  deferred_claim_order smallint CHECK (deferred_claim_order IS NULL OR deferred_claim_order BETWEEN 1 AND 10),
  processing_lease_id uuid,
  processing_lease_expires_at timestamptz,
  processing_attempt integer NOT NULL DEFAULT 0 CHECK (processing_attempt >= 0),
  terminal_at timestamptz,
  retention_eligible_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discovery_batch_id, ordinal)
);

CREATE TABLE public.worker_budget_claims (
  discovery_batch_id uuid NOT NULL REFERENCES public.worker_runs(id),
  budget_type text NOT NULL CHECK (budget_type IN ('source', 'research', 'groq')),
  claim_key text NOT NULL CHECK (claim_key ~ '^[a-z0-9:_-]{1,120}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discovery_batch_id, budget_type, claim_key)
);

CREATE TABLE public.worker_deferred_claims (
  discovery_batch_id uuid NOT NULL REFERENCES public.worker_runs(id),
  claim_key text NOT NULL CHECK (claim_key ~ '^[a-z0-9:_-]{1,120}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discovery_batch_id, claim_key)
);

CREATE TABLE public.worker_source_work (
  discovery_batch_id uuid NOT NULL REFERENCES public.worker_runs(id),
  claim_key text NOT NULL CHECK (claim_key ~ '^[a-z0-9:_-]{1,120}$'),
  work_kind text NOT NULL CHECK (work_kind IN ('provider_window', 'candidate')),
  compact_result jsonb NOT NULL CHECK (
    jsonb_typeof(compact_result) = 'object'
    AND octet_length(compact_result::text) <= 32768
  ),
  retention_eligible_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discovery_batch_id, claim_key)
);

ALTER TABLE public.worker_leads
  ADD COLUMN qualification_status text NOT NULL DEFAULT 'pending'
    CHECK (qualification_status IN ('pending', 'qualified', 'rejected', 'deferred')),
  ADD COLUMN commercial_api boolean,
  ADD COLUMN agent_utility text CHECK (agent_utility IS NULL OR agent_utility IN ('low', 'medium', 'high')),
  ADD COLUMN pay_per_call_fit text CHECK (pay_per_call_fit IS NULL OR pay_per_call_fit IN ('low', 'medium', 'high')),
  ADD COLUMN integration_difficulty text CHECK (integration_difficulty IS NULL OR integration_difficulty IN ('low', 'medium', 'high')),
  ADD COLUMN provider_credibility text CHECK (provider_credibility IS NULL OR provider_credibility IN ('low', 'medium', 'high')),
  ADD COLUMN qualification_reason_codes text[] NOT NULL DEFAULT '{}'::text[] CHECK (
    cardinality(qualification_reason_codes) <= 8
    AND array_to_string(qualification_reason_codes, ',') ~ '^[a-z0-9_,]*$'
    AND octet_length(array_to_string(qualification_reason_codes, ',')) <= 320
  ),
  ADD COLUMN qualification_model text CHECK (qualification_model IS NULL OR length(qualification_model) <= 120),
  ADD COLUMN qualified_at timestamptz,
  ADD COLUMN qualification_retry_after timestamptz;

ALTER TABLE public.worker_leads ADD CONSTRAINT worker_leads_product_unique UNIQUE (product_id);

ALTER TABLE public.worker_sources
  DROP CONSTRAINT worker_sources_source_type_check;
ALTER TABLE public.worker_sources
  ADD CONSTRAINT worker_sources_source_type_check CHECK (
    source_type IN ('website', 'github', 'postman', 'rapidapi', 'manual', 'api_directory')
  ),
  ADD COLUMN source_role text NOT NULL DEFAULT 'directory_assertion' CHECK (
    source_role IN ('directory_assertion', 'official_site', 'official_docs', 'official_pricing', 'official_contact')
  );
CREATE UNIQUE INDEX worker_sources_lead_url ON public.worker_sources(lead_id, url);

CREATE INDEX worker_candidates_batch_status
  ON public.worker_candidates(discovery_batch_id, status, ordinal);
CREATE INDEX worker_candidates_deferred_retry
  ON public.worker_candidates(status, processing_lease_expires_at, updated_at, id) WHERE status = 'deferred';
CREATE INDEX worker_leads_qualified_recent
  ON public.worker_leads(created_at DESC) WHERE status = 'qualified';

ALTER TABLE public.worker_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_budget_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_deferred_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_source_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.worker_candidates
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.worker_candidates TO service_role;
REVOKE ALL PRIVILEGES ON TABLE public.worker_budget_claims
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.worker_budget_claims TO service_role;
REVOKE ALL PRIVILEGES ON TABLE public.worker_deferred_claims
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.worker_deferred_claims TO service_role;
REVOKE ALL PRIVILEGES ON TABLE public.worker_source_work
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.worker_source_work TO service_role;

-- Discovery retries add outcomes without advancing the fresh raw-candidate
-- range, so cumulative outcome counters are intentionally not capped by
-- processed_count after this migration.
DO $worker_counter_constraints$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_runs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ '(duplicate_count|filtered_count|qualified_count|persisted_count) <= processed_count'
  LOOP
    EXECUTE format('ALTER TABLE public.worker_runs DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $worker_counter_constraints$;
ALTER TABLE public.worker_runs
  ADD CONSTRAINT worker_runs_duplicate_count_nonnegative CHECK (duplicate_count >= 0),
  ADD CONSTRAINT worker_runs_filtered_count_nonnegative CHECK (filtered_count >= 0),
  ADD CONSTRAINT worker_runs_qualified_count_nonnegative CHECK (qualified_count >= 0),
  ADD CONSTRAINT worker_runs_persisted_count_nonnegative CHECK (persisted_count >= 0);

-- Resume carries the logical batch id and cumulative counters forward. This
-- prevents repeated source/Groq work from escaping the per-batch budgets.
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
  new_run_id uuid := gen_random_uuid();
  created_run public.worker_runs;
BEGIN
  PERFORM public.mahshar_worker_reconcile_stale_run();
  SELECT * INTO control_row FROM public.worker_control WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_control_unavailable'; END IF;
  IF control_row.batch_size <> 50 THEN RAISE EXCEPTION 'worker_discovery_batch_size_invalid'; END IF;
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
    checkpoint_value := jsonb_build_object('version', 1, 'nextIndex', 0, 'batchSize', control_row.batch_size);
  END IF;

  INSERT INTO public.worker_runs(
    id, status, batch_size, processed_count, discovered_count, duplicate_count,
    filtered_count, qualified_count, persisted_count, checkpoint, heartbeat_at,
    discovery_batch_id, deadline_at, source_query_count, research_fetch_count, groq_call_count
  ) VALUES (
    new_run_id, 'queued', control_row.batch_size, next_index,
    CASE WHEN p_resume THEN source_run.discovered_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.duplicate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.filtered_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.qualified_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.persisted_count ELSE 0 END,
    checkpoint_value, clock_timestamp(),
    CASE WHEN p_resume THEN source_run.discovery_batch_id ELSE new_run_id END,
    CASE WHEN p_resume THEN source_run.deadline_at ELSE clock_timestamp() + interval '10 minutes' END,
    CASE WHEN p_resume THEN source_run.source_query_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.research_fetch_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.groq_call_count ELSE 0 END
  ) RETURNING * INTO created_run;
  UPDATE public.worker_control
    SET desired_state = 'running', current_checkpoint = checkpoint_value,
      checkpoint_run_id = created_run.id, updated_at = clock_timestamp()
    WHERE id = 1;
  RETURN created_run;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_materialize_source_work(
  p_run_id uuid,
  p_claim_key text,
  p_work_kind text,
  p_compact_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.worker_runs;
  existing_result jsonb;
  claim_inserted integer;
BEGIN
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$'
    OR p_work_kind NOT IN ('provider_window', 'candidate')
    OR p_compact_result IS NULL OR jsonb_typeof(p_compact_result) <> 'object'
    OR octet_length(p_compact_result::text) > 32768
    OR p_compact_result->>'kind' IS DISTINCT FROM p_work_kind
    OR (p_work_kind = 'provider_window' AND CASE
      WHEN jsonb_typeof(p_compact_result->'providers') = 'array'
        THEN jsonb_array_length(p_compact_result->'providers') > 50
      ELSE true
    END)
  THEN RAISE EXCEPTION 'worker_source_work_invalid'; END IF;

  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  SELECT compact_result INTO existing_result FROM public.worker_source_work
    WHERE discovery_batch_id = target.discovery_batch_id AND claim_key = p_claim_key;
  IF FOUND THEN RETURN existing_result; END IF;
  IF target.status NOT IN ('running', 'stop_requested') OR target.deadline_at <= clock_timestamp() THEN RETURN NULL; END IF;

  INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
    VALUES(target.discovery_batch_id,'source',p_claim_key)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claim_inserted = ROW_COUNT;
  IF claim_inserted = 1 THEN
    IF target.source_query_count >= 60 THEN
      DELETE FROM public.worker_budget_claims WHERE discovery_batch_id = target.discovery_batch_id
        AND budget_type = 'source' AND claim_key = p_claim_key;
      RETURN NULL;
    END IF;
    UPDATE public.worker_runs SET source_query_count = source_query_count + 1,
      heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = p_run_id;
  END IF;

  INSERT INTO public.worker_source_work(discovery_batch_id,claim_key,work_kind,compact_result)
    VALUES(target.discovery_batch_id,p_claim_key,p_work_kind,p_compact_result)
    ON CONFLICT (discovery_batch_id,claim_key) DO NOTHING;
  SELECT compact_result INTO existing_result FROM public.worker_source_work
    WHERE discovery_batch_id = target.discovery_batch_id AND claim_key = p_claim_key;
  RETURN existing_result;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_budget(
  p_run_id uuid,
  p_budget text,
  p_claim_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target public.worker_runs;
BEGIN
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status NOT IN ('running', 'stop_requested') THEN RETURN false; END IF;
  IF target.deadline_at <= clock_timestamp() THEN RETURN false; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN
    RAISE EXCEPTION 'worker_budget_claim_key_invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.worker_budget_claims
    WHERE discovery_batch_id = target.discovery_batch_id
      AND budget_type = p_budget AND claim_key = p_claim_key
  ) THEN RETURN p_budget = 'source'; END IF;
  IF p_budget = 'source' AND target.source_query_count < 60 THEN
    INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
      VALUES(target.discovery_batch_id,p_budget,p_claim_key);
    UPDATE public.worker_runs SET source_query_count = source_query_count + 1,
      heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = p_run_id;
    RETURN true;
  ELSIF p_budget = 'research' AND target.research_fetch_count < 50 THEN
    INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
      VALUES(target.discovery_batch_id,p_budget,p_claim_key);
    UPDATE public.worker_runs SET research_fetch_count = research_fetch_count + 1,
      heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = p_run_id;
    RETURN true;
  ELSIF p_budget = 'groq' AND target.groq_call_count < 20 THEN
    INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
      VALUES(target.discovery_batch_id,p_budget,p_claim_key);
    UPDATE public.worker_runs SET groq_call_count = groq_call_count + 1,
      heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = p_run_id;
    RETURN true;
  END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_deferred_candidates(
  p_run_id uuid,
  p_claim_key text,
  p_limit integer DEFAULT 5
)
RETURNS TABLE(candidate_id uuid, lease_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.worker_runs;
  claim_inserted integer;
BEGIN
  IF p_limit <> 5 THEN RAISE EXCEPTION 'worker_deferred_limit_invalid'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_deferred_claim_key_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status NOT IN ('running', 'stop_requested') OR target.deadline_at <= clock_timestamp()
    OR target.discovery_batch_id <> target.id
  THEN RETURN; END IF;

  INSERT INTO public.worker_deferred_claims(discovery_batch_id, claim_key)
    VALUES(target.discovery_batch_id, p_claim_key)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claim_inserted = ROW_COUNT;
  IF claim_inserted = 0 THEN RETURN; END IF;

  RETURN QUERY WITH locked AS (
    SELECT candidate.id, coalesce(lead.qualification_retry_after, candidate.updated_at) AS retry_after
    FROM public.worker_candidates candidate
    LEFT JOIN public.worker_leads lead ON lead.id = candidate.lead_id
    WHERE candidate.status = 'deferred'
      AND candidate.discovery_batch_id <> target.discovery_batch_id
      AND candidate.discovered_domain IS NOT NULL
      AND candidate.discovered_product IS NOT NULL
      AND (candidate.discovered_contract_url IS NOT NULL OR candidate.discovered_docs_url IS NOT NULL)
      AND (
        (lead.id IS NULL AND candidate.reason_code IN ('research_budget_exhausted', 'run_budget_exhausted'))
        OR (lead.qualification_status = 'deferred'
          AND coalesce(lead.qualification_retry_after, '-infinity'::timestamptz) <= clock_timestamp())
      )
      AND (candidate.processing_lease_id IS NULL OR candidate.processing_lease_expires_at <= clock_timestamp())
    ORDER BY retry_after ASC, candidate.id ASC
    LIMIT 5
    FOR UPDATE OF candidate SKIP LOCKED
  ), eligible AS (
    SELECT id, row_number() OVER (
      ORDER BY retry_after ASC, id ASC
    )::smallint AS claim_order, gen_random_uuid() AS lease_id
    FROM locked
  ), updated AS (
  UPDATE public.worker_candidates candidate
    SET deferred_claim_batch_id = target.discovery_batch_id,
      deferred_claim_order = eligible.claim_order,
      processing_lease_id = eligible.lease_id,
      processing_lease_expires_at = clock_timestamp() + interval '5 minutes',
      processing_attempt = candidate.processing_attempt + 1,
      updated_at = clock_timestamp()
    FROM eligible WHERE candidate.id = eligible.id
    RETURNING candidate.id, candidate.processing_lease_id, candidate.deferred_claim_order
  )
  SELECT updated.id, updated.processing_lease_id FROM updated
  ORDER BY updated.deferred_claim_order, updated.id;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_resolve_discovery_lead(
  p_candidate_id uuid,
  p_lease_id uuid,
  p_domain text,
  p_product_key text,
  p_provider_name text,
  p_original_domain text,
  p_product_name text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  candidate public.worker_candidates;
  provider public.worker_providers;
  product public.worker_products;
  lead public.worker_leads;
  block_reason text;
BEGIN
  IF p_domain IS NULL OR p_domain !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$'
    OR p_product_key IS NULL OR p_product_key !~ '^[[:alnum:]][[:alnum:]-]{0,159}$'
    OR p_provider_name IS NULL OR length(p_provider_name) NOT BETWEEN 1 AND 200
    OR p_product_name IS NULL OR length(p_product_name) NOT BETWEEN 1 AND 200
  THEN RAISE EXCEPTION 'worker_discovery_identity_invalid'; END IF;

  SELECT * INTO candidate FROM public.worker_candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_candidate_not_found'; END IF;
  IF candidate.processing_lease_id IS DISTINCT FROM p_lease_id THEN RAISE EXCEPTION 'worker_candidate_lease_mismatch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_domain, 824611));

  SELECT provider_row.* INTO provider
  FROM public.worker_provider_identities identity
  JOIN public.worker_providers provider_row ON provider_row.id = identity.provider_id
  WHERE identity.identity_type = 'domain' AND identity.normalized_value = p_domain
  FOR UPDATE OF provider_row;
  IF NOT FOUND THEN
    SELECT * INTO provider FROM public.worker_providers WHERE canonical_domain = p_domain FOR UPDATE;
  END IF;

  IF FOUND THEN
    IF provider.status = 'do_not_contact' THEN block_reason := 'provider_do_not_contact';
    ELSIF provider.status = 'rejected' THEN block_reason := 'provider_rejected';
    ELSIF EXISTS (
      SELECT 1 FROM public.worker_decisions
      WHERE provider_id = provider.id AND lead_id IS NULL AND decision = 'do_not_contact'
    ) THEN block_reason := 'provider_do_not_contact';
    ELSIF EXISTS (
      SELECT 1 FROM public.worker_decisions
      WHERE provider_id = provider.id AND lead_id IS NULL AND decision = 'rejected'
    ) THEN block_reason := 'provider_rejected';
    END IF;
    IF block_reason IS NOT NULL THEN
      RETURN jsonb_build_object('action', 'blocked', 'reasonCode', block_reason, 'providerId', provider.id);
    END IF;
  ELSE
    INSERT INTO public.worker_providers(canonical_name, canonical_domain)
      VALUES (p_provider_name, p_domain) RETURNING * INTO provider;
  END IF;

  INSERT INTO public.worker_provider_identities(provider_id, identity_type, normalized_value, original_value)
    VALUES (provider.id, 'domain', p_domain, left(p_original_domain, 512))
    ON CONFLICT (identity_type, normalized_value) DO NOTHING;

  SELECT * INTO product FROM public.worker_products
    WHERE provider_id = provider.id AND normalized_product_key = p_product_key FOR UPDATE;
  IF FOUND AND product.status = 'rejected' THEN
    RETURN jsonb_build_object('action', 'blocked', 'reasonCode', 'product_rejected',
      'providerId', provider.id, 'productId', product.id);
  ELSIF NOT FOUND THEN
    INSERT INTO public.worker_products(provider_id, normalized_product_key, display_name)
      VALUES (provider.id, p_product_key, p_product_name) RETURNING * INTO product;
  END IF;

  SELECT * INTO lead FROM public.worker_leads WHERE product_id = product.id FOR UPDATE;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM public.worker_decisions WHERE lead_id = lead.id AND decision = 'do_not_contact')
      OR lead.status = 'do_not_contact'
    THEN
      RETURN jsonb_build_object('action', 'blocked', 'reasonCode', 'lead_decision_blocked',
        'providerId', provider.id, 'productId', product.id, 'leadId', lead.id);
    ELSIF EXISTS (SELECT 1 FROM public.worker_decisions WHERE lead_id = lead.id AND decision = 'rejected') THEN
      RETURN jsonb_build_object('action', 'blocked', 'reasonCode', 'lead_decision_blocked',
        'providerId', provider.id, 'productId', product.id, 'leadId', lead.id);
    ELSIF lead.status IN ('reviewed', 'contact_ready', 'contacted', 'replied', 'interested', 'listed', 'closed', 'rejected') THEN
      RETURN jsonb_build_object('action', 'duplicate', 'reasonCode', 'existing_human_state',
        'providerId', provider.id, 'productId', product.id, 'leadId', lead.id);
    END IF;
    IF lead.qualification_status = 'qualified' THEN
      RETURN jsonb_build_object('action', 'duplicate', 'reasonCode', 'existing_qualified_lead',
        'providerId', provider.id, 'productId', product.id, 'leadId', lead.id);
    ELSIF lead.qualification_status = 'rejected' THEN
      RETURN jsonb_build_object('action', 'duplicate', 'reasonCode', 'existing_rejected_lead',
        'providerId', provider.id, 'productId', product.id, 'leadId', lead.id);
    ELSIF lead.qualification_status = 'deferred' AND lead.qualification_retry_after > clock_timestamp() THEN
      RETURN jsonb_build_object('action', 'duplicate', 'reasonCode', 'qualification_deferred',
        'providerId', provider.id, 'productId', product.id, 'leadId', lead.id);
    END IF;
  ELSE
    INSERT INTO public.worker_leads(provider_id, product_id)
      VALUES (provider.id, product.id) RETURNING * INTO lead;
  END IF;

  UPDATE public.worker_candidates SET normalized_domain = p_domain,
    normalized_product_key = p_product_key, provider_id = provider.id,
    product_id = product.id, lead_id = lead.id, updated_at = clock_timestamp()
    WHERE id = candidate.id;
  RETURN jsonb_build_object('action', 'continue', 'providerId', provider.id,
    'productId', product.id, 'leadId', lead.id);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_complete_candidate(
  p_candidate_id uuid,
  p_lease_id uuid,
  p_status text,
  p_reason_code text,
  p_domain text DEFAULT NULL,
  p_product_key text DEFAULT NULL,
  p_provider_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE candidate public.worker_candidates; terminal boolean;
BEGIN
  IF p_status NOT IN ('duplicate', 'blocked', 'filtered', 'deferred', 'persisted')
    OR p_reason_code IS NULL OR p_reason_code !~ '^[a-z0-9_]{1,80}$'
  THEN RAISE EXCEPTION 'worker_candidate_outcome_invalid'; END IF;
  SELECT * INTO candidate FROM public.worker_candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_candidate_not_found'; END IF;
  IF candidate.status NOT IN ('pending', 'deferred') THEN
    RETURN jsonb_build_object('status', candidate.status, 'reasonCode', candidate.reason_code, 'applied', false);
  END IF;
  IF candidate.processing_lease_id IS DISTINCT FROM p_lease_id THEN RAISE EXCEPTION 'worker_candidate_lease_mismatch'; END IF;
  terminal := p_status <> 'deferred';
  UPDATE public.worker_candidates SET
    status = p_status, reason_code = p_reason_code,
    normalized_domain = coalesce(p_domain, normalized_domain),
    normalized_product_key = coalesce(p_product_key, normalized_product_key),
    provider_id = coalesce(p_provider_id, provider_id), product_id = coalesce(p_product_id, product_id),
    lead_id = coalesce(p_lead_id, lead_id), processing_lease_id = NULL, processing_lease_expires_at = NULL,
    terminal_at = CASE WHEN terminal THEN clock_timestamp() ELSE NULL END,
    retention_eligible_at = clock_timestamp() + CASE WHEN terminal THEN interval '30 days' ELSE interval '90 days' END,
    updated_at = clock_timestamp()
    WHERE id = p_candidate_id;
  RETURN jsonb_build_object('status', p_status, 'reasonCode', p_reason_code, 'applied', true);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_persist_qualification(
  p_candidate_id uuid,
  p_lease_id uuid,
  p_provider_id uuid,
  p_product_id uuid,
  p_lead_id uuid,
  p_qualification jsonb,
  p_model text,
  p_qualified boolean,
  p_deferred_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  candidate public.worker_candidates;
  provider public.worker_providers;
  product public.worker_products;
  lead public.worker_leads;
  outcome_status text;
  outcome_reason text;
  retry_at timestamptz;
BEGIN
  SELECT * INTO candidate FROM public.worker_candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_candidate_not_found'; END IF;
  IF candidate.status NOT IN ('pending', 'deferred') THEN
    RETURN jsonb_build_object('status', candidate.status, 'reasonCode', candidate.reason_code, 'applied', false);
  END IF;
  IF candidate.processing_lease_id IS DISTINCT FROM p_lease_id THEN RAISE EXCEPTION 'worker_candidate_lease_mismatch'; END IF;
  IF candidate.provider_id IS DISTINCT FROM p_provider_id OR candidate.product_id IS DISTINCT FROM p_product_id
    OR candidate.lead_id IS DISTINCT FROM p_lead_id
  THEN RAISE EXCEPTION 'worker_candidate_entity_mismatch'; END IF;

  SELECT * INTO provider FROM public.worker_providers WHERE id = p_provider_id FOR UPDATE;
  SELECT * INTO product FROM public.worker_products WHERE id = p_product_id AND provider_id = p_provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id = p_lead_id AND provider_id = p_provider_id AND product_id = p_product_id FOR UPDATE;
  IF provider.id IS NULL OR product.id IS NULL OR lead.id IS NULL THEN RAISE EXCEPTION 'worker_candidate_entity_mismatch'; END IF;

  IF provider.status = 'do_not_contact'
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE provider_id = p_provider_id AND lead_id IS NULL AND decision = 'do_not_contact')
    OR lead.status = 'do_not_contact'
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE lead_id = p_lead_id AND decision = 'do_not_contact')
  THEN outcome_status := 'blocked'; outcome_reason := 'do_not_contact';
  ELSIF provider.status = 'rejected' OR product.status = 'rejected'
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE provider_id = p_provider_id AND lead_id IS NULL AND decision = 'rejected')
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE lead_id = p_lead_id AND decision = 'rejected')
  THEN outcome_status := 'blocked'; outcome_reason := 'existing_rejection';
  ELSIF lead.status IN ('reviewed', 'contact_ready', 'contacted', 'replied', 'interested', 'listed', 'closed', 'rejected') THEN
    outcome_status := 'duplicate'; outcome_reason := 'existing_human_state';
  ELSIF lead.qualification_status = 'qualified' THEN
    outcome_status := 'persisted'; outcome_reason := 'qualified';
  ELSIF lead.qualification_status = 'rejected' THEN
    outcome_status := 'filtered'; outcome_reason := 'fit_below_threshold';
  ELSIF p_deferred_reason IS NOT NULL THEN
    IF p_deferred_reason !~ '^[a-z0-9_]{1,80}$' THEN RAISE EXCEPTION 'worker_qualification_defer_invalid'; END IF;
    retry_at := clock_timestamp() + CASE WHEN p_deferred_reason = 'groq_qualification_failed' THEN interval '1 hour' ELSE interval '0 seconds' END;
    UPDATE public.worker_leads SET qualification_status = 'deferred', fit_reason = p_deferred_reason,
      qualification_retry_after = retry_at, updated_at = clock_timestamp() WHERE id = p_lead_id AND status = 'discovered';
    outcome_status := 'deferred'; outcome_reason := p_deferred_reason;
  ELSE
    IF p_qualification IS NULL OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 120
      OR jsonb_typeof(p_qualification) <> 'object'
      OR (p_qualification->>'fitScore') IS NULL
      OR (p_qualification->>'fitScore')::numeric NOT BETWEEN 0 AND 100
      OR jsonb_typeof(p_qualification->'commercialApi') <> 'boolean'
      OR p_qualification->>'agentUtility' NOT IN ('low', 'medium', 'high')
      OR p_qualification->>'payPerCallFit' NOT IN ('low', 'medium', 'high')
      OR p_qualification->>'integrationDifficulty' NOT IN ('low', 'medium', 'high')
      OR p_qualification->>'providerCredibility' NOT IN ('low', 'medium', 'high')
      OR jsonb_typeof(p_qualification->'reasonCodes') <> 'array'
      OR coalesce(length(p_qualification->>'summary'), 0) NOT BETWEEN 1 AND 500
    THEN RAISE EXCEPTION 'worker_qualification_invalid'; END IF;
    UPDATE public.worker_leads SET status = CASE WHEN p_qualified THEN 'qualified' ELSE 'rejected' END,
      qualification_status = CASE WHEN p_qualified THEN 'qualified' ELSE 'rejected' END,
      fit_score = (p_qualification->>'fitScore')::numeric, fit_reason = p_qualification->>'summary',
      commercial_api = (p_qualification->>'commercialApi')::boolean,
      agent_utility = p_qualification->>'agentUtility', pay_per_call_fit = p_qualification->>'payPerCallFit',
      integration_difficulty = p_qualification->>'integrationDifficulty', provider_credibility = p_qualification->>'providerCredibility',
      qualification_reason_codes = ARRAY(SELECT jsonb_array_elements_text(p_qualification->'reasonCodes')),
      qualification_model = p_model, qualified_at = clock_timestamp(), qualification_retry_after = NULL,
      updated_at = clock_timestamp() WHERE id = p_lead_id AND status = 'discovered';
    IF NOT FOUND THEN RAISE EXCEPTION 'worker_lead_precedence_conflict'; END IF;
    IF NOT p_qualified THEN
      INSERT INTO public.worker_decisions(provider_id, lead_id, decision, reason_code)
        VALUES(p_provider_id, p_lead_id, 'rejected', 'fit_below_threshold');
      UPDATE public.worker_products SET status = 'rejected', updated_at = clock_timestamp() WHERE id = p_product_id;
      outcome_status := 'filtered'; outcome_reason := 'fit_below_threshold';
    ELSE outcome_status := 'persisted'; outcome_reason := 'qualified';
    END IF;
  END IF;

  UPDATE public.worker_candidates SET status = outcome_status, reason_code = outcome_reason,
    processing_lease_id = NULL, processing_lease_expires_at = NULL,
    terminal_at = CASE WHEN outcome_status = 'deferred' THEN NULL ELSE clock_timestamp() END,
    retention_eligible_at = clock_timestamp() + CASE WHEN outcome_status = 'deferred' THEN interval '90 days' ELSE interval '30 days' END,
    updated_at = clock_timestamp() WHERE id = p_candidate_id;
  RETURN jsonb_build_object('status', outcome_status, 'reasonCode', outcome_reason, 'applied', true,
    'providerId', p_provider_id, 'productId', p_product_id, 'leadId', p_lead_id);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_advance_discovery_run(
  p_run_id uuid,
  p_expected_next_index integer,
  p_next_index integer,
  p_discovered integer,
  p_duplicate integer,
  p_filtered integer,
  p_qualified integer,
  p_persisted integer
)
RETURNS public.worker_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE control_row public.worker_control; target public.worker_runs; current_index integer; next_checkpoint jsonb;
BEGIN
  IF least(p_discovered, p_duplicate, p_filtered, p_qualified, p_persisted) < 0 THEN
    RAISE EXCEPTION 'worker_counter_invalid';
  END IF;
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
  current_index := (target.checkpoint->>'nextIndex')::integer;
  IF target.processed_count <> current_index
    OR control_row.checkpoint_run_id IS DISTINCT FROM target.id
    OR control_row.current_checkpoint IS DISTINCT FROM target.checkpoint
    OR p_expected_next_index < 0
    OR p_next_index <> least(p_expected_next_index + 10, target.batch_size)
  THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  IF current_index >= p_next_index THEN RETURN target; END IF;
  IF current_index <> p_expected_next_index THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  next_checkpoint := jsonb_build_object('version', 1, 'nextIndex', p_next_index, 'batchSize', target.batch_size);
  UPDATE public.worker_runs SET
    processed_count = p_next_index,
    discovered_count = discovered_count + p_discovered,
    duplicate_count = duplicate_count + p_duplicate,
    filtered_count = filtered_count + p_filtered,
    qualified_count = qualified_count + p_qualified,
    persisted_count = persisted_count + p_persisted,
    checkpoint = next_checkpoint, heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_run_id RETURNING * INTO target;
  UPDATE public.worker_control SET current_checkpoint = next_checkpoint,
    checkpoint_run_id = target.id, updated_at = clock_timestamp() WHERE id = 1;
  RETURN target;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_create_run(boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_materialize_source_work(uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_budget(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_deferred_candidates(uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_resolve_discovery_lead(uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_complete_candidate(uuid, uuid, text, text, text, text, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_persist_qualification(uuid, uuid, uuid, uuid, uuid, jsonb, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_advance_discovery_run(
  uuid, integer, integer, integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_create_run(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_materialize_source_work(uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_budget(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_deferred_candidates(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_resolve_discovery_lead(uuid, uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_complete_candidate(uuid, uuid, text, text, text, text, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_persist_qualification(uuid, uuid, uuid, uuid, uuid, jsonb, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_advance_discovery_run(
  uuid, integer, integer, integer, integer, integer, integer, integer
) TO service_role;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
