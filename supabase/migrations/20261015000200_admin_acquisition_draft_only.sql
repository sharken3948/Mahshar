-- Continuous draft preparation is independent of dispatch authorization.
-- Existing claim/reserve/finish APIs and eligibility records are unchanged.
ALTER TABLE public.admin_acquisition_attempts
  DROP CONSTRAINT admin_acquisition_attempts_status_check,
  ADD CONSTRAINT admin_acquisition_attempts_status_check CHECK
    (status IN ('investigating','skipped','reserved','simulated_sent','uncertain','failed','prepared')),
  ADD COLUMN draft_only boolean NOT NULL DEFAULT false,
  ADD COLUMN draft_evidence_key text,
  ADD COLUMN draft_claim_token uuid,
  ADD COLUMN draft_claim_expires_at timestamptz;
ALTER TABLE public.admin_acquisition_attempts ADD CONSTRAINT admin_acquisition_draft_only_no_dispatch CHECK
  (NOT draft_only OR (status NOT IN ('reserved','simulated_sent','uncertain') AND reserved_at IS NULL
    AND dispatched_at IS NULL AND provider_message_id IS NULL));

CREATE TABLE public.admin_acquisition_attempt_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.admin_acquisition_attempts(id),
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  lead_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.worker_runs(id),
  status text NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(attempt_id,updated_at),
  FOREIGN KEY(lead_id,provider_id) REFERENCES public.worker_leads(id,provider_id)
);
CREATE INDEX admin_acquisition_attempt_history_provider
  ON public.admin_acquisition_attempt_history(provider_id,updated_at DESC,id);
ALTER TABLE public.admin_acquisition_attempt_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_acquisition_attempt_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.admin_acquisition_attempt_history TO service_role;

CREATE FUNCTION public.mahshar_acquisition_archive_skip()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF OLD.status='skipped' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reason_code IS DISTINCT FROM OLD.reason_code) THEN
    INSERT INTO public.admin_acquisition_attempt_history(attempt_id,provider_id,lead_id,run_id,status,reason_code,created_at,updated_at)
      VALUES(OLD.id,OLD.provider_id,OLD.lead_id,OLD.run_id,OLD.status,OLD.reason_code,OLD.created_at,OLD.updated_at)
      ON CONFLICT(attempt_id,updated_at) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_archive_skip() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER admin_acquisition_archive_skip BEFORE UPDATE ON public.admin_acquisition_attempts
  FOR EACH ROW EXECUTE FUNCTION public.mahshar_acquisition_archive_skip();

CREATE FUNCTION public.mahshar_acquisition_official_url(p_url text,p_domain text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT coalesce(p_url ~ '^https://[a-z0-9.-]+([/?#]|$)' AND (
    substring(p_url FROM '^https://([^/?#]+)')=p_domain OR
    right(substring(p_url FROM '^https://([^/?#]+)'),length(p_domain)+1)='.'||p_domain),false)
$$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_official_url(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.mahshar_acquisition_draft_context(p_lead_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE lead public.worker_leads; provider public.worker_providers; facts jsonb; urls jsonb;
  allowed boolean; identity_verified boolean; contact_verified boolean; contact jsonb; context jsonb;
BEGIN
  SELECT * INTO lead FROM public.worker_leads WHERE id=p_lead_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO provider FROM public.worker_providers WHERE id=lead.provider_id;
  allowed:=lead.qualification_status IN ('qualified','review_candidate')
    AND lead.status NOT IN ('rejected','do_not_contact','closed') AND provider.status NOT IN ('rejected','do_not_contact')
    AND NOT EXISTS(SELECT 1 FROM public.worker_products WHERE id=lead.product_id AND status='rejected')
    AND NOT EXISTS(SELECT 1 FROM public.worker_decisions WHERE provider_id=lead.provider_id AND decision IN ('rejected','do_not_contact'))
    AND NOT EXISTS(SELECT 1 FROM public.admin_outreach_threads WHERE provider_id=lead.provider_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('sourceType',s.source_type,'sourceRole',s.source_role,'url',s.url,
    'factualSummary',s.factual_summary,'checkedAt',s.checked_at) ORDER BY s.source_role,s.url),'[]') INTO facts
  FROM (SELECT * FROM public.worker_sources WHERE lead_id=p_lead_id
    AND checked_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes'
    ORDER BY (source_role='official_docs') DESC,(source_role='official_site') DESC,url LIMIT 8) s;
  identity_verified:=EXISTS(SELECT 1 FROM jsonb_array_elements(facts) f
    WHERE f->>'sourceType'='website' AND f->>'sourceRole' IN ('official_site','official_docs')
      AND public.mahshar_acquisition_official_url(f->>'url',provider.canonical_domain));
  SELECT jsonb_build_object('value',c.value,'purpose',c.purpose,'source',c.source_url,'type',c.source_type) INTO contact
    FROM public.worker_contacts c WHERE c.provider_id=lead.provider_id AND c.lead_id=lead.id
      AND c.contact_type='email' AND c.value=lead.preferred_email AND c.preferred AND c.email_ready
      AND c.verification_status='verified' AND c.source_type IN ('official_site','official_docs','official_github')
      AND c.purpose NOT IN ('security','privacy','abuse','legal','dmca','copyright','compliance','reporting')
      AND c.verified_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes'
      AND (c.source_type='official_github' OR public.mahshar_acquisition_official_url(c.source_url,provider.canonical_domain))
    ORDER BY c.id LIMIT 1;
  contact_verified:=lead.email_ready AND lead.contactability_status='verified_email' AND contact IS NOT NULL;
  SELECT coalesce(jsonb_agg(url ORDER BY url),'[]') INTO urls FROM (
    SELECT DISTINCT discovered_docs_url AS url FROM public.worker_candidates WHERE lead_id=p_lead_id
      AND discovered_docs_url IS NOT NULL ORDER BY discovered_docs_url LIMIT 4) candidate;
  context:=jsonb_build_object('domain',provider.canonical_domain,'allowed',allowed,
    'identityVerified',identity_verified,'contactVerified',contact_verified,'facts',facts,'docsUrls',urls);
  -- Content/freshness, not re-check timestamps, control reconsideration.
  RETURN context||jsonb_build_object('key',md5((context-'facts'||jsonb_build_object('contact',contact,
    'email',lead.preferred_email,'product',lead.product_id,'qualification',lead.qualification_status,
    'facts',(SELECT coalesce(jsonb_agg(f-'checkedAt'),'[]') FROM jsonb_array_elements(facts) f)))::text));
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_draft_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_draft_context(uuid) TO service_role;

CREATE FUNCTION public.mahshar_acquisition_claim_draft(p_run_id uuid,p_epoch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE picked record; item public.admin_acquisition_attempts; token uuid:=gen_random_uuid();
BEGIN
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running' AND epoch=p_epoch
    AND operating_mode='continuous' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_control WHERE id=1 AND desired_state='running' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_runs WHERE id=p_run_id AND status='running' AND deadline_at>clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT l.id AS lead_id,l.provider_id,p.canonical_name AS provider,x.display_name AS product,
    l.preferred_email AS email,l.email_ready,ctx.value AS context INTO picked
  FROM public.worker_leads l JOIN public.worker_providers p ON p.id=l.provider_id
    JOIN public.worker_products x ON x.id=l.product_id
    CROSS JOIN LATERAL (SELECT public.mahshar_acquisition_draft_context(l.id) AS value) ctx
    LEFT JOIN public.admin_acquisition_attempts a ON a.provider_id=l.provider_id
  WHERE (ctx.value->>'allowed')::boolean
    AND (a.id IS NULL OR (a.subject IS NULL AND a.reserved_at IS NULL AND a.dispatched_at IS NULL AND (
      (a.status='investigating' AND (a.draft_claim_expires_at IS NULL OR a.draft_claim_expires_at<=clock_timestamp()))
      OR (a.status='skipped' AND a.reason_code IN ('no_email','invalid_email','unverified_contact',
        'recipient_ineligible','channel_not_approved','provider_identity_unverified','api_documentation_missing')
        AND a.draft_evidence_key IS DISTINCT FROM ctx.value->>'key'))))
  ORDER BY (a.status='investigating') DESC NULLS LAST,l.commercial_api DESC NULLS LAST,l.fit_score DESC NULLS LAST,l.created_at,l.id
  LIMIT 1 FOR UPDATE OF l SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.admin_acquisition_attempts(provider_id,lead_id,run_id,status,draft_only,draft_evidence_key,draft_claim_token,draft_claim_expires_at)
    VALUES(picked.provider_id,picked.lead_id,p_run_id,'investigating',true,picked.context->>'key',token,clock_timestamp()+interval '15 minutes')
    ON CONFLICT(provider_id) DO UPDATE SET lead_id=excluded.lead_id,run_id=excluded.run_id,status='investigating',reason_code=NULL,
      draft_only=true,draft_evidence_key=excluded.draft_evidence_key,draft_claim_token=token,
      draft_claim_expires_at=excluded.draft_claim_expires_at,updated_at=clock_timestamp()
    RETURNING * INTO item;
  RETURN jsonb_build_object('attemptId',item.id,'providerId',picked.provider_id,'leadId',picked.lead_id,
    'provider',picked.provider,'product',picked.product,'email',picked.email,'emailReady',picked.email_ready,
    'verified',(picked.context->>'contactVerified')::boolean,'approved',false,'context',picked.context,'claimToken',token);
END $$;

CREATE FUNCTION public.mahshar_acquisition_save_draft_only(p_attempt_id uuid,p_epoch uuid,p_claim_token uuid,
  p_evidence_key text,p_subject text,p_body text,p_generator text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts; context jsonb;
BEGIN
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running' AND epoch=p_epoch
    AND operating_mode='continuous' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_control WHERE id=1 AND desired_state='running' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR NOT item.draft_only OR item.status<>'investigating' OR item.subject IS NOT NULL
    OR item.draft_claim_token IS DISTINCT FROM p_claim_token OR item.draft_claim_expires_at<=clock_timestamp()
    OR p_generator IS DISTINCT FROM 'groq' THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_runs WHERE id=item.run_id AND status='running' AND deadline_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Recheck the same locked boundaries as contact refresh and suppression.
  PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_products WHERE id=(SELECT product_id FROM public.worker_leads WHERE id=item.lead_id) FOR UPDATE;
  PERFORM 1 FROM public.worker_leads WHERE id=item.lead_id FOR UPDATE;
  context:=public.mahshar_acquisition_draft_context(item.lead_id);
  IF NOT (context->>'allowed')::boolean OR NOT (context->>'identityVerified')::boolean
    OR NOT (context->>'contactVerified')::boolean OR p_evidence_key IS DISTINCT FROM context->>'key'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(context->'facts') f WHERE f->>'sourceType'='website'
      AND f->>'sourceRole'='official_docs' AND length(trim(f->>'factualSummary'))>0
      AND public.mahshar_acquisition_official_url(f->>'url',context->>'domain'))
    OR p_subject IS NULL OR p_body IS NULL OR length(trim(p_subject)) NOT BETWEEN 1 AND 200
    OR length(trim(p_body)) NOT BETWEEN 1 AND 5000 THEN RETURN false; END IF;
  -- The provenance-clearing trigger runs first; set provenance in a second UPDATE,
  -- in this same locked transaction, exactly as the existing Groq checkpoint RPC.
  UPDATE public.admin_acquisition_attempts SET status='prepared',reason_code=NULL,
    recipient_email=(SELECT preferred_email FROM public.worker_leads WHERE id=item.lead_id),
    subject=p_subject,body=p_body,draft_evidence_key=p_evidence_key,draft_claim_token=NULL,
    draft_claim_expires_at=NULL,updated_at=clock_timestamp() WHERE id=item.id;
  UPDATE public.admin_acquisition_attempts SET draft_generator='groq',draft_prepared_at=clock_timestamp() WHERE id=item.id;
  RETURN true;
END $$;

CREATE FUNCTION public.mahshar_acquisition_record_draft(p_attempt_id uuid,p_epoch uuid,p_claim_token uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('no_email','invalid_email','unverified_contact',
    'provider_identity_unverified','api_documentation_missing','provider_suppressed','prior_outreach','draft_invalid','provider_failed') THEN RETURN false; END IF;
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running' AND epoch=p_epoch
    AND operating_mode='continuous' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR NOT item.draft_only OR item.status<>'investigating' OR item.subject IS NOT NULL
    OR item.draft_claim_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
  UPDATE public.admin_acquisition_attempts SET status=CASE WHEN p_reason='provider_failed' THEN 'failed' ELSE 'skipped' END,
    reason_code=p_reason,draft_evidence_key=public.mahshar_acquisition_draft_context(item.lead_id)->>'key',
    draft_claim_token=NULL,draft_claim_expires_at=NULL,updated_at=clock_timestamp() WHERE id=item.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_acquisition_claim_draft(uuid,uuid),
  public.mahshar_acquisition_save_draft_only(uuid,uuid,uuid,text,text,text,text),
  public.mahshar_acquisition_record_draft(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_claim_draft(uuid,uuid),
  public.mahshar_acquisition_save_draft_only(uuid,uuid,uuid,text,text,text,text),
  public.mahshar_acquisition_record_draft(uuid,uuid,uuid,text) TO service_role;
