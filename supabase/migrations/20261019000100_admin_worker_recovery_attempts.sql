-- Lease deferred work without spending a research retry. Keep the old RPC unchanged for deployment compatibility.
CREATE FUNCTION public.mahshar_worker_lease_deferred_candidates(p_run_id uuid, p_claim_key text, p_limit integer DEFAULT 5)
 RETURNS TABLE(candidate_id uuid, lease_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE target public.worker_runs; claim_inserted integer; continuous boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'worker_deferred_limit_invalid'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_deferred_claim_key_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status<>'running' OR target.deadline_at<=clock_timestamp()
    OR target.discovery_batch_id<>target.id OR target.qualified_count>=target.qualified_target THEN RETURN; END IF;
  INSERT INTO public.worker_deferred_claims(discovery_batch_id,claim_key)
    VALUES(target.discovery_batch_id,p_claim_key) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claim_inserted=ROW_COUNT;
  IF claim_inserted=0 THEN RETURN; END IF;
  SELECT EXISTS(SELECT 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running'
    AND operating_mode='continuous') INTO continuous;
  RETURN QUERY WITH locked AS (
    SELECT candidate.id,coalesce(lead.qualification_retry_after,candidate.updated_at) AS retry_after
    FROM public.worker_candidates candidate
    LEFT JOIN public.worker_leads lead ON lead.id=candidate.lead_id
    WHERE candidate.mail_recovery_kind IS NULL AND candidate.status='deferred' AND candidate.discovery_batch_id<>target.discovery_batch_id
      AND candidate.discovered_domain IS NOT NULL AND candidate.discovered_product IS NOT NULL
      AND (candidate.discovered_contract_url IS NOT NULL OR candidate.discovered_docs_url IS NOT NULL)
      AND (NOT continuous OR candidate.reason_code NOT IN ('official_docs_unreachable','provider_ownership_unverified')
        OR (candidate.processing_attempt<3 AND candidate.updated_at<=clock_timestamp()-
          CASE candidate.processing_attempt WHEN 0 THEN interval '1 hour' WHEN 1 THEN interval '2 hours' ELSE interval '4 hours' END))
      AND ((continuous AND candidate.reason_code IN ('official_docs_unreachable','provider_ownership_unverified')
          AND (lead.id IS NULL OR lead.qualification_status IN ('pending','deferred')))
        OR (lead.id IS NULL AND candidate.reason_code IN (
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
      processing_lease_expires_at=clock_timestamp()+interval '5 minutes' FROM eligible WHERE candidate.id=eligible.id
    RETURNING candidate.id,candidate.processing_lease_id
  ) SELECT updated.id,updated.processing_lease_id FROM updated ORDER BY updated.id;
END $function$;


-- A lease is charged once, only at authorization to begin, under the existing run/candidate locks.
CREATE FUNCTION public.mahshar_worker_begin_deferred_candidate(
 p_run_id uuid,p_candidate_id uuid,p_lease_id uuid,p_deadline_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; candidate public.worker_candidates; inserted integer;
BEGIN
 SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
 IF p_deadline_at IS NULL OR target.status<>'running' OR target.deadline_at<=clock_timestamp()
   OR p_deadline_at<=clock_timestamp() OR target.qualified_count>=target.qualified_target THEN RETURN false; END IF;
 SELECT * INTO candidate FROM public.worker_candidates WHERE id=p_candidate_id FOR UPDATE;
 IF NOT FOUND OR candidate.status<>'deferred' OR candidate.mail_recovery_kind IS NOT NULL
   OR candidate.deferred_claim_batch_id IS DISTINCT FROM target.discovery_batch_id
   OR p_lease_id IS NULL OR candidate.processing_lease_id IS DISTINCT FROM p_lease_id
   OR candidate.processing_lease_expires_at IS NULL OR candidate.processing_lease_expires_at<=clock_timestamp()
 THEN RETURN false; END IF;
 -- Recheck time after waiting for the candidate lock.
 IF least(target.deadline_at,p_deadline_at)<=clock_timestamp() THEN RETURN false; END IF;
 INSERT INTO public.worker_deferred_claims(discovery_batch_id,claim_key)
 VALUES(target.discovery_batch_id,'attempt:'||p_lease_id::text) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted=0 THEN RETURN false; END IF;
 UPDATE public.worker_candidates SET processing_attempt=processing_attempt+1,updated_at=clock_timestamp()
 WHERE id=p_candidate_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_worker_lease_deferred_candidates(uuid,text,integer),
 public.mahshar_worker_begin_deferred_candidate(uuid,uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_lease_deferred_candidates(uuid,text,integer),
 public.mahshar_worker_begin_deferred_candidate(uuid,uuid,uuid,timestamptz) TO service_role;
