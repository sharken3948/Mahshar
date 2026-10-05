-- Make all Worker budget claims retry-safe and recover partial deferred leads.
-- Forward-only: the previously applied Discovery migrations remain unchanged.

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_budget_v2(
  p_run_id uuid,p_budget text,p_claim_key text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs;
BEGIN
  IF p_budget NOT IN ('source','research','groq','traction') THEN RAISE EXCEPTION 'worker_budget_type_invalid'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_budget_claim_key_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.worker_budget_claims
    WHERE discovery_batch_id=target.discovery_batch_id AND budget_type=p_budget AND claim_key=p_claim_key
  ) THEN RETURN 'replayed'; END IF;
  IF target.status NOT IN ('running','stop_requested') THEN RAISE EXCEPTION 'worker_run_not_active'; END IF;
  IF target.deadline_at<=clock_timestamp() THEN RETURN 'deadline_reached'; END IF;
  IF NOT ((p_budget='source' AND target.source_query_count<301)
    OR (p_budget='research' AND target.research_fetch_count<240)
    OR (p_budget='groq' AND target.groq_call_count<100)
    OR (p_budget='traction' AND target.traction_fetch_count<60))
  THEN RETURN 'exhausted'; END IF;
  INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
    VALUES(target.discovery_batch_id,p_budget,p_claim_key);
  UPDATE public.worker_runs SET
    source_query_count=source_query_count+CASE WHEN p_budget='source' THEN 1 ELSE 0 END,
    research_fetch_count=research_fetch_count+CASE WHEN p_budget='research' THEN 1 ELSE 0 END,
    groq_call_count=groq_call_count+CASE WHEN p_budget='groq' THEN 1 ELSE 0 END,
    traction_fetch_count=traction_fetch_count+CASE WHEN p_budget='traction' THEN 1 ELSE 0 END,
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_run_id;
  RETURN 'claimed';
END $$;

-- Keep the legacy boolean RPC forward-compatible while old application code
-- may briefly run against the migrated schema. Both a new claim and a replay
-- are successful; only genuine exhaustion returns false.
CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_budget(
  p_run_id uuid,p_budget text,p_claim_key text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN public.mahshar_worker_claim_budget_v2(p_run_id,p_budget,p_claim_key) IN ('claimed','replayed');
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_deferred_candidates(
  p_run_id uuid,p_claim_key text,p_limit integer DEFAULT 5
) RETURNS TABLE(candidate_id uuid,lease_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs; claim_inserted integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'worker_deferred_limit_invalid'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_deferred_claim_key_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status NOT IN ('running','stop_requested') OR target.deadline_at<=clock_timestamp()
    OR target.discovery_batch_id<>target.id OR target.qualified_count>=target.qualified_target THEN RETURN; END IF;
  INSERT INTO public.worker_deferred_claims(discovery_batch_id,claim_key)
    VALUES(target.discovery_batch_id,p_claim_key) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claim_inserted=ROW_COUNT;
  IF claim_inserted=0 THEN RETURN; END IF;
  RETURN QUERY WITH locked AS (
    SELECT candidate.id,coalesce(lead.qualification_retry_after,candidate.updated_at) AS retry_after
    FROM public.worker_candidates candidate
    LEFT JOIN public.worker_leads lead ON lead.id=candidate.lead_id
    WHERE candidate.status='deferred' AND candidate.discovery_batch_id<>target.discovery_batch_id
      AND candidate.discovered_domain IS NOT NULL AND candidate.discovered_product IS NOT NULL
      AND (candidate.discovered_contract_url IS NOT NULL OR candidate.discovered_docs_url IS NOT NULL)
      AND ((lead.id IS NULL AND candidate.reason_code IN (
          'research_budget_exhausted','research_claim_replayed','run_budget_exhausted'))
        OR (lead.status='discovered' AND lead.qualification_status='pending'
          AND candidate.reason_code IN ('research_budget_exhausted','research_claim_replayed',
            'groq_budget_exhausted','groq_claim_replayed','groq_qualification_failed','run_budget_exhausted'))
        OR (lead.qualification_status='deferred'
          AND coalesce(lead.qualification_retry_after,'-infinity'::timestamptz)<=clock_timestamp()))
      AND (candidate.processing_lease_id IS NULL OR candidate.processing_lease_expires_at<=clock_timestamp())
    ORDER BY retry_after,candidate.id LIMIT p_limit FOR UPDATE OF candidate SKIP LOCKED
  ), eligible AS (
    SELECT id,row_number() OVER (ORDER BY retry_after,id)::smallint AS claim_order,gen_random_uuid() AS new_lease FROM locked
  ), updated AS (
    UPDATE public.worker_candidates candidate SET deferred_claim_batch_id=target.discovery_batch_id,
      deferred_claim_order=eligible.claim_order,processing_lease_id=eligible.new_lease,
      processing_lease_expires_at=clock_timestamp()+interval '5 minutes',processing_attempt=processing_attempt+1,
      updated_at=clock_timestamp() FROM eligible WHERE candidate.id=eligible.id
    RETURNING candidate.id,candidate.processing_lease_id
  ) SELECT updated.id,updated.processing_lease_id FROM updated ORDER BY updated.id;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_claim_budget_v2(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_budget(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_deferred_candidates(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_budget_v2(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_budget(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_deferred_candidates(uuid,text,integer) TO service_role;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,anon,authenticated,service_role;
