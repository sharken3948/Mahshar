-- Continuous simulation is separately gated in the server. Preserve canary usage/history.
-- Additive, forward only. No live transport, new tables or eligibility creation.
ALTER TABLE public.admin_acquisition_control ADD COLUMN operating_mode text NOT NULL DEFAULT 'continuous'
  CHECK (operating_mode IN ('canary','continuous'));
UPDATE public.admin_acquisition_control SET operating_mode='canary' WHERE canary_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_set_state(p_running boolean,p_canary boolean DEFAULT false,p_run_id uuid DEFAULT NULL)
RETURNS public.admin_acquisition_control LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result public.admin_acquisition_control;
BEGIN
  SELECT * INTO result FROM public.admin_acquisition_control WHERE id=1 FOR UPDATE;
  IF p_running AND result.desired_state='running' THEN RAISE EXCEPTION 'acquisition_already_running'; END IF;
  IF p_running AND NOT EXISTS(SELECT 1 FROM public.worker_control c WHERE c.id=1 AND c.desired_state='running')
    THEN RAISE EXCEPTION 'acquisition_start_without_worker'; END IF;
  IF p_running AND p_canary AND (p_run_id IS NULL OR result.canary_used_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.worker_runs WHERE id=p_run_id AND status='queued'))
    THEN RAISE EXCEPTION 'acquisition_canary_unavailable'; END IF;
  UPDATE public.admin_acquisition_control SET desired_state=CASE WHEN p_running THEN 'running' ELSE 'stopped' END,
    epoch=CASE WHEN p_running THEN gen_random_uuid() ELSE epoch END,
    canary_used_at=CASE WHEN p_running AND p_canary THEN clock_timestamp() ELSE canary_used_at END,
    canary_run_id=CASE WHEN p_running AND p_canary THEN p_run_id ELSE canary_run_id END,
    operating_mode=CASE WHEN p_running THEN CASE WHEN p_canary THEN 'canary' ELSE 'continuous' END ELSE operating_mode END,
    continuation_run_id=CASE WHEN p_running THEN NULL ELSE continuation_run_id END,
    updated_at=clock_timestamp()
    WHERE id=1 RETURNING * INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_create_next_run(p_epoch uuid,p_parent_run_id uuid)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result public.worker_runs; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND OR control_row.operating_mode='canary' OR p_parent_run_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.worker_runs WHERE acquisition_parent_run_id=p_parent_run_id;
  IF FOUND THEN RETURN result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.worker_runs WHERE id=p_parent_run_id AND status='completed')
    THEN RETURN NULL; END IF;
  -- A lost step response must return the already-created child, not create another run.
  IF control_row.continuation_run_id IS NOT NULL THEN
    SELECT * INTO result FROM public.worker_runs WHERE id=control_row.continuation_run_id;
    IF result.status IN ('queued','running') THEN RETURN NULL; END IF;
    IF result.status IN ('stop_requested','stopped','failed') THEN
      UPDATE public.admin_acquisition_control SET desired_state='stopped',updated_at=clock_timestamp() WHERE id=1;
      RETURN NULL;
    END IF;
  END IF;
  IF (SELECT count(*) FROM public.worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')
    AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')>=6 THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.mahshar_worker_create_target_run(false);
  UPDATE public.worker_runs SET acquisition_parent_run_id=p_parent_run_id,
    workflow_run_id=(SELECT workflow_run_id FROM public.worker_runs WHERE id=p_parent_run_id) WHERE id=result.id RETURNING * INTO result;
  UPDATE public.admin_acquisition_control SET continuation_run_id=result.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_claim_next(p_run_id uuid,p_epoch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE picked record; result public.admin_acquisition_attempts; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF control_row.operating_mode='canary' AND control_row.canary_run_id<>p_run_id THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_control WHERE id=1 AND desired_state='running' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_runs WHERE id=p_run_id AND status='running';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT l.id AS lead_id,l.provider_id,p.canonical_name AS provider,x.display_name AS product,
    l.preferred_email AS email,l.email_ready,
    EXISTS(SELECT 1 FROM public.worker_contacts c WHERE c.provider_id=l.provider_id AND c.lead_id=l.id
      AND c.value=l.preferred_email AND c.contact_type='email' AND c.verification_status='verified'
      AND c.email_ready AND c.preferred AND c.source_type IN ('official_site','official_docs','official_github')
      AND c.purpose NOT IN ('security','privacy','abuse','legal','dmca','copyright','compliance','reporting')) AS verified,
    EXISTS(SELECT 1 FROM public.admin_acquisition_eligibility e WHERE e.provider_id=l.provider_id
      AND e.recipient_email=l.preferred_email AND e.channel='mock' AND e.expires_at>clock_timestamp()) AS approved,
    (SELECT s.url FROM public.worker_sources s WHERE s.lead_id=l.id AND s.source_role='official_docs'
      ORDER BY s.created_at DESC LIMIT 1) AS docs_url,
    (SELECT s.factual_summary FROM public.worker_sources s WHERE s.lead_id=l.id AND s.source_role='official_docs'
      ORDER BY s.created_at DESC LIMIT 1) AS docs_summary
  INTO picked FROM public.worker_leads l JOIN public.worker_providers p ON p.id=l.provider_id
    JOIN public.worker_products x ON x.id=l.product_id
    LEFT JOIN public.admin_acquisition_attempts a ON a.provider_id=l.provider_id
  WHERE l.qualification_status IN ('qualified','review_candidate')
    AND l.status NOT IN ('rejected','do_not_contact','closed') AND p.status NOT IN ('rejected','do_not_contact')
    AND (a.id IS NULL OR a.status='investigating')
    AND (control_row.operating_mode='continuous' OR (a.status='investigating' AND a.run_id=p_run_id)
      OR NOT EXISTS(SELECT 1 FROM public.admin_acquisition_attempts used WHERE used.run_id=p_run_id))
    AND NOT EXISTS(SELECT 1 FROM public.admin_outreach_threads t WHERE t.provider_id=l.provider_id)
    AND NOT EXISTS(SELECT 1 FROM public.worker_decisions d WHERE d.provider_id=l.provider_id
      AND d.decision IN ('rejected','do_not_contact'))
  ORDER BY CASE WHEN a.status='investigating' THEN 0 ELSE 1 END,l.created_at,l.id
    LIMIT 1 FOR UPDATE OF l SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.admin_acquisition_attempts(provider_id,lead_id,run_id,status)
    VALUES(picked.provider_id,picked.lead_id,p_run_id,'investigating')
    ON CONFLICT(provider_id) DO UPDATE SET run_id=p_run_id,updated_at=clock_timestamp()
      WHERE public.admin_acquisition_attempts.status='investigating'
    RETURNING * INTO result;
  RETURN jsonb_build_object('attemptId',result.id,'providerId',picked.provider_id,'leadId',picked.lead_id,
    'provider',picked.provider,'product',picked.product,'email',picked.email,
    'emailReady',picked.email_ready,'verified',picked.verified,'approved',picked.approved,
    'docsUrl',picked.docs_url,'docsSummary',picked.docs_summary,'subject',result.subject,'body',result.body);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_reserve(p_attempt_id uuid,p_epoch uuid,p_email text,p_subject text,p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts; lead public.worker_leads; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_control WHERE id=1 AND desired_state='running' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR item.status<>'investigating' THEN RETURN NULL; END IF;
  IF control_row.operating_mode='canary' AND item.run_id<>control_row.canary_run_id THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_runs WHERE id=item.run_id AND status='running';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO lead FROM public.worker_leads WHERE id=item.lead_id AND provider_id=item.provider_id;
  IF EXISTS(SELECT 1 FROM public.worker_providers WHERE id=item.provider_id AND status IN ('rejected','do_not_contact'))
    OR NOT EXISTS(SELECT 1 FROM public.worker_contacts c WHERE c.provider_id=item.provider_id AND c.lead_id=item.lead_id
      AND c.value=p_email AND c.contact_type='email' AND c.verification_status='verified' AND c.email_ready AND c.preferred
      AND c.source_type IN ('official_site','official_docs','official_github')
      AND c.purpose NOT IN ('security','privacy','abuse','legal','dmca','copyright','compliance','reporting'))
    OR NOT EXISTS(SELECT 1 FROM public.worker_sources WHERE lead_id=item.lead_id AND source_role='official_docs')
    OR lead.preferred_email IS DISTINCT FROM p_email OR NOT lead.email_ready OR lead.contactability_status<>'verified_email'
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR NOT EXISTS(SELECT 1 FROM public.admin_acquisition_eligibility e WHERE e.provider_id=item.provider_id
      AND e.recipient_email=p_email AND e.channel='mock' AND e.expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM public.admin_outreach_threads t WHERE t.provider_id=item.provider_id)
    OR EXISTS(SELECT 1 FROM public.worker_decisions d WHERE d.provider_id=item.provider_id
      AND d.decision IN ('rejected','do_not_contact'))
    OR length(p_subject) NOT BETWEEN 1 AND 200 OR length(p_body) NOT BETWEEN 1 AND 5000 THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM public.admin_acquisition_attempts
      WHERE status IN ('reserved','simulated_sent','uncertain')
      AND reserved_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND reserved_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')>=25
    THEN RAISE EXCEPTION 'acquisition_daily_send_limit'; END IF;
  UPDATE public.admin_acquisition_attempts SET status='reserved',recipient_email=p_email,subject=p_subject,body=p_body,
    reserved_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE id=p_attempt_id;
  RETURN p_attempt_id;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_deferred_candidates(
  p_run_id uuid,p_claim_key text,p_limit integer DEFAULT 5
) RETURNS TABLE(candidate_id uuid,lease_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs; claim_inserted integer; continuous boolean;
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
  SELECT EXISTS(SELECT 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running'
    AND operating_mode='continuous') INTO continuous;
  RETURN QUERY WITH locked AS (
    SELECT candidate.id,coalesce(lead.qualification_retry_after,candidate.updated_at) AS retry_after
    FROM public.worker_candidates candidate
    LEFT JOIN public.worker_leads lead ON lead.id=candidate.lead_id
    WHERE candidate.status='deferred' AND candidate.discovery_batch_id<>target.discovery_batch_id
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
      processing_lease_expires_at=clock_timestamp()+interval '5 minutes',processing_attempt=processing_attempt+1,
      updated_at=clock_timestamp() FROM eligible WHERE candidate.id=eligible.id
    RETURNING candidate.id,candidate.processing_lease_id
  ) SELECT updated.id,updated.processing_lease_id FROM updated ORDER BY updated.id;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_metrics()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'investigating',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE status='investigating'),
    'research_retries_exhausted',(SELECT count(*) FROM public.worker_candidates WHERE status='deferred'
      AND reason_code IN ('official_docs_unreachable','provider_ownership_unverified') AND processing_attempt>=3),
    'investigated',(SELECT count(*) FROM public.admin_acquisition_attempts),
    'verified_emails',(SELECT count(*) FROM public.admin_acquisition_attempts a JOIN public.worker_leads l ON l.id=a.lead_id
      WHERE l.email_ready AND l.contactability_status='verified_email'),
    'eligible_recipients',(SELECT count(*) FROM public.admin_acquisition_attempts a JOIN public.worker_leads l ON l.id=a.lead_id
      JOIN public.admin_acquisition_eligibility e ON e.provider_id=a.provider_id AND e.recipient_email=l.preferred_email
      WHERE e.channel='mock' AND e.expires_at>clock_timestamp()),
    'drafts',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE subject IS NOT NULL),
    'reserved',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE status='reserved'),
    'simulated_sent',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE status='simulated_sent'),
    'skipped',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE status='skipped'),
    'uncertain',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE status='uncertain'),
    'failed',(SELECT count(*) FROM public.admin_acquisition_attempts WHERE status='failed'),
    'daily_groq',(SELECT coalesce(sum(groq_call_count),0) FROM public.worker_runs
      WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day'),
    'daily_sends',(SELECT count(*) FROM public.admin_acquisition_attempts
      WHERE status IN ('reserved','simulated_sent','uncertain')
      AND reserved_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND reserved_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day'),
    'daily_simulated_sent',(SELECT count(*) FROM public.admin_acquisition_attempts
      WHERE status='simulated_sent' AND dispatched_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND dispatched_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day'),
    'daily_runs',(SELECT count(*) FROM public.worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')
  )
$$;

-- CREATE OR REPLACE retains ACLs. Explicitly retain the service-role-only boundary.
REVOKE ALL ON FUNCTION public.mahshar_acquisition_set_state(boolean,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_set_state(boolean,boolean,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_claim_next(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_claim_next(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_reserve(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_reserve(uuid,uuid,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_deferred_candidates(uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_deferred_candidates(uuid,text,integer) TO service_role;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_metrics() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_metrics() TO service_role;

-- Save a prepared draft before quota waits or crashes, without creating a reservation.
CREATE FUNCTION public.mahshar_acquisition_save_draft(p_attempt_id uuid,p_epoch uuid,p_subject text,p_body text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF length(p_subject) NOT BETWEEN 1 AND 200 OR length(p_body) NOT BETWEEN 1 AND 5000
    OR p_subject IS NULL OR p_body IS NULL THEN RETURN false; END IF;
  UPDATE public.admin_acquisition_attempts a SET subject=p_subject,body=p_body,updated_at=clock_timestamp()
    WHERE a.id=p_attempt_id AND a.status='investigating' AND a.subject IS NULL
    AND EXISTS(SELECT 1 FROM public.worker_runs r WHERE r.id=a.run_id AND r.status='running')
    AND EXISTS(SELECT 1 FROM public.worker_control WHERE id=1 AND desired_state='running');
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_save_draft(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_save_draft(uuid,uuid,text,text) TO service_role;
