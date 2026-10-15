-- Official naming proof is additive metadata. No historical backfill or message rewrite.
ALTER TABLE public.worker_sources ADD COLUMN naming_evidence jsonb
  CHECK (naming_evidence IS NULL OR (jsonb_typeof(naming_evidence)='array' AND jsonb_array_length(naming_evidence)<=8));
ALTER TABLE public.admin_acquisition_attempts DROP CONSTRAINT admin_acquisition_draft_provenance_shape,
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
    OR (draft_generator IS NOT NULL AND draft_generator='template' AND draft_prepared_at IS NOT NULL AND subject IS NOT NULL AND body IS NOT NULL
      AND draft_template_version IS NOT NULL AND draft_template_version='mahshar-provider-invitation-v2' AND draft_variables IS NOT NULL
      AND jsonb_typeof(draft_variables)='object' AND draft_only AND status='prepared'
      AND (draft_variables->>'policyVersion') IS NOT DISTINCT FROM 'mahshar-provider-invitation-v2'
      AND jsonb_typeof(draft_variables->'namingEvidence') IS NOT DISTINCT FROM 'array'
      AND jsonb_typeof(draft_variables->'domain') IS NOT DISTINCT FROM 'string'
      AND (draft_variables->'companyVerified') IS NOT DISTINCT FROM (draft_variables->'company' IS DISTINCT FROM 'null'::jsonb)::text::jsonb
      AND (draft_variables->'productVerified') IS NOT DISTINCT FROM (draft_variables->'product' IS DISTINCT FROM 'null'::jsonb)::text::jsonb
      AND coalesce(jsonb_typeof(draft_variables->'company') IN ('string','null'),false)
      AND coalesce(jsonb_typeof(draft_variables->'product') IN ('string','null'),false))
  );

CREATE FUNCTION public.mahshar_invitation_commercial_name(p_name text,p_kind text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT public.mahshar_acquisition_valid_template_name(p_name) AND p_kind IN ('company','product')
 AND p_name !~* '\m(documentation|swagger|test center|test environment|sandbox|demo|developer portal|api reference)\M|(^|[[:space:]-])(production|staging)($|[[:space:]-])'
 AND p_name !~* '^(openapi|api docs?|developer docs?)$'
 AND (p_kind<>'company' OR p_name !~* '^([a-z0-9-]+\.)+[a-z]{2,}$')
$$;
CREATE FUNCTION public.mahshar_invitation_name_proof(p_proof jsonb,p_domain text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE name text:=p_proof->>'name'; kind text:=p_proof->>'kind'; data jsonb:=p_proof->'data'; label text;
BEGIN
 IF jsonb_typeof(p_proof->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(p_proof->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_proof->'basis') IS DISTINCT FROM 'string'
  OR NOT coalesce(public.mahshar_invitation_commercial_name(name,kind),false) THEN RETURN false; END IF;
 IF p_proof->>'basis'='provider_statement' THEN
  label:=CASE WHEN kind='company' THEN 'company' ELSE 'API' END;
  RETURN coalesce(p_proof->>'quote' IN ('Our '||label||' is called '||name||'.',name||' is our '||label||'.'),false);
 END IF;
 RETURN coalesce(p_proof->>'basis'='schema_org' AND jsonb_typeof(data->'name')='string' AND jsonb_typeof(data->'url')='string' AND data->>'name'=name
  AND public.mahshar_acquisition_official_url(data->>'url',p_domain)
  AND CASE WHEN kind='company' THEN data->>'@type'='Organization' ELSE
   data->>'@type' IN ('Product','SoftwareApplication','WebAPI','Service')
   AND jsonb_typeof(data->'description')='string' AND length(data->>'description') BETWEEN 10 AND 500
   AND data->>'description' ~* '\m(API|product|platform|service|software|solution|tool)\M'
   AND (data->>'@type'='WebAPI' OR (data->>'name'||' '||(data->>'description')) ~* '\mAPIs?\M')
   AND btrim(data->>'description') !~* '^(documentation|api (documentation|reference|docs?)|swagger|openapi (spec|doc)|developer portal|sandbox|demo|test center)\M' END,false);
END $$;
REVOKE ALL ON FUNCTION public.mahshar_invitation_commercial_name(text,text),public.mahshar_invitation_name_proof(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.mahshar_invitation_render_v2(p_company text,p_product text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('subject','Invitation to list your API on Mahshar','body',
 CASE WHEN p_company IS NULL THEN 'Hello team,' ELSE 'Hello '||p_company||' team,' END
 ||E'\n\nI''m reaching out from Mahshar, an API marketplace built on Arc Mainnet.\n\nMahshar enables developers, individual users, and autonomous AI agents to discover and access APIs through pay-per-call USDC payments.\n\n'
 ||CASE WHEN p_product IS NULL THEN 'We''d like to invite your team to explore listing one of your APIs on Mahshar.'
 ELSE 'We''d like to invite '||coalesce(p_company,'your team')||' to explore listing '||p_product||' on Mahshar.' END
 ||E'\n\nYou can choose which APIs or endpoints to make available, with no need to migrate your existing infrastructure.\n\nYou can learn more at https://mahshar.xyz/providers.\n\nBest regards,\nMahshar Team\nsupport@mahshar.xyz')
$$;
REVOKE ALL ON FUNCTION public.mahshar_invitation_render_v2(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_template_context(p_lead_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE context jsonb; domain text; evidence jsonb; company text; product text; variables jsonb;
BEGIN
 context:=public.mahshar_acquisition_draft_context(p_lead_id);
 IF context IS NULL THEN RETURN NULL; END IF;
 domain:=context->>'domain';
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'sourceId',value->>'name',value::text),'[]') INTO evidence FROM (
  SELECT proof.value||jsonb_build_object('sourceId',s.id,'sourceType',s.source_type,'sourceRole',s.source_role,
   'url',s.url,'checkedAt',s.checked_at) AS value
  FROM public.worker_sources s CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.naming_evidence,'[]')) proof
  WHERE s.lead_id=p_lead_id AND s.source_type='website'
   AND s.source_role IN ('official_site','official_docs','official_pricing','official_contact')
   AND public.mahshar_acquisition_official_url(s.url,domain)
   AND s.checked_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes'
   AND public.mahshar_invitation_name_proof(proof.value,domain)
  ORDER BY s.id,proof.value->>'name',proof.value::text LIMIT 65
 ) bounded;
 -- Ambiguous or oversized evidence never selects an arbitrary product or brand.
 IF jsonb_array_length(evidence)<=64 THEN
  SELECT CASE WHEN count(DISTINCT e->>'name')=1 THEN min(e->>'name') END INTO company
   FROM jsonb_array_elements(evidence) e WHERE e->>'kind'='company';
  SELECT CASE WHEN count(DISTINCT e->>'name')=1 THEN min(e->>'name') END INTO product
   FROM jsonb_array_elements(evidence) e WHERE e->>'kind'='product';
 END IF;
 variables:=jsonb_build_object('company',company,'product',product,'companyVerified',company IS NOT NULL,
  'productVerified',product IS NOT NULL,'domain',domain,'namingEvidence',evidence,'policyVersion','mahshar-provider-invitation-v2');
 RETURN context||jsonb_build_object('templateVariables',variables,'templateVersion','mahshar-provider-invitation-v2',
  'key',md5(jsonb_build_array(context->>'key','mahshar-provider-invitation-v2',(variables-'namingEvidence')||jsonb_build_object('namingEvidence',
   (SELECT coalesce(jsonb_agg(e-'checkedAt' ORDER BY e->>'sourceId',e->>'name',e::text),'[]') FROM jsonb_array_elements(evidence) e)))::text));
END $$;
CREATE OR REPLACE FUNCTION public.mahshar_acquisition_save_template_draft(p_attempt_id uuid,p_epoch uuid,p_claim_token uuid,
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
    OR p_template_version IS DISTINCT FROM 'mahshar-provider-invitation-v2' THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_runs WHERE id=item.run_id AND status='running' AND deadline_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_products WHERE id=(SELECT product_id FROM public.worker_leads WHERE id=item.lead_id) FOR UPDATE;
  PERFORM 1 FROM public.worker_leads WHERE id=item.lead_id FOR UPDATE;
  context:=public.mahshar_acquisition_template_context(item.lead_id);
  variables:=context->'templateVariables';
  IF context IS NULL OR context->>'allowed' IS DISTINCT FROM 'true' OR context->>'identityVerified' IS DISTINCT FROM 'true'
    OR context->>'contactVerified' IS DISTINCT FROM 'true' OR p_evidence_key IS DISTINCT FROM context->>'key'
 THEN RETURN false; END IF;
  expected:=public.mahshar_invitation_render_v2(variables->>'company',variables->>'product');
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


-- Enforce the same naming policy for initial Outreach, including historical drafts.
-- Read-only assertion; approval, DNC, eligibility and reservation checks stay separate.
CREATE FUNCTION public.mahshar_admin_outreach_assert_invitation_integrity(p_message_id uuid,
 p_recipient text DEFAULT NULL,p_subject text DEFAULT NULL,p_body text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages; lead_id uuid; variables jsonb; expected jsonb; company text; product text;
BEGIN
 SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id;
 IF NOT FOUND OR message.direction<>'outbound' THEN RAISE EXCEPTION 'invitation_integrity_message_missing'; END IF;
 IF p_recipient IS NOT NULL OR p_subject IS NOT NULL OR p_body IS NOT NULL THEN
  IF p_recipient IS DISTINCT FROM message.recipient_email OR p_subject IS DISTINCT FROM message.subject
   OR p_body IS DISTINCT FROM message.body OR message.status<>'ready_to_send' OR message.approved_at IS NULL
   OR message.send_reserved_at IS NULL OR message.send_uncertain_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_integrity_payload_changed';
  END IF;
 END IF;
 -- Replies retain their existing sender/authorization review; they are not invitations.
 IF message.reply_to_message_id IS NOT NULL THEN RETURN true; END IF;
 SELECT t.lead_id INTO lead_id FROM public.admin_outreach_threads t WHERE t.id=message.thread_id;
 variables:=public.mahshar_acquisition_template_context(lead_id)->'templateVariables';
 IF variables IS NULL THEN RAISE EXCEPTION 'invitation_integrity_evidence_missing'; END IF;
 company:=variables->>'company'; product:=variables->>'product';
 expected:=public.mahshar_invitation_render_v2(company,product);
 -- A less-specific safe invitation remains safe when new evidence appears.
 IF message.subject IS DISTINCT FROM expected->>'subject' OR NOT (message.body IN (expected->>'body',
  public.mahshar_invitation_render_v2(company,NULL)->>'body',
  public.mahshar_invitation_render_v2(NULL,product)->>'body',
  public.mahshar_invitation_render_v2(NULL,NULL)->>'body')) THEN
  RAISE EXCEPTION 'invitation_integrity_unverified_names';
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_assert_invitation_integrity(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_assert_invitation_integrity(uuid,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_reserve_send(p_message_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages; thread public.admin_outreach_threads;
  provider public.worker_providers; lead public.worker_leads;
BEGIN
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.direction<>'outbound' OR message.status<>'ready_to_send'
    OR message.approved_at IS NULL OR message.send_reserved_at IS NOT NULL
    THEN RAISE EXCEPTION 'admin_outreach_delivery_not_reservable'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF provider.status IN ('rejected','do_not_contact') OR lead.status IN ('rejected','do_not_contact','closed')
    OR thread.status IN ('rejected','do_not_contact','closed')
    OR EXISTS(SELECT 1 FROM public.worker_decisions WHERE
      (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL)) AND decision IN ('rejected','do_not_contact'))
    THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  IF message.reply_to_message_id IS NOT NULL THEN
    PERFORM public.mahshar_admin_outreach_assert_reply_sendable(p_message_id);
  ELSE
    IF thread.status<>'draft' OR NOT lead.email_ready OR lead.contactability_status<>'verified_email'
      OR lead.preferred_email IS DISTINCT FROM message.recipient_email
      OR NOT EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=provider.id AND lead_id=lead.id
        AND contact_type='email' AND value=message.recipient_email AND verification_status='verified'
        AND preferred AND email_ready AND purpose NOT IN ('security','privacy','abuse','legal','dmca','copyright','compliance','reporting'))
      THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
    IF EXISTS(SELECT 1 FROM public.admin_outreach_messages other
      JOIN public.admin_outreach_threads other_thread ON other_thread.id=other.thread_id
      WHERE other_thread.provider_id=provider.id AND other.id<>message.id AND other.direction='outbound'
        AND other.reply_to_message_id IS NULL AND (other.status='sent' OR other.send_reserved_at IS NOT NULL))
      THEN RAISE EXCEPTION 'admin_outreach_provider_already_contacted'; END IF;
  END IF;
  PERFORM public.mahshar_admin_outreach_assert_invitation_integrity(p_message_id);
  UPDATE public.admin_outreach_messages SET send_reserved_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=p_message_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_acquisition_template_context(uuid),public.mahshar_admin_outreach_reserve_send(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_template_context(uuid),public.mahshar_admin_outreach_reserve_send(uuid) TO service_role;
