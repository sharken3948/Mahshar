-- Contact coverage metadata and bounded refresh. Local forward migration only.
-- Keep legacy actionability/dispatch contracts; publication never grants sending eligibility.
ALTER TABLE public.worker_leads
  ADD COLUMN contact_research_state text CHECK (contact_research_state IN
    ('verified_email','form_available','manual_required','unresolved','no_contact_found')),
  ADD COLUMN contact_checked_at timestamptz;
ALTER TABLE public.worker_contacts
  ADD COLUMN form_state text CHECK (form_state IN ('available','manual_required')),
  ADD CONSTRAINT worker_contacts_form_state_type_check CHECK (form_state IS NULL OR contact_type<>'email');
-- No backfill: historical records retain unknown coverage rather than invented form evidence.

CREATE OR REPLACE FUNCTION public.mahshar_worker_save_contact_research(
  p_run_id uuid,p_provider_id uuid,p_lead_id uuid,p_status text,p_email_ready boolean,
  p_preferred_email text,p_preferred_contact_url text,p_completed boolean,p_evidence jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; lead public.worker_leads; evidence_row jsonb;
  selected public.worker_contacts; next_status text; next_state text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('verified_email','verified_official_contact','official_contact_page','official_sales_channel','contact_unavailable','unknown')
    OR p_completed IS NULL OR p_email_ready IS NULL
    OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'array' OR jsonb_array_length(p_evidence)>12
    OR (p_email_ready AND p_preferred_email IS NULL)
    OR (p_preferred_email IS NOT NULL AND (length(p_preferred_email) NOT BETWEEN 3 AND 254 OR p_preferred_email<>lower(p_preferred_email)))
    OR (p_preferred_contact_url IS NOT NULL AND (length(p_preferred_contact_url) NOT BETWEEN 8 AND 2048 OR p_preferred_contact_url !~ '^https://'))
    OR (p_status='contact_unavailable' AND NOT p_completed)
  THEN RAISE EXCEPTION 'worker_contact_research_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND OR target.status NOT IN ('running','stop_requested') THEN RAISE EXCEPTION 'worker_run_not_active'; END IF;
  -- Lock the same entity boundaries that protect human decisions and suppression.
  PERFORM 1 FROM public.worker_providers WHERE id=p_provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_products WHERE id=(SELECT product_id FROM public.worker_leads WHERE id=p_lead_id) FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id=p_lead_id AND provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_lead_invalid'; END IF;
  IF lead.status IN ('do_not_contact','reviewed','contact_ready','contacted','replied','interested','listed','closed','rejected')
    OR EXISTS(SELECT 1 FROM public.worker_decisions WHERE (lead_id=p_lead_id OR (provider_id=p_provider_id AND lead_id IS NULL))
      AND decision IN ('do_not_contact','rejected'))
    OR EXISTS(SELECT 1 FROM public.worker_providers WHERE id=p_provider_id AND status IN ('do_not_contact','rejected'))
    OR EXISTS(SELECT 1 FROM public.worker_products WHERE id=lead.product_id AND status='rejected')
    OR EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND evidence_origin='manual' AND preferred
      AND (purpose IN ('security','privacy','legal') OR (contact_type='email' AND NOT email_ready)))
  THEN RETURN 'blocked'; END IF;

  PERFORM 1 FROM public.worker_contacts WHERE provider_id=p_provider_id FOR UPDATE;
  FOR evidence_row IN SELECT value FROM jsonb_array_elements(p_evidence) LOOP
    IF evidence_row->>'type' IS NULL OR evidence_row->>'type' NOT IN ('email','official_contact','sales_channel')
      OR evidence_row->>'purpose' IS NULL OR evidence_row->>'purpose' NOT IN ('api','developer','business','partnerships','sales','general','support','security','privacy','legal','contact')
      OR evidence_row->>'sourceType' IS NULL OR evidence_row->>'sourceType' NOT IN ('official_site','official_docs','official_github')
      OR evidence_row->>'verificationStatus' IS DISTINCT FROM 'verified'
      OR coalesce(length(evidence_row->>'value'),0) NOT BETWEEN 3 AND 2048
      OR coalesce(length(evidence_row->>'sourceUrl'),0) NOT BETWEEN 8 AND 2048
      OR evidence_row->>'sourceUrl' !~ '^https://'
      OR (evidence_row->>'formState' IS NOT NULL AND (evidence_row->>'formState' NOT IN ('available','manual_required') OR evidence_row->>'type'='email'))
      OR (evidence_row->>'type'='email' AND (
        length(evidence_row->>'value')>254 OR evidence_row->>'value'<>lower(evidence_row->>'value')
        OR evidence_row->>'value' LIKE '%..%'
        OR evidence_row->>'value' !~ '^[a-z0-9][a-z0-9.!#$%&''*+=?^_`{|}~-]*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'))
      OR (evidence_row->>'type'<>'email' AND evidence_row->>'value' !~ '^https://')
    THEN RAISE EXCEPTION 'worker_contact_evidence_invalid'; END IF;
    INSERT INTO public.worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
      verification_status,preferred,email_ready,discovered_at,verified_at,form_state)
    VALUES(p_provider_id,p_lead_id,evidence_row->>'type',evidence_row->>'value',evidence_row->>'purpose',
      evidence_row->>'sourceUrl',evidence_row->>'sourceType','verified',false,
      evidence_row->>'type'='email' AND evidence_row->>'purpose' NOT IN ('security','privacy','legal')
        AND coalesce((evidence_row->>'emailReady')::boolean,false),
      (evidence_row->>'discoveredAt')::timestamptz,(evidence_row->>'verifiedAt')::timestamptz,evidence_row->>'formState')
    ON CONFLICT(provider_id,contact_type,value) DO UPDATE SET
      purpose=excluded.purpose,source_url=excluded.source_url,source_type=excluded.source_type,
      verification_status='verified',email_ready=excluded.email_ready,verified_at=excluded.verified_at,
      form_state=coalesce(excluded.form_state,public.worker_contacts.form_state),updated_at=clock_timestamp()
    WHERE public.worker_contacts.evidence_origin='automatic';
  END LOOP;
  IF p_preferred_email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.worker_contacts
    WHERE provider_id=p_provider_id AND contact_type='email' AND value=p_preferred_email AND verification_status='verified' AND email_ready
      AND purpose NOT IN ('security','privacy','legal'))
  THEN RAISE EXCEPTION 'worker_contact_email_unverified'; END IF;

  -- Retain every saved row, its ID and first-discovery timestamp. An incomplete
  -- refresh cannot erase an older verified channel or override a manual choice.
  SELECT * INTO selected FROM public.worker_contacts
    WHERE provider_id=p_provider_id AND verification_status='verified'
      AND purpose NOT IN ('security','privacy','legal') AND (contact_type<>'email' OR email_ready)
    ORDER BY (evidence_origin='manual' AND preferred) DESC,
      CASE WHEN contact_type='email' THEN 0 ELSE 10 END + CASE purpose
        WHEN 'api' THEN 0 WHEN 'developer' THEN 0 WHEN 'business' THEN 0 WHEN 'partnerships' THEN 0
        WHEN 'sales' THEN 1 WHEN 'general' THEN 2 WHEN 'support' THEN 3 WHEN 'contact' THEN 4 ELSE 9 END,value
    LIMIT 1;
  UPDATE public.worker_contacts SET preferred=false,updated_at=clock_timestamp()
    WHERE provider_id=p_provider_id AND preferred AND evidence_origin='automatic' AND id IS DISTINCT FROM selected.id;
  IF selected.id IS NOT NULL AND selected.evidence_origin='automatic' THEN
    UPDATE public.worker_contacts SET preferred=true,updated_at=clock_timestamp() WHERE id=selected.id AND NOT preferred;
  END IF;
  next_status:=CASE WHEN selected.contact_type='email' THEN 'verified_email'
    WHEN selected.contact_type='sales_channel' THEN 'official_sales_channel'
    WHEN selected.id IS NOT NULL THEN 'official_contact_page'
    WHEN p_completed AND p_status='contact_unavailable' THEN 'contact_unavailable' ELSE 'unknown' END;
  next_state:=CASE WHEN selected.contact_type='email' THEN 'verified_email'
    WHEN EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND form_state='manual_required'
      AND purpose NOT IN ('security','privacy','legal')) THEN 'manual_required'
    WHEN EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND form_state='available'
      AND purpose NOT IN ('security','privacy','legal')) THEN 'form_available'
    WHEN next_status='contact_unavailable' THEN 'no_contact_found' ELSE 'unresolved' END;
  UPDATE public.worker_leads SET contactability_status=next_status,
    email_ready=coalesce(selected.contact_type='email' AND selected.email_ready,false),
    preferred_email=CASE WHEN selected.contact_type='email' THEN selected.value END,
    preferred_contact_url=CASE WHEN selected.contact_type='email' THEN selected.source_url ELSE selected.value END,
    contact_research_state=next_state,contact_checked_at=clock_timestamp(),
    contact_researched_at=CASE WHEN p_completed THEN clock_timestamp() ELSE contact_researched_at END,
    updated_at=clock_timestamp() WHERE id=p_lead_id;
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
      row_number() OVER(ORDER BY eligible.commercial_api DESC NULLS LAST,eligible.fit_score DESC NULLS LAST,eligible.checked_at NULLS FIRST,eligible.lead_id)::smallint
    FROM (
      SELECT lead.id lead_id,candidate.id candidate_id,lead.commercial_api,lead.fit_score,coalesce(lead.contact_checked_at,lead.contact_researched_at) checked_at
      FROM public.worker_leads lead
      JOIN LATERAL (SELECT c.id FROM public.worker_candidates c WHERE c.lead_id=lead.id
        ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) candidate ON true
      JOIN public.worker_providers provider ON provider.id=lead.provider_id
      WHERE lead.qualification_status IN ('qualified','review_candidate') AND NOT lead.email_ready
        AND (coalesce(lead.contact_checked_at,lead.contact_researched_at) IS NULL
          OR (lead.commercial_api AND lead.contact_research_state IS NULL)
          OR coalesce(lead.contact_checked_at,lead.contact_researched_at)<=clock_timestamp()-CASE
            WHEN lead.contact_research_state='unresolved' THEN interval '1 day'
            WHEN lead.commercial_api THEN interval '7 days' ELSE interval '30 days' END)
        AND lead.status IN ('discovered','qualified') AND provider.status NOT IN ('do_not_contact','rejected')
        AND NOT EXISTS(SELECT 1 FROM public.worker_decisions decision
          WHERE (decision.lead_id=lead.id OR (decision.provider_id=lead.provider_id AND decision.lead_id IS NULL))
            AND decision.decision IN ('do_not_contact','rejected'))
        AND NOT EXISTS(SELECT 1 FROM public.worker_contact_enrichment_claims prior
          WHERE prior.discovery_batch_id=target.discovery_batch_id AND prior.lead_id IN (SELECT sibling.id FROM public.worker_leads sibling WHERE sibling.provider_id=lead.provider_id))
      AND lead.id=(SELECT sibling.id FROM public.worker_leads sibling
          WHERE sibling.provider_id=lead.provider_id
            AND sibling.qualification_status IN ('qualified','review_candidate')
            AND sibling.status IN ('discovered','qualified') AND NOT sibling.email_ready
            AND (coalesce(sibling.contact_checked_at,sibling.contact_researched_at) IS NULL
              OR (sibling.commercial_api AND sibling.contact_research_state IS NULL)
              OR coalesce(sibling.contact_checked_at,sibling.contact_researched_at)<=clock_timestamp()-CASE
                WHEN sibling.contact_research_state='unresolved' THEN interval '1 day'
                WHEN sibling.commercial_api THEN interval '7 days' ELSE interval '30 days' END)
            AND NOT EXISTS(SELECT 1 FROM public.worker_decisions d WHERE d.lead_id=sibling.id
              AND d.decision IN ('do_not_contact','rejected'))
          ORDER BY sibling.commercial_api DESC NULLS LAST,sibling.fit_score DESC NULLS LAST,sibling.id LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM public.worker_products product WHERE product.id=lead.product_id AND product.status='rejected')
      ORDER BY lead.commercial_api DESC NULLS LAST,lead.fit_score DESC NULLS LAST,
        coalesce(lead.contact_checked_at,lead.contact_researched_at) NULLS FIRST,lead.id
      LIMIT p_limit FOR UPDATE OF lead SKIP LOCKED
    ) eligible;
  END IF;
  RETURN QUERY SELECT claim.candidate_id FROM public.worker_contact_enrichment_claims claim
    WHERE claim.discovery_batch_id=target.discovery_batch_id AND claim.claim_key=p_claim_key ORDER BY claim.claim_order;
END $$;

