-- Preserve technically compatible near-fit APIs for Admin review without
-- weakening deterministic safety, identity, contract, endpoint, or auth gates.

DO $worker_review_status_constraint$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_leads'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%qualification_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.worker_leads DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $worker_review_status_constraint$;

ALTER TABLE public.worker_leads
  ADD CONSTRAINT worker_leads_qualification_status_check CHECK (
    qualification_status IN ('pending', 'qualified', 'review_candidate', 'rejected', 'deferred')
  );

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
    ELSIF lead.qualification_status = 'review_candidate' THEN
      RETURN jsonb_build_object('action', 'duplicate', 'reasonCode', 'existing_review_candidate',
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
  qualification_disposition text;
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
  ELSIF lead.qualification_status = 'review_candidate' THEN
    outcome_status := 'duplicate'; outcome_reason := 'existing_review_candidate';
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

    qualification_disposition := CASE
      WHEN (p_qualification->>'fitScore')::numeric >= 70 THEN 'qualified'
      WHEN (p_qualification->>'fitScore')::numeric >= 60 THEN 'review_candidate'
      ELSE 'rejected'
    END;
    UPDATE public.worker_leads SET
      status = CASE WHEN qualification_disposition = 'qualified' THEN 'qualified'
        WHEN qualification_disposition = 'review_candidate' THEN 'discovered' ELSE 'rejected' END,
      qualification_status = qualification_disposition,
      fit_score = (p_qualification->>'fitScore')::numeric, fit_reason = p_qualification->>'summary',
      commercial_api = (p_qualification->>'commercialApi')::boolean,
      agent_utility = p_qualification->>'agentUtility', pay_per_call_fit = p_qualification->>'payPerCallFit',
      integration_difficulty = p_qualification->>'integrationDifficulty', provider_credibility = p_qualification->>'providerCredibility',
      qualification_reason_codes = ARRAY(SELECT jsonb_array_elements_text(p_qualification->'reasonCodes')),
      qualification_model = p_model,
      qualified_at = CASE WHEN qualification_disposition = 'qualified' THEN clock_timestamp() ELSE NULL END,
      qualification_retry_after = NULL, updated_at = clock_timestamp()
    WHERE id = p_lead_id AND status = 'discovered';
    IF NOT FOUND THEN RAISE EXCEPTION 'worker_lead_precedence_conflict'; END IF;

    IF qualification_disposition = 'rejected' THEN
      INSERT INTO public.worker_decisions(provider_id, lead_id, decision, reason_code)
        VALUES(p_provider_id, p_lead_id, 'rejected', 'fit_below_threshold');
      UPDATE public.worker_products SET status = 'rejected', updated_at = clock_timestamp() WHERE id = p_product_id;
      outcome_status := 'filtered'; outcome_reason := 'fit_below_threshold';
    ELSIF qualification_disposition = 'review_candidate' THEN
      outcome_status := 'persisted'; outcome_reason := 'review_candidate';
    ELSE
      outcome_status := 'persisted'; outcome_reason := 'qualified';
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

REVOKE ALL ON FUNCTION public.mahshar_worker_resolve_discovery_lead(uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_persist_qualification(uuid, uuid, uuid, uuid, uuid, jsonb, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_resolve_discovery_lead(uuid, uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_persist_qualification(uuid, uuid, uuid, uuid, uuid, jsonb, text, boolean, text) TO service_role;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
