-- Autonomous acquisition state is separate from the existing discovery lifecycle.
-- No live transport is enabled by this migration.
CREATE TABLE public.admin_acquisition_control (
  id integer PRIMARY KEY CHECK (id=1),
  desired_state text NOT NULL CHECK (desired_state IN ('running','stopped')),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  canary_used_at timestamptz,
  canary_run_id uuid REFERENCES public.worker_runs(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.admin_acquisition_control(id,desired_state) VALUES (1,'stopped');

CREATE TABLE public.admin_acquisition_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL UNIQUE REFERENCES public.worker_providers(id),
  lead_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.worker_runs(id),
  status text NOT NULL CHECK (status IN ('investigating','skipped','reserved','simulated_sent','uncertain','failed')),
  reason_code text CHECK (reason_code ~ '^[a-z0-9_]{1,80}$'),
  recipient_email text,
  subject text,
  body text,
  provider_message_id text,
  reserved_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (lead_id,provider_id) REFERENCES public.worker_leads(id,provider_id)
);
CREATE INDEX admin_acquisition_attempts_run ON public.admin_acquisition_attempts(run_id,created_at);

CREATE TABLE public.admin_acquisition_eligibility (
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  recipient_email text NOT NULL,
  channel text NOT NULL CHECK (channel='mock'),
  basis text NOT NULL CHECK (length(basis) BETWEEN 8 AND 500),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_id,recipient_email,channel)
);

ALTER TABLE public.admin_acquisition_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_acquisition_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_acquisition_eligibility ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_acquisition_control,public.admin_acquisition_attempts,public.admin_acquisition_eligibility FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.admin_acquisition_control,public.admin_acquisition_attempts,public.admin_acquisition_eligibility TO service_role;

CREATE FUNCTION public.mahshar_acquisition_set_state(p_running boolean,p_canary boolean DEFAULT false,p_run_id uuid DEFAULT NULL)
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
    canary_run_id=CASE WHEN p_running AND p_canary THEN p_run_id WHEN p_running THEN NULL ELSE canary_run_id END,
    updated_at=clock_timestamp()
    WHERE id=1 RETURNING * INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.mahshar_acquisition_create_next_run(p_epoch uuid)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result public.worker_runs; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF control_row.canary_run_id IS NOT NULL THEN RETURN NULL; END IF;
  -- Six bounded discovery batches per UTC day is the autonomous ceiling.
  IF (SELECT count(*) FROM public.worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')
    AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')>=6 THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.mahshar_worker_create_target_run(false);
  RETURN result;
END $$;

CREATE FUNCTION public.mahshar_acquisition_claim_next(p_run_id uuid,p_epoch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE picked record; result public.admin_acquisition_attempts; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF control_row.canary_run_id IS NOT NULL AND control_row.canary_run_id<>p_run_id THEN RETURN NULL; END IF;
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
    AND (control_row.canary_run_id IS NULL OR (a.status='investigating' AND a.run_id=p_run_id)
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
    'docsUrl',picked.docs_url,'docsSummary',picked.docs_summary);
END $$;

CREATE FUNCTION public.mahshar_acquisition_record(p_attempt_id uuid,p_status text,p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_status NOT IN ('skipped','failed') OR p_reason !~ '^[a-z0-9_]{1,80}$' THEN RAISE EXCEPTION 'acquisition_record_invalid'; END IF;
  UPDATE public.admin_acquisition_attempts SET status=p_status,reason_code=p_reason,updated_at=clock_timestamp()
    WHERE id=p_attempt_id AND status='investigating';
END $$;

CREATE FUNCTION public.mahshar_acquisition_reserve(p_attempt_id uuid,p_epoch uuid,p_email text,p_subject text,p_body text)
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
  IF control_row.canary_run_id IS NOT NULL AND item.run_id<>control_row.canary_run_id THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_runs WHERE id=item.run_id AND status='running';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO lead FROM public.worker_leads WHERE id=item.lead_id AND provider_id=item.provider_id;
  IF lead.preferred_email IS DISTINCT FROM p_email OR NOT lead.email_ready OR lead.contactability_status<>'verified_email'
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

CREATE FUNCTION public.mahshar_acquisition_finish(p_attempt_id uuid,p_provider_message_id text,p_uncertain boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE public.admin_acquisition_attempts SET status=CASE WHEN p_uncertain THEN 'uncertain' ELSE 'simulated_sent' END,
    provider_message_id=CASE WHEN p_uncertain THEN NULL ELSE p_provider_message_id END,
    dispatched_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE id=p_attempt_id AND status='reserved';
END $$;

CREATE FUNCTION public.mahshar_acquisition_metrics()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
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

REVOKE ALL ON FUNCTION public.mahshar_acquisition_set_state(boolean,boolean,uuid),public.mahshar_acquisition_create_next_run(uuid),
  public.mahshar_acquisition_claim_next(uuid,uuid),
  public.mahshar_acquisition_record(uuid,text,text),public.mahshar_acquisition_reserve(uuid,uuid,text,text,text),
  public.mahshar_acquisition_finish(uuid,text,boolean),public.mahshar_acquisition_metrics() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_set_state(boolean,boolean,uuid),public.mahshar_acquisition_create_next_run(uuid),
  public.mahshar_acquisition_claim_next(uuid,uuid),
  public.mahshar_acquisition_record(uuid,text,text),public.mahshar_acquisition_reserve(uuid,uuid,text,text,text),
  public.mahshar_acquisition_finish(uuid,text,boolean),public.mahshar_acquisition_metrics() TO service_role;
