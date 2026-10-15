-- Deterministic invitation preparation only; no flags, transport or history rewrites.
ALTER TABLE public.admin_acquisition_attempts
  ADD COLUMN draft_template_version text,
  ADD COLUMN draft_variables jsonb,
  DROP CONSTRAINT admin_acquisition_draft_provenance_shape,
  ADD CONSTRAINT admin_acquisition_draft_provenance_shape CHECK (
    (draft_generator IS NULL AND draft_prepared_at IS NULL AND draft_template_version IS NULL AND draft_variables IS NULL)
    OR (draft_generator IS NOT NULL AND draft_generator='groq' AND draft_prepared_at IS NOT NULL AND subject IS NOT NULL AND body IS NOT NULL
      AND draft_template_version IS NULL AND draft_variables IS NULL)
    OR (draft_generator IS NOT NULL AND draft_generator='template' AND draft_prepared_at IS NOT NULL AND subject IS NOT NULL AND body IS NOT NULL
      AND draft_template_version IS NOT NULL AND draft_template_version='mahshar-provider-invitation-v1' AND draft_variables IS NOT NULL
      AND jsonb_typeof(draft_variables)='object' AND draft_only AND status='prepared'
      AND jsonb_typeof(draft_variables->'company') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof(draft_variables->'product') IS NOT DISTINCT FROM 'string'
      AND (draft_variables->'companyVerified') IS NOT DISTINCT FROM 'true'::jsonb
      AND (draft_variables->'productVerified') IS NOT DISTINCT FROM 'true'::jsonb
      AND jsonb_typeof(draft_variables->'companySourceId') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof(draft_variables->'productSourceId') IS NOT DISTINCT FROM 'string')
  );

CREATE FUNCTION public.mahshar_acquisition_valid_template_name(p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT coalesce(length(p_name) BETWEEN 1 AND 200 AND p_name=btrim(p_name)
    AND p_name ~ '[[:alnum:]]' AND p_name !~ '[[:cntrl:]<>@]' AND position('://' IN p_name)=0
    AND lower(p_name) NOT IN ('unknown','n/a','na','none','null','undefined','tbd','[company]','[api product]')
    AND p_name !~* '\[(company|api product)\]'
    AND NOT EXISTS(SELECT 1 FROM generate_series(1,length(p_name)) i WHERE ascii(substr(p_name,i,1)) IN (173,1564,6158,65279)
      OR ascii(substr(p_name,i,1)) BETWEEN 8203 AND 8207 OR ascii(substr(p_name,i,1)) BETWEEN 8232 AND 8238
      OR ascii(substr(p_name,i,1)) BETWEEN 8288 AND 8303),false)
$$;

CREATE FUNCTION public.mahshar_acquisition_render_template(p_company text,p_product text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN public.mahshar_acquisition_valid_template_name(p_company)
    AND public.mahshar_acquisition_valid_template_name(p_product) THEN jsonb_build_object(
      'subject','Invitation to list your API on Mahshar',
      'body','Hello '||p_company||E' team,\n\nI''m reaching out from Mahshar, an API marketplace built on Arc Mainnet.\n\nMahshar enables developers, individual users, and autonomous AI agents to discover and access APIs through pay-per-call USDC payments.\n\nWe''d like to invite '||p_company||' to explore listing '||p_product||E' on Mahshar.\n\nYou can choose which APIs or endpoints to make available, with no need to migrate your existing infrastructure.\n\nYou can learn more at https://mahshar.xyz/providers.\n\nBest regards,\nMahshar Team\nsupport@mahshar.xyz') ELSE NULL END
$$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_valid_template_name(text),
  public.mahshar_acquisition_render_template(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.mahshar_acquisition_template_context(p_lead_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE context jsonb; company text; product text; domain text; company_source uuid; product_source uuid; variables jsonb;
BEGIN
  context:=public.mahshar_acquisition_draft_context(p_lead_id);
  IF context IS NULL THEN RETURN NULL; END IF;
  SELECT p.canonical_name,x.display_name,p.canonical_domain INTO company,product,domain
    FROM public.worker_leads l JOIN public.worker_providers p ON p.id=l.provider_id
    LEFT JOIN public.worker_products x ON x.id=l.product_id WHERE l.id=p_lead_id;
  -- Exact saved canonical names only. A verified canonical domain is a provider
  -- name; never derive a company brand from it. Other names need official evidence.
  SELECT s.id INTO company_source FROM public.worker_sources s WHERE s.lead_id=p_lead_id
    AND s.source_type='website' AND s.source_role IN ('official_site','official_docs')
    AND public.mahshar_acquisition_official_url(s.url,domain)
    AND s.checked_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes'
    AND (lower(company)=domain OR lower(s.title)=lower(company)
      OR left(lower(s.title),length(company)+1)=lower(company)||' ')
    ORDER BY (s.source_role='official_site') DESC,s.id LIMIT 1;
  -- A parsed, saved directory contract may prove its API title without being
  -- mislabeled official_docs. Generic directory assertions do not prove names.
  SELECT s.id INTO product_source FROM public.worker_sources s WHERE s.lead_id=p_lead_id
    AND s.checked_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes'
    AND (lower(s.title)=lower(product) OR left(lower(s.title),length(product)+1)=lower(product)||' ')
    AND ((s.source_type='website' AND s.source_role='official_docs' AND public.mahshar_acquisition_official_url(s.url,domain))
      OR (s.source_type='api_directory' AND s.source_role='directory_assertion'
        AND position('Structured OpenAPI contract verified' IN s.factual_summary)>0))
    ORDER BY (s.source_role='official_docs') DESC,s.id LIMIT 1;
  variables:=jsonb_build_object('company',company,'product',product,
    'companyVerified',company_source IS NOT NULL AND (context->>'identityVerified')::boolean,
    'productVerified',product_source IS NOT NULL AND (context->>'identityVerified')::boolean,
    'companySourceId',company_source,'productSourceId',product_source);
  RETURN context||jsonb_build_object('templateVariables',variables,'templateVersion','mahshar-provider-invitation-v1',
    'key',md5((jsonb_build_array(context->>'key','mahshar-provider-invitation-v1',variables))::text));
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_template_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_template_context(uuid) TO service_role;

CREATE FUNCTION public.mahshar_acquisition_immutable_template()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.draft_generator='template' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'acquisition_template_immutable'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'acquisition_template_immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_immutable_template() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER admin_acquisition_template_immutable BEFORE UPDATE OR DELETE ON public.admin_acquisition_attempts
  FOR EACH ROW EXECUTE FUNCTION public.mahshar_acquisition_immutable_template();

CREATE FUNCTION public.mahshar_acquisition_save_template_draft(p_attempt_id uuid,p_epoch uuid,p_claim_token uuid,
  p_evidence_key text,p_subject text,p_body text,p_template_version text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts; context jsonb; variables jsonb; expected jsonb;
BEGIN
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running' AND epoch=p_epoch
    AND operating_mode='continuous' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_control WHERE id=1 AND desired_state='running' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR NOT item.draft_only OR item.status<>'investigating' OR item.subject IS NOT NULL OR item.body IS NOT NULL
    OR p_claim_token IS NULL OR item.draft_claim_token IS DISTINCT FROM p_claim_token
    OR item.draft_claim_expires_at IS NULL OR item.draft_claim_expires_at<=clock_timestamp()
    OR p_template_version IS DISTINCT FROM 'mahshar-provider-invitation-v1' THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_runs WHERE id=item.run_id AND status='running' AND deadline_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_products WHERE id=(SELECT product_id FROM public.worker_leads WHERE id=item.lead_id) FOR UPDATE;
  PERFORM 1 FROM public.worker_leads WHERE id=item.lead_id FOR UPDATE;
  context:=public.mahshar_acquisition_template_context(item.lead_id);
  variables:=context->'templateVariables';
  IF context IS NULL OR context->>'allowed' IS DISTINCT FROM 'true' OR context->>'identityVerified' IS DISTINCT FROM 'true'
    OR context->>'contactVerified' IS DISTINCT FROM 'true' OR p_evidence_key IS DISTINCT FROM context->>'key'
    OR variables->>'companyVerified' IS DISTINCT FROM 'true' OR variables->>'productVerified' IS DISTINCT FROM 'true' THEN RETURN false; END IF;
  expected:=public.mahshar_acquisition_render_template(variables->>'company',variables->>'product');
  IF expected IS NULL OR p_subject IS DISTINCT FROM expected->>'subject' OR p_body IS DISTINCT FROM expected->>'body'
    THEN RETURN false; END IF;
  UPDATE public.admin_acquisition_attempts SET status='prepared',reason_code=NULL,
    recipient_email=(SELECT preferred_email FROM public.worker_leads WHERE id=item.lead_id),
    subject=p_subject,body=p_body,draft_evidence_key=p_evidence_key,draft_claim_token=NULL,
    draft_claim_expires_at=NULL,updated_at=clock_timestamp() WHERE id=item.id;
  -- Existing provenance-clearing trigger and both updates share this transaction.
  UPDATE public.admin_acquisition_attempts SET draft_generator='template',draft_prepared_at=clock_timestamp(),
    draft_template_version=p_template_version,draft_variables=variables WHERE id=item.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_save_template_draft(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_save_template_draft(uuid,uuid,uuid,text,text,text,text) TO service_role;

-- Reuse the existing fenced, bounded claim and skip-history mechanism.
CREATE OR REPLACE FUNCTION public.mahshar_acquisition_claim_draft(p_run_id uuid,p_epoch uuid)
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
  SELECT l.id AS lead_id,l.provider_id,p.canonical_name AS provider,coalesce(x.display_name,'') AS product,
    l.preferred_email AS email,l.email_ready,ctx.value AS context INTO picked
  FROM public.worker_leads l JOIN public.worker_providers p ON p.id=l.provider_id
    LEFT JOIN public.worker_products x ON x.id=l.product_id
    CROSS JOIN LATERAL (SELECT public.mahshar_acquisition_template_context(l.id) AS value) ctx
    LEFT JOIN public.admin_acquisition_attempts a ON a.provider_id=l.provider_id
  WHERE (ctx.value->>'allowed')::boolean
    AND (a.id IS NULL OR (a.subject IS NULL AND a.reserved_at IS NULL AND a.dispatched_at IS NULL AND (
      (a.status='investigating' AND (a.draft_claim_expires_at IS NULL OR a.draft_claim_expires_at<=clock_timestamp()))
      OR (a.status='skipped' AND a.reason_code IN ('no_email','invalid_email','unverified_contact',
        'recipient_ineligible','channel_not_approved','provider_identity_unverified','api_documentation_missing','template_company_missing','template_product_missing',
        'template_company_invalid','template_product_invalid','template_company_unverified','template_product_unverified')
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


CREATE OR REPLACE FUNCTION public.mahshar_acquisition_record_draft(p_attempt_id uuid,p_epoch uuid,p_claim_token uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('no_email','invalid_email','unverified_contact',
    'provider_identity_unverified','api_documentation_missing','provider_suppressed','prior_outreach','draft_invalid','provider_failed','template_company_missing','template_product_missing',
    'template_company_invalid','template_product_invalid','template_company_unverified','template_product_unverified') THEN RETURN false; END IF;
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running' AND epoch=p_epoch
    AND operating_mode='continuous' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR NOT item.draft_only OR item.status<>'investigating' OR item.subject IS NOT NULL
    OR item.draft_claim_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
  UPDATE public.admin_acquisition_attempts SET status=CASE WHEN p_reason='provider_failed' THEN 'failed' ELSE 'skipped' END,
    reason_code=p_reason,draft_evidence_key=public.mahshar_acquisition_template_context(item.lead_id)->>'key',
    draft_claim_token=NULL,draft_claim_expires_at=NULL,updated_at=clock_timestamp() WHERE id=item.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_acquisition_claim_draft(uuid,uuid),public.mahshar_acquisition_record_draft(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_claim_draft(uuid,uuid),public.mahshar_acquisition_record_draft(uuid,uuid,uuid,text) TO service_role;
