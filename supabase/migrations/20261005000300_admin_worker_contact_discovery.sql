-- Contact Discovery V1: official, bounded contact evidence gates actionable leads.
-- Forward-only; no historical run or lead data is rewritten.

ALTER TABLE public.worker_runs
  ADD COLUMN contact_fetch_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT worker_runs_contact_fetch_check CHECK (contact_fetch_count BETWEEN 0 AND 120);

ALTER TABLE public.worker_leads
  ADD COLUMN email_ready boolean NOT NULL DEFAULT false,
  ADD COLUMN preferred_email text,
  ADD COLUMN preferred_contact_url text,
  ADD COLUMN contact_researched_at timestamptz,
  ADD CONSTRAINT worker_leads_preferred_email_check CHECK (
    preferred_email IS NULL OR (length(preferred_email) BETWEEN 3 AND 320 AND preferred_email = lower(preferred_email))
  ),
  ADD CONSTRAINT worker_leads_preferred_contact_url_check CHECK (
    preferred_contact_url IS NULL OR (length(preferred_contact_url) BETWEEN 8 AND 2048 AND preferred_contact_url ~ '^https://')
  ),
  ADD CONSTRAINT worker_leads_email_ready_check CHECK (NOT email_ready OR preferred_email IS NOT NULL);

DO $worker_contact_constraints$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.worker_leads'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%contactability_status%'
  LOOP EXECUTE format('ALTER TABLE public.worker_leads DROP CONSTRAINT %I',constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.worker_budget_claims'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%budget_type%'
  LOOP EXECUTE format('ALTER TABLE public.worker_budget_claims DROP CONSTRAINT %I',constraint_row.conname); END LOOP;
END $worker_contact_constraints$;

ALTER TABLE public.worker_leads ADD CONSTRAINT worker_leads_contactability_v1_check CHECK (contactability_status IN (
  'verified_email','verified_official_contact','official_contact_page','official_sales_channel',
  'contact_unavailable','none_found','unknown'
));
ALTER TABLE public.worker_budget_claims ADD CONSTRAINT worker_budget_claims_type_contact_check
  CHECK (budget_type IN ('source','research','groq','traction','contact'));

DROP INDEX public.worker_leads_admin_rank;
ALTER TABLE public.worker_leads DROP COLUMN contactability_rank;
ALTER TABLE public.worker_leads ADD COLUMN contactability_rank smallint GENERATED ALWAYS AS (CASE contactability_status
  WHEN 'verified_email' THEN 0 WHEN 'verified_official_contact' THEN 1 WHEN 'official_sales_channel' THEN 2
  WHEN 'official_contact_page' THEN 3 WHEN 'contact_unavailable' THEN 4 WHEN 'none_found' THEN 5 ELSE 6 END
) STORED;
CREATE INDEX worker_leads_admin_rank ON public.worker_leads(
  qualification_rank,fit_score DESC,traction_score DESC,traction_confidence_rank,
  contactability_rank,created_at DESC,id DESC
) WHERE qualification_status IN ('qualified','review_candidate');

CREATE TABLE public.worker_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.worker_providers(id),
  lead_id uuid NOT NULL REFERENCES public.worker_leads(id),
  contact_type text NOT NULL CHECK (contact_type IN ('email','official_contact','sales_channel')),
  value text NOT NULL CHECK (length(value) BETWEEN 3 AND 2048),
  purpose text NOT NULL CHECK (purpose IN (
    'api','developer','business','partnerships','sales','general','support','security','privacy','legal','contact'
  )),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 8 AND 2048 AND source_url ~ '^https://'),
  source_type text NOT NULL CHECK (source_type IN ('official_site','official_docs','official_github')),
  verification_status text NOT NULL CHECK (verification_status='verified'),
  preferred boolean NOT NULL DEFAULT false,
  email_ready boolean NOT NULL DEFAULT false CHECK (NOT email_ready OR contact_type='email'),
  discovered_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(provider_id,contact_type,value)
);
CREATE UNIQUE INDEX worker_contacts_one_preferred ON public.worker_contacts(provider_id) WHERE preferred;
CREATE INDEX worker_contacts_lead_verified ON public.worker_contacts(lead_id,preferred DESC,verified_at DESC);
ALTER TABLE public.worker_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.worker_contacts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.worker_contacts TO service_role;

CREATE TABLE public.worker_contact_enrichment_claims (
  discovery_batch_id uuid NOT NULL REFERENCES public.worker_runs(id),
  claim_key text NOT NULL CHECK (claim_key ~ '^[a-z0-9:_-]{1,120}$'),
  lead_id uuid NOT NULL REFERENCES public.worker_leads(id),
  candidate_id uuid NOT NULL REFERENCES public.worker_candidates(id),
  claim_order smallint NOT NULL CHECK (claim_order BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(discovery_batch_id,claim_key,lead_id),
  UNIQUE(discovery_batch_id,lead_id)
);
ALTER TABLE public.worker_contact_enrichment_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.worker_contact_enrichment_claims FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.worker_contact_enrichment_claims TO service_role;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_budget_v2(
  p_run_id uuid,p_budget text,p_claim_key text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; contact_count integer;
BEGIN
  IF p_budget NOT IN ('source','research','groq','traction','contact') THEN RAISE EXCEPTION 'worker_budget_type_invalid'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_budget_claim_key_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.worker_budget_claims WHERE discovery_batch_id=target.discovery_batch_id
    AND budget_type=p_budget AND claim_key=p_claim_key) THEN RETURN 'replayed'; END IF;
  IF target.status NOT IN ('running','stop_requested') THEN RAISE EXCEPTION 'worker_run_not_active'; END IF;
  IF target.deadline_at<=clock_timestamp() THEN RETURN 'deadline_reached'; END IF;
  SELECT count(*)::integer INTO contact_count FROM public.worker_budget_claims
    WHERE discovery_batch_id=target.discovery_batch_id AND budget_type='contact';
  IF NOT ((p_budget='source' AND target.source_query_count<301)
    OR (p_budget='research' AND target.research_fetch_count<240)
    OR (p_budget='groq' AND target.groq_call_count<100)
    OR (p_budget='traction' AND target.traction_fetch_count<60)
    OR (p_budget='contact' AND contact_count<120)) THEN
    IF p_budget='contact' THEN UPDATE public.worker_runs SET contact_fetch_count=contact_count WHERE id=p_run_id; END IF;
    RETURN 'exhausted';
  END IF;
  INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
    VALUES(target.discovery_batch_id,p_budget,p_claim_key);
  UPDATE public.worker_runs SET
    source_query_count=source_query_count+CASE WHEN p_budget='source' THEN 1 ELSE 0 END,
    research_fetch_count=research_fetch_count+CASE WHEN p_budget='research' THEN 1 ELSE 0 END,
    groq_call_count=groq_call_count+CASE WHEN p_budget='groq' THEN 1 ELSE 0 END,
    traction_fetch_count=traction_fetch_count+CASE WHEN p_budget='traction' THEN 1 ELSE 0 END,
    contact_fetch_count=CASE WHEN p_budget='contact' THEN contact_count+1 ELSE contact_fetch_count END,
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_run_id;
  RETURN 'claimed';
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_budget(p_run_id uuid,p_budget text,p_claim_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RETURN public.mahshar_worker_claim_budget_v2(p_run_id,p_budget,p_claim_key) IN ('claimed','replayed'); END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_create_target_run(p_resume boolean DEFAULT false)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE control_row public.worker_control; source_run public.worker_runs; checkpoint_value jsonb; next_index integer;
  new_run_id uuid:=gen_random_uuid(); created_run public.worker_runs;
BEGIN
  PERFORM public.mahshar_worker_reconcile_stale_run();
  SELECT * INTO control_row FROM public.worker_control WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_control_unavailable'; END IF;
  IF control_row.qualified_target<>50 OR control_row.raw_candidate_limit<>300 THEN RAISE EXCEPTION 'worker_discovery_target_invalid'; END IF;
  IF EXISTS(SELECT 1 FROM public.worker_runs WHERE status IN ('queued','running','stop_requested')) THEN RAISE EXCEPTION 'worker_already_active'; END IF;
  IF p_resume THEN
    checkpoint_value:=control_row.current_checkpoint;
    IF checkpoint_value IS NULL OR control_row.checkpoint_run_id IS NULL
      OR (checkpoint_value->>'version')<>'1' OR (checkpoint_value->>'nextIndex')!~'^[0-9]+$'
      OR (checkpoint_value->>'batchSize')!~'^[0-9]+$' THEN RAISE EXCEPTION 'worker_checkpoint_invalid'; END IF;
    next_index:=(checkpoint_value->>'nextIndex')::integer;
    SELECT * INTO source_run FROM public.worker_runs WHERE id=control_row.checkpoint_run_id FOR UPDATE;
    IF NOT FOUND OR source_run.status NOT IN ('stopped','failed') OR source_run.completion_reason IS NOT NULL
      OR (source_run.raw_candidate_limit IS NOT NULL AND source_run.raw_candidate_limit<>control_row.raw_candidate_limit)
      OR source_run.qualified_target<>control_row.qualified_target OR source_run.processed_count<>next_index
      OR coalesce(source_run.source_cursor,source_run.processed_count)<>next_index OR source_run.checkpoint<>checkpoint_value
      OR next_index<=0 OR next_index>=coalesce(source_run.raw_candidate_limit,source_run.batch_size)
    THEN RAISE EXCEPTION 'worker_checkpoint_provenance_invalid'; END IF;
  ELSE
    next_index:=0; checkpoint_value:=jsonb_build_object('version',1,'nextIndex',0,'batchSize',control_row.raw_candidate_limit);
  END IF;
  INSERT INTO public.worker_runs(id,status,batch_size,processed_count,discovered_count,duplicate_count,filtered_count,
    qualified_count,persisted_count,checkpoint,heartbeat_at,discovery_batch_id,deadline_at,source_query_count,research_fetch_count,
    groq_call_count,qualified_target,raw_candidate_limit,source_cursor,source_exhausted,review_candidate_count,deferred_count,
    traction_scored_count,traction_fetch_count,contact_fetch_count)
  VALUES(new_run_id,'queued',
    CASE WHEN p_resume THEN coalesce(source_run.raw_candidate_limit,source_run.batch_size) ELSE control_row.raw_candidate_limit END,next_index,
    CASE WHEN p_resume THEN source_run.discovered_count ELSE 0 END,CASE WHEN p_resume THEN source_run.duplicate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.filtered_count ELSE 0 END,CASE WHEN p_resume THEN source_run.qualified_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.persisted_count ELSE 0 END,checkpoint_value,clock_timestamp(),
    CASE WHEN p_resume THEN source_run.discovery_batch_id ELSE new_run_id END,
    CASE WHEN p_resume THEN source_run.deadline_at ELSE clock_timestamp()+interval '15 minutes' END,
    CASE WHEN p_resume THEN source_run.source_query_count ELSE 0 END,CASE WHEN p_resume THEN source_run.research_fetch_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.groq_call_count ELSE 0 END,control_row.qualified_target,
    CASE WHEN p_resume THEN coalesce(source_run.raw_candidate_limit,source_run.batch_size) ELSE control_row.raw_candidate_limit END,next_index,
    CASE WHEN p_resume THEN source_run.source_exhausted ELSE false END,CASE WHEN p_resume THEN source_run.review_candidate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.deferred_count ELSE 0 END,CASE WHEN p_resume THEN source_run.traction_scored_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.traction_fetch_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.contact_fetch_count ELSE 0 END) RETURNING * INTO created_run;
  UPDATE public.worker_control SET desired_state='running',current_checkpoint=checkpoint_value,
    checkpoint_run_id=created_run.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN created_run;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_save_contact_research(
  p_run_id uuid,p_provider_id uuid,p_lead_id uuid,p_status text,p_email_ready boolean,
  p_preferred_email text,p_preferred_contact_url text,p_completed boolean,p_evidence jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; lead public.worker_leads; evidence_row jsonb;
BEGIN
  IF p_status NOT IN ('verified_email','verified_official_contact','official_contact_page','official_sales_channel','contact_unavailable','unknown')
    OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'array' OR jsonb_array_length(p_evidence)>12
    OR (p_email_ready AND p_preferred_email IS NULL)
    OR (p_preferred_email IS NOT NULL AND (length(p_preferred_email) NOT BETWEEN 3 AND 320 OR p_preferred_email<>lower(p_preferred_email)))
    OR (p_preferred_contact_url IS NOT NULL AND (length(p_preferred_contact_url) NOT BETWEEN 8 AND 2048 OR p_preferred_contact_url !~ '^https://'))
    OR (p_status='contact_unavailable' AND NOT p_completed)
  THEN RAISE EXCEPTION 'worker_contact_research_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND OR target.status NOT IN ('running','stop_requested') THEN RAISE EXCEPTION 'worker_run_not_active'; END IF;
  SELECT * INTO lead FROM public.worker_leads WHERE id=p_lead_id AND provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_lead_invalid'; END IF;
  IF lead.status IN ('do_not_contact','reviewed','contact_ready','contacted','replied','interested','listed','closed','rejected')
    OR EXISTS(SELECT 1 FROM public.worker_decisions WHERE (lead_id=p_lead_id OR (provider_id=p_provider_id AND lead_id IS NULL))
      AND decision IN ('do_not_contact','rejected'))
    OR EXISTS(SELECT 1 FROM public.worker_providers WHERE id=p_provider_id AND status IN ('do_not_contact','rejected'))
  THEN RETURN 'blocked'; END IF;
  IF NOT p_completed THEN RETURN 'saved'; END IF;
  UPDATE public.worker_contacts SET preferred=false,updated_at=clock_timestamp() WHERE provider_id=p_provider_id AND preferred;
  FOR evidence_row IN SELECT value FROM jsonb_array_elements(p_evidence) LOOP
    IF evidence_row->>'type' NOT IN ('email','official_contact','sales_channel')
      OR evidence_row->>'purpose' NOT IN ('api','developer','business','partnerships','sales','general','support','security','privacy','legal','contact')
      OR evidence_row->>'sourceType' NOT IN ('official_site','official_docs','official_github')
      OR evidence_row->>'verificationStatus'<>'verified'
      OR coalesce(length(evidence_row->>'value'),0) NOT BETWEEN 3 AND 2048
      OR coalesce(length(evidence_row->>'sourceUrl'),0) NOT BETWEEN 8 AND 2048
      OR evidence_row->>'sourceUrl' !~ '^https://'
    THEN RAISE EXCEPTION 'worker_contact_evidence_invalid'; END IF;
    INSERT INTO public.worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
      verification_status,preferred,email_ready,discovered_at,verified_at)
    VALUES(p_provider_id,p_lead_id,evidence_row->>'type',evidence_row->>'value',evidence_row->>'purpose',
      evidence_row->>'sourceUrl',evidence_row->>'sourceType','verified',coalesce((evidence_row->>'preferred')::boolean,false),
      coalesce((evidence_row->>'emailReady')::boolean,false),(evidence_row->>'discoveredAt')::timestamptz,
      (evidence_row->>'verifiedAt')::timestamptz)
    ON CONFLICT(provider_id,contact_type,value) DO UPDATE SET purpose=excluded.purpose,
      source_url=excluded.source_url,source_type=excluded.source_type,verification_status='verified',
      preferred=excluded.preferred,email_ready=excluded.email_ready,verified_at=excluded.verified_at,updated_at=clock_timestamp();
  END LOOP;
  IF p_status IN ('verified_email','verified_official_contact','official_contact_page','official_sales_channel')
    AND NOT EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND preferred)
  THEN RAISE EXCEPTION 'worker_contact_preferred_missing'; END IF;
  IF p_preferred_email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.worker_contacts
    WHERE provider_id=p_provider_id AND contact_type='email' AND value=p_preferred_email AND verification_status='verified' AND email_ready)
  THEN RAISE EXCEPTION 'worker_contact_email_unverified'; END IF;
  UPDATE public.worker_leads SET contactability_status=p_status,email_ready=p_email_ready,
    preferred_email=p_preferred_email,preferred_contact_url=p_preferred_contact_url,
    contact_researched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_lead_id;
  RETURN 'saved';
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_contact_enrichment(
  p_run_id uuid,p_claim_key text,p_limit integer DEFAULT 5
) RETURNS TABLE(candidate_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5 OR p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$'
    THEN RAISE EXCEPTION 'worker_contact_enrichment_claim_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND OR target.status NOT IN ('running','stop_requested') OR target.deadline_at<=clock_timestamp()
    OR target.discovery_batch_id<>target.id OR target.qualified_count>=target.qualified_target THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.worker_contact_enrichment_claims
    WHERE discovery_batch_id=target.discovery_batch_id AND claim_key=p_claim_key) THEN
    INSERT INTO public.worker_contact_enrichment_claims(discovery_batch_id,claim_key,lead_id,candidate_id,claim_order)
    SELECT target.discovery_batch_id,p_claim_key,eligible.lead_id,eligible.candidate_id,
      row_number() OVER(ORDER BY eligible.created_at,eligible.lead_id)::smallint
    FROM (
      SELECT lead.id lead_id,candidate.id candidate_id,lead.created_at
      FROM public.worker_leads lead
      JOIN LATERAL (SELECT c.id FROM public.worker_candidates c WHERE c.lead_id=lead.id
        ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) candidate ON true
      JOIN public.worker_providers provider ON provider.id=lead.provider_id
      WHERE lead.qualification_status IN ('qualified','review_candidate') AND lead.contact_researched_at IS NULL
        AND lead.status IN ('discovered','qualified') AND provider.status NOT IN ('do_not_contact','rejected')
        AND NOT EXISTS(SELECT 1 FROM public.worker_decisions decision
          WHERE (decision.lead_id=lead.id OR (decision.provider_id=lead.provider_id AND decision.lead_id IS NULL))
            AND decision.decision IN ('do_not_contact','rejected'))
        AND NOT EXISTS(SELECT 1 FROM public.worker_contact_enrichment_claims prior
          WHERE prior.discovery_batch_id=target.discovery_batch_id AND prior.lead_id=lead.id)
      ORDER BY lead.created_at,lead.id LIMIT p_limit FOR UPDATE OF lead SKIP LOCKED
    ) eligible;
  END IF;
  RETURN QUERY SELECT claim.candidate_id FROM public.worker_contact_enrichment_claims claim
    WHERE claim.discovery_batch_id=target.discovery_batch_id AND claim.claim_key=p_claim_key ORDER BY claim.claim_order;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_apply_contact_actionability(
  p_run_id uuid,p_candidate_id uuid,p_provider_id uuid,p_lead_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; provider public.worker_providers; product public.worker_products;
  lead public.worker_leads; target_product_id uuid; inserted integer:=0; blocked boolean:=false;
BEGIN
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND OR target.status NOT IN ('running','stop_requested') THEN RAISE EXCEPTION 'worker_run_not_active'; END IF;
  SELECT product_id INTO target_product_id FROM public.worker_leads WHERE id=p_lead_id AND provider_id=p_provider_id;
  IF NOT FOUND OR target_product_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.worker_candidates WHERE id=p_candidate_id AND lead_id=p_lead_id)
    THEN RAISE EXCEPTION 'worker_contact_actionability_invalid'; END IF;
  SELECT * INTO provider FROM public.worker_providers WHERE id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_actionability_invalid'; END IF;
  SELECT * INTO product FROM public.worker_products WHERE id=target_product_id AND provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_actionability_invalid'; END IF;
  SELECT * INTO lead FROM public.worker_leads WHERE id=p_lead_id AND provider_id=p_provider_id
    AND product_id=target_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_actionability_invalid'; END IF;
  IF provider.status IN ('do_not_contact','rejected') OR product.status='rejected'
    OR lead.status IN ('do_not_contact','reviewed','contact_ready','contacted','replied','interested','listed','closed','rejected')
    OR EXISTS(SELECT 1 FROM public.worker_decisions WHERE (lead_id=p_lead_id OR (provider_id=p_provider_id AND lead_id IS NULL))
      AND decision IN ('do_not_contact','rejected')) THEN blocked:=true;
  ELSIF lead.contactability_status IN ('verified_email','verified_official_contact','official_contact_page','official_sales_channel')
    AND EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND preferred AND verification_status='verified') THEN
    IF lead.qualification_status='qualified' THEN
      UPDATE public.worker_leads SET status='qualified',updated_at=clock_timestamp() WHERE id=p_lead_id AND status='discovered';
      IF target.qualified_count<target.qualified_target THEN
        INSERT INTO public.worker_qualified_contributions(discovery_batch_id,lead_id,candidate_id)
          VALUES(target.discovery_batch_id,p_lead_id,p_candidate_id) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS inserted=ROW_COUNT;
        IF inserted=1 THEN UPDATE public.worker_runs SET qualified_count=qualified_count+1,
          completion_reason=CASE WHEN qualified_count+1=qualified_target THEN 'qualified_target_reached' ELSE completion_reason END,
          heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_run_id AND qualified_count<qualified_target RETURNING * INTO target; END IF;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('countedQualified',inserted=1,'targetReached',target.qualified_count>=target.qualified_target,'blocked',blocked);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_persist_qualification_v2(
  p_run_id uuid,p_candidate_id uuid,p_lease_id uuid,p_provider_id uuid,p_product_id uuid,p_lead_id uuid,p_qualification jsonb,
  p_traction jsonb,p_contactability text,p_model text,p_qualified boolean,p_deferred_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; target public.worker_runs; candidate public.worker_candidates; actionable boolean:=false;
  contribution_inserted integer:=0; counted_qualified boolean:=false; target_reached boolean:=false;
BEGIN
  IF p_traction IS NOT NULL AND (
    jsonb_typeof(p_traction)<>'object' OR (p_traction->>'tractionScore')::numeric NOT BETWEEN 0 AND 100
    OR p_traction->>'tractionLevel' NOT IN ('low','medium','high')
    OR p_traction->>'tractionConfidence' NOT IN ('low','medium','high','unknown')
    OR jsonb_typeof(p_traction->'signals')<>'array' OR jsonb_array_length(p_traction->'signals')>8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_traction->'signals') value
      WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-z0-9_]{1,80}$')
    OR jsonb_typeof(p_traction->'concerns')<>'array' OR jsonb_array_length(p_traction->'concerns')>8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_traction->'concerns') value
      WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-z0-9_]{1,80}$')
    OR coalesce(length(p_traction->>'summary'),0) NOT BETWEEN 1 AND 500
    OR (p_traction->>'lastActivityAt' IS NOT NULL AND length(p_traction->>'lastActivityAt')>64)
  ) THEN RAISE EXCEPTION 'worker_traction_invalid'; END IF;
  IF p_contactability NOT IN ('verified_email','verified_official_contact','official_contact_page','official_sales_channel','contact_unavailable','unknown')
    THEN RAISE EXCEPTION 'worker_contactability_invalid'; END IF;
  result:=public.mahshar_worker_persist_qualification(p_candidate_id,p_lease_id,p_provider_id,p_product_id,p_lead_id,
    p_qualification,p_model,p_qualified,p_deferred_reason);
  IF coalesce((result->>'applied')::boolean,false) AND p_traction IS NOT NULL AND p_qualification IS NOT NULL
    AND result->>'status' IN ('persisted','filtered') THEN
    UPDATE public.worker_leads SET traction_score=(p_traction->>'tractionScore')::smallint,
      traction_level=p_traction->>'tractionLevel',traction_confidence=p_traction->>'tractionConfidence',
      last_activity_at=CASE WHEN p_traction->>'lastActivityAt' IS NULL THEN NULL ELSE (p_traction->>'lastActivityAt')::timestamptz END,
      traction_signals=ARRAY(SELECT left(jsonb_array_elements_text(p_traction->'signals'),80)),
      traction_concerns=ARRAY(SELECT left(jsonb_array_elements_text(p_traction->'concerns'),80)),
      traction_summary=p_traction->>'summary',traction_scored_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_lead_id;
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND preferred AND verification_status='verified')
    INTO actionable;
  IF coalesce((result->>'applied')::boolean,false) AND result->>'status'='persisted' AND result->>'reasonCode'='qualified' THEN
    IF NOT actionable THEN
      UPDATE public.worker_leads SET status='discovered',updated_at=clock_timestamp() WHERE id=p_lead_id AND status='qualified';
      UPDATE public.worker_candidates SET reason_code=CASE WHEN p_contactability='contact_unavailable'
        THEN 'qualified_contact_unavailable' ELSE 'qualified_contact_pending' END WHERE id=p_candidate_id;
      result:=jsonb_set(result,'{reasonCode}',to_jsonb(CASE WHEN p_contactability='contact_unavailable'
        THEN 'qualified_contact_unavailable' ELSE 'qualified_contact_pending' END));
    ELSE
      SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
      SELECT * INTO candidate FROM public.worker_candidates WHERE id=p_candidate_id;
      IF NOT FOUND OR candidate.lead_id IS DISTINCT FROM p_lead_id
        OR NOT (candidate.discovery_batch_id=target.discovery_batch_id OR candidate.deferred_claim_batch_id=target.discovery_batch_id)
        THEN RAISE EXCEPTION 'worker_qualified_contribution_invalid'; END IF;
      IF target.status IN ('running','stop_requested') AND target.completion_reason IS NULL AND target.qualified_count<target.qualified_target THEN
        INSERT INTO public.worker_qualified_contributions(discovery_batch_id,lead_id,candidate_id)
          VALUES(target.discovery_batch_id,p_lead_id,p_candidate_id) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS contribution_inserted=ROW_COUNT;
        IF contribution_inserted=1 THEN UPDATE public.worker_runs SET qualified_count=qualified_count+1,
          completion_reason=CASE WHEN qualified_count+1=qualified_target THEN 'qualified_target_reached' ELSE completion_reason END,
          heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=p_run_id AND qualified_count<qualified_target RETURNING * INTO target;
          IF NOT FOUND THEN RAISE EXCEPTION 'worker_qualified_target_conflict'; END IF; counted_qualified:=true; END IF;
      END IF;
      target_reached:=target.qualified_count>=target.qualified_target;
    END IF;
  END IF;
  RETURN result||jsonb_build_object('countedQualified',counted_qualified,'targetReached',target_reached);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_claim_budget_v2(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_budget(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_create_target_run(boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_save_contact_research(uuid,uuid,uuid,text,boolean,text,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_contact_enrichment(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_apply_contact_actionability(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_persist_qualification_v2(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_budget_v2(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_budget(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_create_target_run(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_save_contact_research(uuid,uuid,uuid,text,boolean,text,text,boolean,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_contact_enrichment(uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_apply_contact_actionability(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_persist_qualification_v2(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,boolean,text) TO service_role;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,anon,authenticated,service_role;
