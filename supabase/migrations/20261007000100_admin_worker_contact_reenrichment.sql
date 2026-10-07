-- Controlled Contact Discovery maintenance for existing leads.
-- This path does not create or mutate Worker runs, budgets, candidates, or qualifications.

ALTER TABLE public.worker_contacts
  ADD COLUMN evidence_origin text NOT NULL DEFAULT 'automatic'
    CHECK (evidence_origin IN ('automatic','manual'));

CREATE OR REPLACE FUNCTION public.mahshar_worker_maintain_contact_research(
  p_provider_id uuid,
  p_lead_id uuid,
  p_completed boolean,
  p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  provider public.worker_providers;
  product public.worker_products;
  lead public.worker_leads;
  evidence_row jsonb;
  selected public.worker_contacts;
  selected_id uuid;
  next_status text;
  next_email_ready boolean:=false;
  next_preferred_email text;
  next_preferred_contact_url text;
  actionable boolean:=false;
BEGIN
  IF p_provider_id IS NULL OR p_lead_id IS NULL OR p_completed IS NULL
    OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'array'
    OR jsonb_array_length(p_evidence)>12
  THEN RAISE EXCEPTION 'worker_contact_maintenance_invalid'; END IF;

  SELECT * INTO provider FROM public.worker_providers
    WHERE id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_maintenance_identity_invalid'; END IF;

  SELECT * INTO lead FROM public.worker_leads
    WHERE id=p_lead_id AND provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND OR lead.product_id IS NULL
    THEN RAISE EXCEPTION 'worker_contact_maintenance_identity_invalid'; END IF;

  SELECT * INTO product FROM public.worker_products
    WHERE id=lead.product_id AND provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_contact_maintenance_identity_invalid'; END IF;

  -- Entity row locks serialize concurrent FK-backed human decisions. Recheck
  -- every human/DNC boundary before touching automatically generated evidence.
  IF provider.status IN ('do_not_contact','rejected') OR product.status='rejected'
    OR lead.status IN ('do_not_contact','reviewed','contact_ready','contacted','replied','interested','listed','closed','rejected')
    OR EXISTS(SELECT 1 FROM public.worker_decisions
      WHERE (lead_id=p_lead_id OR (provider_id=p_provider_id AND lead_id IS NULL))
        AND decision IN ('do_not_contact','rejected'))
  THEN
    RETURN jsonb_build_object('result','blocked','contactStatus',lead.contactability_status,
      'emailReady',lead.email_ready,'preferredEmail',lead.preferred_email,
      'preferredContactUrl',lead.preferred_contact_url,'actionable',false);
  END IF;

  -- Lock the provider evidence set and clear only its generated preference.
  -- Rediscovered rows are upserted in place before stale rows are removed, so
  -- retries preserve durable evidence IDs as well as logical state.
  PERFORM 1 FROM public.worker_contacts WHERE provider_id=p_provider_id FOR UPDATE;
  UPDATE public.worker_contacts SET preferred=false,updated_at=clock_timestamp()
    WHERE provider_id=p_provider_id AND lead_id=p_lead_id
      AND evidence_origin='automatic' AND preferred;

  FOR evidence_row IN SELECT value FROM jsonb_array_elements(p_evidence) LOOP
    IF evidence_row->>'type' NOT IN ('email','official_contact','sales_channel')
      OR evidence_row->>'purpose' NOT IN ('api','developer','business','partnerships','sales','general','support','security','privacy','legal','contact')
      OR evidence_row->>'sourceType' NOT IN ('official_site','official_docs','official_github')
      OR evidence_row->>'verificationStatus'<>'verified'
      OR coalesce(length(evidence_row->>'value'),0) NOT BETWEEN 3 AND 2048
      OR coalesce(length(evidence_row->>'sourceUrl'),0) NOT BETWEEN 8 AND 2048
      OR evidence_row->>'sourceUrl' !~ '^https://'
      OR (evidence_row->>'type'='email' AND (
        evidence_row->>'value'<>lower(evidence_row->>'value')
        OR evidence_row->>'value' !~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
      ))
      OR (evidence_row->>'type'<>'email' AND evidence_row->>'value' !~ '^https://')
    THEN RAISE EXCEPTION 'worker_contact_maintenance_evidence_invalid'; END IF;

    INSERT INTO public.worker_contacts(provider_id,lead_id,contact_type,value,purpose,source_url,source_type,
      verification_status,preferred,email_ready,discovered_at,verified_at,evidence_origin)
    VALUES(p_provider_id,p_lead_id,evidence_row->>'type',evidence_row->>'value',evidence_row->>'purpose',
      evidence_row->>'sourceUrl',evidence_row->>'sourceType','verified',false,
      CASE WHEN evidence_row->>'type'='email' AND evidence_row->>'purpose' NOT IN ('security','privacy','legal')
        THEN coalesce((evidence_row->>'emailReady')::boolean,false) ELSE false END,
      (evidence_row->>'discoveredAt')::timestamptz,(evidence_row->>'verifiedAt')::timestamptz,'automatic')
    ON CONFLICT(provider_id,contact_type,value) DO UPDATE SET
      purpose=excluded.purpose,source_url=excluded.source_url,source_type=excluded.source_type,
      verification_status='verified',preferred=false,email_ready=excluded.email_ready,
      discovered_at=excluded.discovered_at,verified_at=excluded.verified_at,updated_at=clock_timestamp()
    WHERE public.worker_contacts.lead_id=p_lead_id
      AND public.worker_contacts.evidence_origin='automatic';
  END LOOP;

  DELETE FROM public.worker_contacts contact
    WHERE contact.provider_id=p_provider_id AND contact.lead_id=p_lead_id
      AND contact.evidence_origin='automatic'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence) value
        WHERE value->>'type'=contact.contact_type AND value->>'value'=contact.value);

  -- Manual preference is immutable here. Otherwise select the same ordered
  -- outreach classes used by Contact Discovery from the refreshed auto set.
  IF NOT EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND preferred) THEN
    SELECT id INTO selected_id FROM public.worker_contacts
      WHERE provider_id=p_provider_id AND lead_id=p_lead_id AND evidence_origin='automatic'
        AND purpose NOT IN ('security','privacy','legal')
        AND (contact_type<>'email' OR email_ready)
      ORDER BY CASE purpose
        WHEN 'api' THEN 0 WHEN 'developer' THEN 0 WHEN 'business' THEN 0 WHEN 'partnerships' THEN 0
        WHEN 'sales' THEN 1 WHEN 'general' THEN 2 WHEN 'support' THEN 3 WHEN 'contact' THEN 4 ELSE 9 END
        + CASE WHEN contact_type='email' THEN 0 ELSE 10 END,
        value
      LIMIT 1;
    IF selected_id IS NOT NULL THEN
      UPDATE public.worker_contacts SET preferred=true,updated_at=clock_timestamp() WHERE id=selected_id;
    END IF;
  END IF;

  SELECT * INTO selected FROM public.worker_contacts
    WHERE provider_id=p_provider_id AND preferred
      AND purpose NOT IN ('security','privacy','legal')
      AND (contact_type<>'email' OR email_ready)
    LIMIT 1;

  IF FOUND THEN
    actionable:=true;
    next_email_ready:=selected.contact_type='email' AND selected.email_ready;
    next_preferred_email:=CASE WHEN next_email_ready THEN selected.value ELSE NULL END;
    next_preferred_contact_url:=CASE WHEN selected.contact_type='email' THEN selected.source_url ELSE selected.value END;
    next_status:=CASE WHEN next_email_ready THEN 'verified_email'
      WHEN selected.contact_type='sales_channel' THEN 'official_sales_channel'
      ELSE 'official_contact_page' END;
  ELSE
    next_status:=CASE WHEN p_completed THEN 'contact_unavailable' ELSE 'unknown' END;
  END IF;

  UPDATE public.worker_leads SET
    status=CASE
      WHEN qualification_status='qualified' AND actionable AND status='discovered' THEN 'qualified'
      WHEN qualification_status='qualified' AND NOT actionable AND status='qualified' THEN 'discovered'
      ELSE status END,
    contactability_status=next_status,email_ready=next_email_ready,
    preferred_email=next_preferred_email,preferred_contact_url=next_preferred_contact_url,
    contact_researched_at=CASE WHEN p_completed THEN clock_timestamp() ELSE NULL END,
    updated_at=clock_timestamp()
  WHERE id=p_lead_id;

  RETURN jsonb_build_object('result','saved','contactStatus',next_status,
    'emailReady',next_email_ready,'preferredEmail',next_preferred_email,
    'preferredContactUrl',next_preferred_contact_url,'actionable',actionable);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_maintain_contact_research(uuid,uuid,boolean,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_maintain_contact_research(uuid,uuid,boolean,jsonb)
  TO service_role;

REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.worker_contacts FROM service_role;
GRANT SELECT ON TABLE public.worker_contacts TO service_role;
