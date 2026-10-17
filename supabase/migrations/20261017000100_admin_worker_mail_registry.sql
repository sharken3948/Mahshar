-- Apply atomically through migration tracking; fail rather than wait indefinitely
-- for a live operational transaction. These settings end with that transaction.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Durable recovery metadata belongs to providers/leads, never temporary candidates.
-- These are unverified intake assertions, not contact or qualification evidence.
ALTER TABLE public.worker_providers ADD COLUMN mail_intake jsonb
 CHECK (mail_intake IS NULL OR (jsonb_typeof(mail_intake)='object' AND octet_length(mail_intake::text)<=8192));
ALTER TABLE public.worker_leads ADD COLUMN mail_refresh jsonb
 CHECK (mail_refresh IS NULL OR (jsonb_typeof(mail_refresh)='object' AND octet_length(mail_refresh::text)<=1024));
ALTER TABLE public.worker_control ADD COLUMN mail_reconcile_cursor uuid;
-- Indexed scheduling metadata; never evidence of verification or consent.
ALTER TABLE public.worker_providers ADD COLUMN mail_intake_due_at timestamptz;
ALTER TABLE public.worker_leads ADD COLUMN mail_refresh_due_at timestamptz;
CREATE INDEX worker_mail_intake_due ON public.worker_providers(mail_intake_due_at,id)
 WHERE mail_intake_due_at IS NOT NULL;
CREATE INDEX worker_mail_refresh_due ON public.worker_leads(mail_refresh_due_at,provider_id,id)
 WHERE mail_refresh_due_at IS NOT NULL;
CREATE INDEX worker_mail_contact_clock ON public.worker_contacts(lead_id,verified_at DESC);
CREATE INDEX worker_mail_source_clock ON public.worker_sources(lead_id,checked_at DESC)
 WHERE source_type='website' AND source_role IN ('official_site','official_docs');
ALTER TABLE public.worker_candidates ADD COLUMN mail_recovery_kind text
 CHECK (mail_recovery_kind IN ('legacy','contact'));
ALTER TABLE public.worker_candidates DROP CONSTRAINT worker_candidates_ordinal_target_check;
ALTER TABLE public.worker_candidates ADD CONSTRAINT worker_candidates_ordinal_target_check
 CHECK (ordinal BETWEEN 0 AND 299 OR (ordinal BETWEEN 300 AND 309 AND mail_recovery_kind IS NOT NULL));

-- Manual invitations only. No historical import, consent, dispatch or receipt is created.
CREATE TABLE public.admin_worker_mail_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL UNIQUE REFERENCES public.worker_providers(id),
  identity_key text NOT NULL UNIQUE CHECK (length(identity_key) BETWEEN 1 AND 253 AND identity_key=lower(identity_key)),
  lead_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.worker_contacts(id),
  api_name text NOT NULL CHECK (length(api_name) BETWEEN 1 AND 200),
  email_address text NOT NULL CHECK (length(email_address) BETWEEN 3 AND 254 AND email_address=lower(email_address)),
  contact_source_url text NOT NULL,
  contact_verified_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','manual_sent','excluded')),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  manual_sent_at timestamptz,
  marked_by text,
  FOREIGN KEY(lead_id,provider_id) REFERENCES public.worker_leads(id,provider_id),
  CHECK ((status='manual_sent')=(manual_sent_at IS NOT NULL)),
  CHECK ((manual_sent_at IS NULL)=(marked_by IS NULL)),
  CHECK (marked_by IS NULL OR marked_by ~ '^0x[0-9a-f]{40}$')
);
ALTER TABLE public.admin_worker_mail_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_worker_mail_registry FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.admin_worker_mail_registry TO service_role;
CREATE INDEX admin_worker_mail_pending ON public.admin_worker_mail_registry(id) WHERE status='pending';

-- Contact readiness is independent of permission to use an outbound channel.
CREATE FUNCTION public.mahshar_worker_mail_business_email(p_email text,p_purpose text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(length(p_email) BETWEEN 3 AND 254 AND p_email=lower(p_email)
  AND p_email ~ '^[a-z0-9][a-z0-9.!#$%&''*+=?^_`{|}~-]*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  AND p_email NOT LIKE '%..%'
  AND p_purpose IN ('api','developer','business','partnerships','sales','general','support')
  AND regexp_replace(split_part(p_email,'@',1),'[^a-z]','','g') !~
    '^(privacy|dataprotection|security|legal|abuse|dmca|copyright|compliance|press|media|report)|^(dpo|pr)$',false)
$$;

CREATE FUNCTION public.mahshar_worker_mail_block_reason(p_provider_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.worker_providers WHERE id=p_provider_id AND status<>'active')
  OR EXISTS(SELECT 1 FROM public.worker_decisions WHERE provider_id=p_provider_id AND decision IN ('rejected','do_not_contact'))
  OR EXISTS(SELECT 1 FROM public.worker_leads WHERE provider_id=p_provider_id
    AND status IN ('contacted','replied','interested','listed','do_not_contact','closed'))
 THEN RETURN 'provider_finalized'; END IF;
 IF EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id=p_provider_id AND evidence_origin='manual'
   AND preferred AND (NOT email_ready OR NOT public.mahshar_worker_mail_business_email(value,purpose)))
 THEN RETURN 'manual_contact_suppressed'; END IF;
 IF EXISTS(SELECT 1 FROM public.discovered_apis d JOIN public.worker_providers p ON p.id=p_provider_id
   WHERE CASE WHEN d.invited OR EXISTS(SELECT 1 FROM public.outreach_log o WHERE o.discovered_api_id=d.id)
    THEN public.mahshar_acquisition_official_url(d.repo_url,p.canonical_domain) ELSE false END)
 THEN RETURN 'legacy_outreach_history'; END IF;
 IF EXISTS(SELECT 1 FROM public.admin_outreach_threads WHERE provider_id=p_provider_id
    AND (status NOT IN ('contact_ready','draft') OR last_outreach_at IS NOT NULL OR last_reply_at IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.admin_outreach_messages m JOIN public.admin_outreach_threads t ON t.id=m.thread_id
    WHERE t.provider_id=p_provider_id AND m.direction='outbound'
    AND (m.status='sent' OR m.send_reserved_at IS NOT NULL OR m.send_uncertain_at IS NOT NULL
      OR m.acquisition_dispatch_started_at IS NOT NULL OR m.provider_message_id IS NOT NULL))
 THEN RETURN 'outreach_history'; END IF;
 IF EXISTS(SELECT 1 FROM public.admin_acquisition_attempts WHERE provider_id=p_provider_id
   AND status<>'simulated_sent' AND (status IN ('reserved','uncertain') OR (status='failed' AND NOT coalesce((draft_only AND reason_code='provider_failed'
      AND reserved_at IS NULL AND dispatched_at IS NULL AND provider_message_id IS NULL),false)) OR reserved_at IS NOT NULL
    OR dispatched_at IS NOT NULL OR provider_message_id IS NOT NULL
    OR (status='skipped' AND coalesce(reason_code,'') NOT IN ('no_email','invalid_email','unverified_contact',
      'recipient_ineligible','channel_not_approved','provider_identity_unverified','api_documentation_missing','draft_invalid',
      'template_company_missing','template_product_missing','template_company_invalid','template_product_invalid',
      'template_company_unverified','template_product_unverified'))))
 THEN RETURN 'acquisition_history'; END IF;
 IF EXISTS(SELECT 1 FROM public.admin_acquisition_attempts WHERE provider_id=p_provider_id AND status='simulated_sent')
 THEN RETURN 'simulation_history'; END IF;
 RETURN NULL;
END $$;

-- No candidate or invitation-draft dependency. Only current official evidence admits a contact.
CREATE FUNCTION public.mahshar_worker_mail_candidate(p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE provider public.worker_providers; picked record; reason text; variables jsonb;
BEGIN
 SELECT * INTO provider FROM public.worker_providers WHERE id=p_provider_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('eligible',false,'reason','provider_missing'); END IF;
 IF EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=p_provider_id AND status<>'pending')
 THEN RETURN jsonb_build_object('eligible',false,'reason','mail_history'); END IF;
 reason:=public.mahshar_worker_mail_block_reason(p_provider_id);
 IF reason IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'reason',reason); END IF;
 IF EXISTS(SELECT 1 FROM public.admin_acquisition_attempts a WHERE a.provider_id=p_provider_id AND a.status='investigating'
   AND ((a.draft_claim_expires_at>statement_timestamp()) OR (NOT a.draft_only
     AND EXISTS(SELECT 1 FROM public.worker_runs r WHERE r.id=a.run_id AND r.status IN ('queued','running','stop_requested')))))
 THEN RETURN jsonb_build_object('eligible',false,'reason','acquisition_in_progress'); END IF;
 SELECT l.id AS lead_id,c.id AS contact_id,c.value,c.source_url,c.verified_at INTO picked
 FROM public.worker_leads l JOIN public.worker_products x ON x.id=l.product_id AND x.provider_id=l.provider_id
 JOIN public.worker_contacts c ON c.provider_id=l.provider_id AND c.lead_id=l.id
 WHERE l.provider_id=p_provider_id AND l.qualification_status='qualified'
  AND l.status IN ('discovered','qualified','reviewed','contact_ready') AND x.status<>'rejected'
  AND l.email_ready AND l.contactability_status='verified_email'
  AND c.contact_type='email' AND c.verification_status='verified' AND c.email_ready
  AND public.mahshar_worker_mail_business_email(c.value,c.purpose)
  AND ((c.source_type IN ('official_site','official_docs')
    AND public.mahshar_acquisition_official_url(c.source_url,provider.canonical_domain))
   OR (c.source_type='official_github' AND c.source_url ~ '^https://github.com/[a-zA-Z0-9_.-]+([/?#]|$)'
    AND EXISTS(SELECT 1 FROM public.worker_provider_identities i WHERE i.provider_id=l.provider_id
      AND i.identity_type='github_org' AND i.normalized_value=lower(substring(c.source_url FROM '^https://github.com/([^/?#]+)')))))
  AND c.verified_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes'
  AND EXISTS(SELECT 1 FROM public.worker_sources s WHERE s.lead_id=l.id AND s.source_type='website'
    AND s.source_role IN ('official_site','official_docs') AND public.mahshar_acquisition_official_url(s.url,provider.canonical_domain)
    AND s.checked_at BETWEEN statement_timestamp()-interval '30 days' AND statement_timestamp()+interval '5 minutes')
 ORDER BY c.preferred DESC,CASE c.purpose WHEN 'partnerships' THEN 0 WHEN 'business' THEN 0
  WHEN 'api' THEN 0 WHEN 'developer' THEN 0 WHEN 'sales' THEN 1 WHEN 'general' THEN 2 ELSE 3 END,
  l.fit_score DESC NULLS LAST,l.id,c.id LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('eligible',false,'reason','qualification_or_contact_incomplete'); END IF;
 variables:=public.mahshar_acquisition_template_context(picked.lead_id)->'templateVariables';
 RETURN jsonb_build_object('eligible',true,'providerId',provider.id,'identityKey',provider.canonical_domain,
  'leadId',picked.lead_id,'contactId',picked.contact_id,'email',picked.value,
  'sourceUrl',picked.source_url,'verifiedAt',picked.verified_at,
  'apiName',coalesce(variables->>'product',provider.canonical_name));
END $$;

-- Called with the provider locked. Due clocks are derived from actual saved
-- evidence and retained retry state. Updating these clocks never verifies data.
CREATE FUNCTION public.mahshar_worker_mail_schedule(p_provider_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.worker_providers; l public.worker_leads; meta jsonb; contact_at timestamptz;
 docs_at timestamptz; evidence_key text; due_at timestamptz; reset_cycle boolean; blocked boolean;
BEGIN
 SELECT * INTO p FROM public.worker_providers WHERE id=p_provider_id;
 blocked:=public.mahshar_worker_mail_block_reason(p_provider_id) IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=p_provider_id AND status<>'pending');
 meta:=p.mail_intake;
 due_at:=CASE WHEN NOT blocked AND meta IS NOT NULL AND meta->>'state' NOT IN ('complete','exhausted')
  AND coalesce((meta->>'attempts')::integer,0)<3
  AND NOT EXISTS(SELECT 1 FROM public.worker_leads WHERE provider_id=p.id
    AND qualification_status IN ('qualified','review_candidate','rejected'))
  THEN coalesce((meta->>'retryAfter')::timestamptz,'-infinity'::timestamptz) END;
 UPDATE public.worker_providers SET mail_intake_due_at=due_at WHERE id=p.id AND mail_intake_due_at IS DISTINCT FROM due_at;
 FOR l IN SELECT * FROM public.worker_leads WHERE provider_id=p.id FOR UPDATE SKIP LOCKED LOOP
  due_at:=NULL;
  IF NOT blocked AND l.qualification_status IN ('qualified','review_candidate') AND l.status IN ('discovered','qualified')
   AND EXISTS(SELECT 1 FROM public.worker_products WHERE id=l.product_id AND status<>'rejected') THEN
   meta:=coalesce(l.mail_refresh,'{}');
   SELECT max(verified_at)::text INTO evidence_key FROM public.worker_contacts WHERE lead_id=l.id;
   reset_cycle:=meta->>'evidenceKey' IS DISTINCT FROM evidence_key OR
    (meta->>'lastReason'='contact_enriched' AND l.email_ready
     AND (meta->>'completedAt')::timestamptz<=statement_timestamp()-interval '30 days');
   IF coalesce((meta->>'attempts')::integer,0)<3 OR reset_cycle THEN
    SELECT max(c.verified_at) INTO contact_at FROM public.worker_contacts c WHERE c.lead_id=l.id
     AND c.contact_type='email' AND c.verification_status='verified' AND c.email_ready
     AND public.mahshar_worker_mail_business_email(c.value,c.purpose)
     AND c.verified_at<=statement_timestamp()+interval '5 minutes'
     AND ((c.source_type IN ('official_site','official_docs') AND public.mahshar_acquisition_official_url(c.source_url,p.canonical_domain))
      OR (c.source_type='official_github' AND EXISTS(SELECT 1 FROM public.worker_provider_identities i
       WHERE i.provider_id=p.id AND i.identity_type='github_org'
        AND i.normalized_value=lower(substring(c.source_url FROM '^https://github.com/([^/?#]+)')))));
    SELECT max(s.checked_at) INTO docs_at FROM public.worker_sources s WHERE s.lead_id=l.id AND s.source_type='website'
     AND s.source_role IN ('official_site','official_docs') AND public.mahshar_acquisition_official_url(s.url,p.canonical_domain)
     AND s.checked_at<=statement_timestamp()+interval '5 minutes';
    due_at:=CASE WHEN l.email_ready AND l.contactability_status='verified_email' AND contact_at IS NOT NULL AND docs_at IS NOT NULL
     THEN least(contact_at,docs_at)+interval '30 days' ELSE '-infinity'::timestamptz END;
    IF NOT coalesce(reset_cycle,false) THEN due_at:=greatest(due_at,coalesce((meta->>'retryAfter')::timestamptz,'-infinity'::timestamptz)); END IF;
   END IF;
  END IF;
  UPDATE public.worker_leads SET mail_refresh_due_at=due_at WHERE id=l.id AND mail_refresh_due_at IS DISTINCT FROM due_at;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_worker_mail_schedule(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Initialize only new scheduling columns, before any enqueue triggers exist.
-- No provider/contact/qualification/draft/registry history is imported or rewritten.
DO $mail_schedule_baseline$
DECLARE item record;
BEGIN
 FOR item IN SELECT id FROM public.worker_providers ORDER BY id LOOP
  PERFORM public.mahshar_worker_mail_schedule(item.id);
 END LOOP;
END $mail_schedule_baseline$;

CREATE FUNCTION public.mahshar_worker_mail_sync(p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE candidate jsonb; reason text;
BEGIN
 -- Same provider lock used by initial Outreach and Acquisition reservations.
 PERFORM 1 FROM public.worker_providers WHERE id=p_provider_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM public.mahshar_worker_mail_schedule(p_provider_id);
 reason:=public.mahshar_worker_mail_block_reason(p_provider_id);
 IF reason IS NULL AND EXISTS(SELECT 1 FROM public.admin_worker_mail_registry r
   JOIN public.worker_leads l ON l.id=r.lead_id JOIN public.worker_products p ON p.id=l.product_id
   WHERE r.provider_id=p_provider_id AND r.status='pending' AND (l.status='rejected' OR p.status='rejected'))
 THEN reason:='selected_lead_rejected'; END IF;
 IF reason IS NOT NULL THEN
  UPDATE public.admin_worker_mail_registry SET status='excluded',reason_code=reason,updated_at=clock_timestamp()
   WHERE provider_id=p_provider_id AND status='pending';
 END IF;
 candidate:=public.mahshar_worker_mail_candidate(p_provider_id);
 IF candidate->>'eligible'='true' THEN
  INSERT INTO public.admin_worker_mail_registry(provider_id,identity_key,lead_id,contact_id,api_name,email_address,
    contact_source_url,contact_verified_at)
  VALUES(p_provider_id,candidate->>'identityKey',(candidate->>'leadId')::uuid,(candidate->>'contactId')::uuid,
    candidate->>'apiName',candidate->>'email',candidate->>'sourceUrl',(candidate->>'verifiedAt')::timestamptz)
  ON CONFLICT(provider_id) DO UPDATE SET lead_id=excluded.lead_id,contact_id=excluded.contact_id,
    api_name=excluded.api_name,email_address=excluded.email_address,contact_source_url=excluded.contact_source_url,
    contact_verified_at=excluded.contact_verified_at,updated_at=clock_timestamp()
  WHERE public.admin_worker_mail_registry.status='pending'
   AND (public.admin_worker_mail_registry.lead_id,public.admin_worker_mail_registry.contact_id,
    public.admin_worker_mail_registry.api_name,public.admin_worker_mail_registry.email_address,
    public.admin_worker_mail_registry.contact_source_url,public.admin_worker_mail_registry.contact_verified_at)
   IS DISTINCT FROM (excluded.lead_id,excluded.contact_id,excluded.api_name,excluded.email_address,
    excluded.contact_source_url,excluded.contact_verified_at);
 END IF;
 RETURN candidate;
END $$;

CREATE FUNCTION public.mahshar_worker_mail_refresh_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target_provider_id uuid;
BEGIN
 IF TG_TABLE_NAME='worker_providers' THEN target_provider_id:=NEW.id;
 ELSIF TG_TABLE_NAME='worker_sources' THEN
  SELECT l.provider_id INTO target_provider_id FROM public.worker_leads l WHERE l.id=NEW.lead_id;
 ELSE target_provider_id:=NEW.provider_id; END IF;
 -- A row trigger may already hold a lead/contact/thread lock. Never wait in
 -- reverse order for its provider; the durable reconciliation cursor retries it.
 PERFORM 1 FROM public.worker_providers WHERE id=target_provider_id FOR UPDATE SKIP LOCKED;
 IF FOUND THEN PERFORM public.mahshar_worker_mail_sync(target_provider_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER worker_mail_lead AFTER INSERT OR UPDATE OF status,qualification_status,email_ready,contactability_status,mail_refresh ON public.worker_leads
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_contact AFTER INSERT OR UPDATE ON public.worker_contacts
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_source AFTER INSERT OR UPDATE ON public.worker_sources
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_provider AFTER UPDATE OF status,canonical_name,canonical_domain,mail_intake ON public.worker_providers
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_product AFTER UPDATE ON public.worker_products
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_identity AFTER INSERT OR UPDATE ON public.worker_provider_identities
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_decision AFTER INSERT OR UPDATE ON public.worker_decisions
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_thread AFTER UPDATE ON public.admin_outreach_threads
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();
CREATE TRIGGER worker_mail_acquisition_result AFTER INSERT OR UPDATE ON public.admin_acquisition_attempts
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_refresh_trigger();

CREATE FUNCTION public.mahshar_worker_mail_mark_sent(p_id uuid,p_admin_wallet text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_worker_mail_registry; candidate jsonb;
BEGIN
 IF p_admin_wallet IS NULL OR p_admin_wallet !~ '^0x[0-9a-f]{40}$' THEN RAISE EXCEPTION 'mail_admin_invalid'; END IF;
 SELECT * INTO item FROM public.admin_worker_mail_registry WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'mail_not_found'; END IF;
 PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
 SELECT * INTO item FROM public.admin_worker_mail_registry WHERE id=p_id FOR UPDATE;
 IF item.status='manual_sent' THEN
  RETURN jsonb_build_object('id',item.id,'status',item.status,'manualSentAt',item.manual_sent_at);
 END IF;
 candidate:=public.mahshar_worker_mail_candidate(item.provider_id);
 IF item.status<>'pending' OR candidate->>'eligible' IS DISTINCT FROM 'true'
  OR candidate->>'contactId' IS DISTINCT FROM item.contact_id::text
  OR candidate->>'email' IS DISTINCT FROM item.email_address THEN RAISE EXCEPTION 'mail_not_pending'; END IF;
 UPDATE public.admin_worker_mail_registry SET status='manual_sent',manual_sent_at=clock_timestamp(),
  marked_by=p_admin_wallet,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO item;
 RETURN jsonb_build_object('id',item.id,'status',item.status,'manualSentAt',item.manual_sent_at);
END $$;

CREATE FUNCTION public.mahshar_worker_mail_list(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE items jsonb;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'mail_limit_invalid'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO items FROM (
  SELECT r.id,r.api_name AS "apiName",r.email_address AS "emailAddress"
  FROM public.admin_worker_mail_registry r
  CROSS JOIN LATERAL (SELECT public.mahshar_worker_mail_candidate(r.provider_id) AS value) c
  WHERE r.status='pending' AND (p_after IS NULL OR r.id>p_after)
   AND c.value->>'eligible'='true' AND c.value->>'contactId'=r.contact_id::text
   AND c.value->>'email'=r.email_address
  ORDER BY r.id LIMIT p_limit+1
 ) t;
 RETURN jsonb_build_object('items',(SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]')
   FROM jsonb_array_elements(items) WITH ORDINALITY WHERE ordinality<=p_limit),
  'nextCursor',CASE WHEN jsonb_array_length(items)>p_limit THEN items->(p_limit-1)->>'id' END);
END $$;

-- Explicit, bounded backfill. Dry-run is read-only and is the default; no legacy facts are invented.
CREATE FUNCTION public.mahshar_worker_mail_reconcile(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 100,
 p_dry_run boolean DEFAULT true,p_provider_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE provider record; candidate jsonb; result jsonb:='[]'; state text;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 100 OR p_dry_run IS NULL THEN RAISE EXCEPTION 'mail_reconcile_invalid'; END IF;
 FOR provider IN SELECT id FROM public.worker_providers WHERE (p_after IS NULL OR id>p_after)
  AND (p_provider_ids IS NULL OR id=ANY(p_provider_ids)) ORDER BY id LIMIT p_limit LOOP
  IF p_dry_run THEN candidate:=public.mahshar_worker_mail_candidate(provider.id);
  ELSE candidate:=public.mahshar_worker_mail_sync(provider.id); END IF;
  SELECT status INTO state FROM public.admin_worker_mail_registry WHERE provider_id=provider.id;
  result:=result||jsonb_build_array(jsonb_build_object('providerId',provider.id,'eligible',candidate->'eligible',
    'reason',candidate->>'reason','registryStatus',state,'selectedEmail',candidate->>'email',
    'selectedContactId',candidate->>'contactId',
    'qualificationStatus',(SELECT qualification_status FROM public.worker_leads WHERE provider_id=provider.id
      ORDER BY CASE qualification_status WHEN 'qualified' THEN 0 WHEN 'review_candidate' THEN 1 ELSE 2 END,id LIMIT 1)));
 END LOOP;
 RETURN result;
END $$;

-- Batch-scoped observations are never the authority for permanent mailing history.
CREATE FUNCTION public.mahshar_worker_mail_discovery_state(p_domains text[])
RETURNS TABLE(domain text,provider_id uuid,reason text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT input.domain,p.id,CASE
  WHEN EXISTS(SELECT 1 FROM public.discovered_apis d WHERE CASE
    WHEN d.invited OR EXISTS(SELECT 1 FROM public.outreach_log o WHERE o.discovered_api_id=d.id)
    THEN public.mahshar_acquisition_official_url(d.repo_url,input.domain) ELSE false END) THEN 'legacy_outreach_history'
  WHEN r.status='pending' THEN 'manual_mail_pending'
  WHEN r.id IS NOT NULL THEN 'manual_mail_history'
  WHEN public.mahshar_worker_mail_block_reason(p.id) IS NOT NULL THEN 'provider_history_finalized'
  WHEN EXISTS(SELECT 1 FROM public.worker_leads l WHERE l.provider_id=p.id
    AND l.qualification_status IN ('qualified','review_candidate','rejected')) THEN 'provider_already_processed'
  WHEN EXISTS(SELECT 1 FROM public.worker_leads l WHERE l.provider_id=p.id AND l.qualification_status='deferred'
    AND l.qualification_retry_after>statement_timestamp()) THEN 'provider_retry_not_due'
  WHEN p.mail_intake IS NOT NULL THEN 'legacy_intake_retained'
 END
 FROM unnest(p_domains) input(domain)
 LEFT JOIN public.worker_providers p ON p.id=coalesce(
  (SELECT i.provider_id FROM public.worker_provider_identities i WHERE i.identity_type='domain' AND i.normalized_value=input.domain),
  (SELECT x.id FROM public.worker_providers x WHERE x.canonical_domain=input.domain))
 LEFT JOIN public.admin_worker_mail_registry r ON r.provider_id=p.id
 WHERE cardinality(p_domains)<=300
$$;

-- A manual claim must win or lose against the existing reservation under the same provider lock.
CREATE FUNCTION public.mahshar_worker_mail_reservation_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target_provider_id uuid;
BEGIN
 IF TG_TABLE_NAME='admin_outreach_messages' THEN
  IF NEW.reply_to_message_id IS NOT NULL OR NEW.direction<>'outbound'
   OR NEW.send_reserved_at IS NULL OR NEW.send_reserved_at IS NOT DISTINCT FROM OLD.send_reserved_at THEN RETURN NEW; END IF;
  SELECT t.provider_id INTO target_provider_id FROM public.admin_outreach_threads t WHERE t.id=NEW.thread_id;
 ELSE
  IF NEW.status<>'reserved' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  target_provider_id:=NEW.provider_id;
 END IF;
 PERFORM 1 FROM public.worker_providers WHERE id=target_provider_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.admin_worker_mail_registry r WHERE r.provider_id=target_provider_id)
 THEN RAISE EXCEPTION 'provider_manual_mail_claimed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER worker_mail_outreach_reservation BEFORE UPDATE ON public.admin_outreach_messages
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_reservation_guard();
CREATE TRIGGER worker_mail_acquisition_reservation BEFORE UPDATE ON public.admin_acquisition_attempts
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_reservation_guard();

-- Add only selection predicates to the installed functions; preserve their existing bodies and ACLs.
DO $mail_selection$
DECLARE signature text; definition text; needle text; replacement text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.mahshar_acquisition_draft_context(uuid)',
  'public.mahshar_acquisition_claim_next(uuid,uuid)','public.mahshar_acquisition_reserve_brevo(uuid,uuid)',
  'public.mahshar_worker_claim_deferred_candidates(uuid,text,integer)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF signature LIKE '%draft_context%' THEN
   needle:='allowed:=lead.qualification_status';
   replacement:='allowed:=NOT EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=lead.provider_id) AND lead.qualification_status';
  ELSIF signature LIKE '%claim_next%' THEN
   needle:='WHERE l.qualification_status';
   replacement:='WHERE NOT EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=l.provider_id) AND l.qualification_status';
  ELSIF signature LIKE '%claim_deferred_candidates%' THEN
   needle:='WHERE candidate.status=''deferred''';
   replacement:='WHERE candidate.mail_recovery_kind IS NULL AND candidate.status=''deferred''';
  ELSE
   needle:='WHERE public.mahshar_acquisition_brevo_eligible(a.id)';
   replacement:='WHERE NOT EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=a.provider_id) AND public.mahshar_acquisition_brevo_eligible(a.id)';
  END IF;
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'mail_selection_baseline_mismatch: %',signature; END IF;
  EXECUTE replace(definition,needle,replacement);
 END LOOP;
END $mail_selection$;

-- Explicit historical intake. Only retained legacy UUIDs and normalized domain assertions are seeded.
-- No contacts, official proof, consent, qualification, drafts, or registry claims are manufactured.
CREATE FUNCTION public.mahshar_worker_mail_seed_legacy(p_rows jsonb,p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; matched public.worker_providers; result jsonb:='[]'; legacy_ids uuid[]; urls jsonb; domain text;
BEGIN
 IF p_dry_run IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>100
 THEN RAISE EXCEPTION 'mail_intake_invalid'; END IF;
 IF NOT p_dry_run AND NOT pg_try_advisory_xact_lock(hashtextextended('worker-mail-legacy-intake',1937006962)) THEN
  RAISE lock_not_available USING MESSAGE='mail_intake_busy';
 END IF;
 -- Multi-provider writes agree with reconciliation's UUID order. New identities
 -- sort last; concurrent imports use only the private intake lock above.
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) input
  ORDER BY (SELECT min(p.id::text) FROM public.worker_providers p WHERE p.canonical_domain=input.value->>'identity'
   OR p.id IN (SELECT provider_id FROM public.worker_provider_identities WHERE identity_type='domain'
    AND normalized_value=input.value->>'identity')) NULLS LAST,input.value->>'identity' LOOP
  domain:=item->>'identity';
  IF domain IS NULL OR domain<>lower(domain) OR domain !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$'
    OR length(domain)>253 OR coalesce(length(item->>'providerName'),0) NOT BETWEEN 1 AND 200
    OR coalesce(length(item->>'productName'),0) NOT BETWEEN 1 AND 200
    OR coalesce(length(item->>'docsUrl'),0) NOT BETWEEN 8 AND 2048 OR item->>'docsUrl' !~ '^https://'
    OR public.mahshar_acquisition_official_url(item->>'officialUrl',domain) IS DISTINCT FROM true
    OR coalesce(item->>'csvSha256','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(item->'legacyIds') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'legacyIds') NOT BETWEEN 1 AND 20
  THEN RAISE EXCEPTION 'mail_intake_identity_invalid'; END IF;
  SELECT array_agg(value::uuid) INTO legacy_ids FROM jsonb_array_elements_text(item->'legacyIds');
  IF (SELECT count(*) FROM public.discovered_apis d WHERE id=ANY(legacy_ids)
      AND public.mahshar_acquisition_official_url(d.repo_url,domain))<>cardinality(legacy_ids)
  THEN RAISE EXCEPTION 'mail_intake_legacy_mismatch'; END IF;
  SELECT jsonb_agg(repo_url ORDER BY id) INTO urls FROM public.discovered_apis WHERE id=ANY(legacy_ids);
  IF (SELECT count(*) FROM public.worker_providers p WHERE p.canonical_domain=domain OR p.id IN
    (SELECT provider_id FROM public.worker_provider_identities WHERE identity_type='domain' AND normalized_value=domain))>1
  THEN RAISE EXCEPTION 'mail_intake_identity_conflict'; END IF;
  SELECT p.* INTO matched FROM public.worker_providers p WHERE p.canonical_domain=domain OR p.id IN
   (SELECT provider_id FROM public.worker_provider_identities WHERE identity_type='domain' AND normalized_value=domain);
  IF matched.id IS NOT NULL AND NOT p_dry_run THEN
   SELECT * INTO matched FROM public.worker_providers WHERE id=matched.id FOR UPDATE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.discovered_apis d WHERE id=ANY(legacy_ids)
     AND (invited OR EXISTS(SELECT 1 FROM public.outreach_log o WHERE o.discovered_api_id=d.id))) THEN
   result:=result||jsonb_build_array(jsonb_build_object('identity',domain,'disposition','legacy_outreach_history'));
  ELSIF matched.id IS NOT NULL THEN
   -- Only a separately reviewed, changed documentation input can reopen exhausted intake.
   -- Identical imports never reset retries; qualified, finalized and manual-owned identities stay immutable.
   IF matched.mail_intake IS NOT NULL AND matched.status='active'
     AND item->>'docsUrl' IS DISTINCT FROM matched.mail_intake->>'docsUrl'
     AND item->'legacyIds'=matched.mail_intake->'legacyIds'
     AND public.mahshar_worker_mail_block_reason(matched.id) IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=matched.id)
     AND NOT EXISTS(SELECT 1 FROM public.worker_leads WHERE provider_id=matched.id
       AND qualification_status IN ('qualified','review_candidate','rejected')) THEN
    IF NOT p_dry_run THEN
     UPDATE public.worker_providers SET mail_intake=item||jsonb_build_object('sourceUrls',urls,'attempts',0,'state','ready',
       'inputHistory',coalesce(matched.mail_intake->'inputHistory','[]')||jsonb_build_array(jsonb_build_object(
         'docsUrl',matched.mail_intake->>'docsUrl','csvSha256',matched.mail_intake->>'csvSha256',
         'attempts',matched.mail_intake->'attempts','state',matched.mail_intake->>'state','replacedAt',clock_timestamp())))
      WHERE id=matched.id;
    END IF;
    result:=result||jsonb_build_array(jsonb_build_object('identity',domain,'providerId',matched.id,'disposition','legacy_input_changed'));
    CONTINUE;
   END IF;
   result:=result||jsonb_build_array(jsonb_build_object('identity',domain,'providerId',matched.id,
     'disposition',CASE WHEN matched.mail_intake IS NOT NULL THEN 'already_seeded' ELSE 'existing_worker_provider' END));
  ELSE
   IF NOT p_dry_run THEN
    INSERT INTO public.worker_providers(canonical_name,canonical_domain,mail_intake)
     VALUES(item->>'providerName',domain,item||jsonb_build_object('sourceUrls',urls,'attempts',0,'state','ready'))
     ON CONFLICT(canonical_domain) DO NOTHING RETURNING * INTO matched;
    IF NOT FOUND THEN
     SELECT * INTO matched FROM public.worker_providers WHERE canonical_domain=domain;
     result:=result||jsonb_build_array(jsonb_build_object('identity',domain,'providerId',matched.id,'disposition','existing_worker_provider'));
     CONTINUE;
    END IF;
    INSERT INTO public.worker_provider_identities(provider_id,identity_type,normalized_value,original_value)
     VALUES(matched.id,'domain',domain,item->>'officialUrl');
   END IF;
   result:=result||jsonb_build_array(jsonb_build_object('identity',domain,'providerId',matched.id,'disposition','legacy_first_pass'));
  END IF;
 END LOOP;
 RETURN result;
END $$;

-- Round-robin, bounded database-only recovery runs before every discovery chunk.
-- The cursor survives run and candidate cleanup. Expiry needs no trigger or fabricated evidence.
CREATE FUNCTION public.mahshar_worker_mail_recover(p_run_id uuid,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cursor_id uuid; before_id uuid; item record; total integer:=0;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'mail_recover_invalid'; END IF;
 SELECT mail_reconcile_cursor INTO cursor_id FROM public.worker_control WHERE id=1 AND desired_state='running';
 IF NOT FOUND THEN RETURN jsonb_build_object('processed',0,'cursorBefore',NULL,'cursorAfter',NULL); END IF;
 before_id:=cursor_id;
 PERFORM 1 FROM public.worker_runs WHERE id=p_run_id AND status='running' AND deadline_at>clock_timestamp();
 IF NOT FOUND THEN RETURN jsonb_build_object('processed',0,'cursorBefore',NULL,'cursorAfter',NULL); END IF;
 FOR item IN SELECT id FROM public.worker_providers WHERE cursor_id IS NULL OR id>cursor_id ORDER BY id LIMIT p_limit LOOP
  PERFORM 1 FROM public.worker_providers WHERE id=item.id FOR UPDATE SKIP LOCKED;
  IF FOUND THEN PERFORM public.mahshar_worker_mail_sync(item.id); END IF;
  cursor_id:=item.id; total:=total+1;
 END LOOP;
 -- Checkpoint only AFTER this RPC commits and releases all provider locks.
 -- Never acquire the control row in provider -> control order.
 RETURN jsonb_build_object('processed',total,'cursorBefore',before_id,
  'cursorAfter',CASE WHEN total<p_limit THEN NULL ELSE cursor_id END);
END $$;

CREATE FUNCTION public.mahshar_worker_mail_checkpoint_recovery(p_run_id uuid,p_before uuid,p_after uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.worker_control SET mail_reconcile_cursor=p_after WHERE id=1 AND desired_state='running'
  AND mail_reconcile_cursor IS NOT DISTINCT FROM p_before
  AND EXISTS(SELECT 1 FROM public.worker_runs WHERE id=p_run_id AND status='running' AND deadline_at>clock_timestamp());
 RETURN FOUND;
END $$;

-- Five contact and five legacy slots per logical batch, outside the unchanged fresh-discovery ordinal range.
-- Inputs come from permanent provider/lead/source records. Candidate cleanup cannot erase retry state.
CREATE FUNCTION public.mahshar_worker_mail_claim_recovery(p_run_id uuid,p_kind text,p_limit integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; p public.worker_providers; l public.worker_leads; c public.worker_candidates;
 meta jsonb; slot integer; ids uuid[]:='{}'; locked_providers uuid[]:='{}';
 docs text; source text; current_key text; due boolean; picked record;
BEGIN
 IF p_kind NOT IN ('legacy','contact') OR p_limit NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'mail_recovery_claim_invalid'; END IF;
 SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id AND status='running' AND deadline_at>clock_timestamp();
 IF NOT FOUND OR target.qualified_count>=target.qualified_target THEN RETURN '[]'; END IF;
 -- Serialize only claims for this batch/kind, without locking Stop's run/control
 -- rows. Contention is an empty slice; the next authorized chunk resumes it.
 IF NOT pg_try_advisory_xact_lock(hashtextextended(target.discovery_batch_id::text||':'||p_kind,1937006962)) THEN RETURN '[]'; END IF;
 slot:=CASE WHEN p_kind='contact' THEN 300 ELSE 305 END;
 -- Replays return the same retained work, including resumptions, without spending another attempt.
 FOR c IN SELECT * FROM public.worker_candidates WHERE discovery_batch_id=target.discovery_batch_id
   AND mail_recovery_kind=p_kind ORDER BY ordinal LOOP
  IF p_kind='legacy' THEN SELECT mail_intake INTO meta FROM public.worker_providers WHERE id=c.provider_id;
  ELSE SELECT mail_refresh INTO meta FROM public.worker_leads WHERE id=c.lead_id; END IF;
  IF meta->>'state'='active' AND meta->>'candidateId'=c.id::text THEN ids:=array_append(ids,c.id); END IF;
  slot:=greatest(slot,c.ordinal+1);
 END LOOP;
 IF slot>=(CASE WHEN p_kind='contact' THEN 300+p_limit ELSE 305+p_limit END) THEN
  RETURN (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.ordinal),'[]') FROM public.worker_candidates x WHERE id=ANY(ids));
 END IF;
 -- Each index range produces at most 25 due identities before any history
 -- checks or row locks. Busy identities are skipped, never waited on.
 FOR picked IN
  (SELECT id AS provider_id,NULL::uuid AS lead_id FROM public.worker_providers
   WHERE p_kind='legacy' AND mail_intake_due_at<=statement_timestamp()
   ORDER BY mail_intake_due_at,id LIMIT 25)
  UNION ALL
  (SELECT provider_id,id AS lead_id FROM public.worker_leads
   WHERE p_kind='contact' AND mail_refresh_due_at<=statement_timestamp()
   ORDER BY mail_refresh_due_at,provider_id,id LIMIT 25)
 LOOP
  EXIT WHEN slot>=(CASE WHEN p_kind='contact' THEN 300+p_limit ELSE 305+p_limit END);
  IF picked.provider_id=ANY(locked_providers) THEN CONTINUE; END IF;
  EXIT WHEN cardinality(locked_providers)>=p_limit;
  EXIT WHEN NOT EXISTS(SELECT 1 FROM public.worker_control WHERE id=1 AND desired_state='running')
   OR NOT EXISTS(SELECT 1 FROM public.worker_runs WHERE id=p_run_id AND status='running' AND deadline_at>clock_timestamp());
  SELECT * INTO p FROM public.worker_providers WHERE id=picked.provider_id AND status='active' FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE; END IF;
  locked_providers:=array_append(locked_providers,p.id);
  IF public.mahshar_worker_mail_block_reason(p.id) IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id=p.id AND status<>'pending') THEN
   PERFORM public.mahshar_worker_mail_schedule(p.id); CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.worker_candidates WHERE discovery_batch_id=target.discovery_batch_id
      AND provider_id=p.id AND mail_recovery_kind=p_kind) THEN CONTINUE; END IF;
  l:=NULL;
  IF p_kind='legacy' THEN
   meta:=p.mail_intake;
   IF EXISTS(SELECT 1 FROM public.worker_leads WHERE provider_id=p.id AND qualification_status IN ('qualified','review_candidate','rejected'))
   THEN CONTINUE; END IF;
   IF meta->>'state' IN ('complete','exhausted') OR coalesce((meta->>'attempts')::integer,0)>=3
     OR (meta->>'retryAfter')::timestamptz>clock_timestamp() THEN CONTINUE; END IF;
   SELECT * INTO l FROM public.worker_leads WHERE provider_id=p.id ORDER BY created_at,id LIMIT 1;
   docs:=meta->>'docsUrl'; source:=meta->'sourceUrls'->>0;
  ELSE
   SELECT lead.* INTO l FROM public.worker_leads lead JOIN public.worker_products x ON x.id=lead.product_id
    WHERE lead.provider_id=p.id AND lead.id=picked.lead_id AND lead.qualification_status IN ('qualified','review_candidate')
     AND lead.status IN ('discovered','qualified') AND x.status<>'rejected'
    ORDER BY CASE lead.qualification_status WHEN 'qualified' THEN 0 ELSE 1 END,lead.fit_score DESC NULLS LAST,lead.id LIMIT 1;
   IF NOT FOUND THEN CONTINUE; END IF;
   meta:=coalesce(l.mail_refresh,'{}');
   SELECT s.url INTO docs FROM public.worker_sources s WHERE s.lead_id=l.id AND s.source_type='website'
     AND s.source_role IN ('official_docs','official_site')
     AND public.mahshar_acquisition_official_url(s.url,p.canonical_domain) ORDER BY s.checked_at DESC LIMIT 1;
   source:=coalesce(docs,'https://'||p.canonical_domain||'/');
   SELECT max(ct.verified_at)::text INTO current_key FROM public.worker_contacts ct WHERE ct.provider_id=p.id AND ct.lead_id=l.id;
   due:=NOT l.email_ready OR NOT EXISTS(SELECT 1 FROM public.worker_contacts ct WHERE ct.lead_id=l.id
      AND ct.contact_type='email' AND ct.verification_status='verified' AND ct.email_ready
      AND public.mahshar_worker_mail_business_email(ct.value,ct.purpose)
      AND ct.verified_at BETWEEN clock_timestamp()-interval '30 days' AND clock_timestamp()+interval '5 minutes')
    OR NOT EXISTS(SELECT 1 FROM public.worker_sources s WHERE s.lead_id=l.id AND s.source_type='website'
      AND s.source_role IN ('official_site','official_docs') AND public.mahshar_acquisition_official_url(s.url,p.canonical_domain)
      AND s.checked_at BETWEEN clock_timestamp()-interval '30 days' AND clock_timestamp()+interval '5 minutes');
   IF NOT due THEN CONTINUE; END IF;
   -- New independently saved evidence opens a new bounded recovery cycle.
   IF meta->>'evidenceKey' IS DISTINCT FROM current_key OR (meta->>'lastReason'='contact_enriched'
      AND l.email_ready AND (meta->>'completedAt')::timestamptz<=clock_timestamp()-interval '30 days') THEN meta:=jsonb_build_object('attempts',0,'evidenceKey',current_key); END IF;
   IF coalesce((meta->>'attempts')::integer,0)>=3 OR (meta->>'retryAfter')::timestamptz>clock_timestamp() THEN CONTINUE; END IF;
   PERFORM 1 FROM public.worker_products WHERE id=l.product_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   PERFORM 1 FROM public.worker_leads WHERE id=l.id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
  END IF;
  INSERT INTO public.worker_candidates(discovery_batch_id,ordinal,mail_recovery_kind,source_type,source_url,discovered_name,
    discovered_domain,discovered_product,discovered_docs_url,normalized_domain,provider_id,product_id,lead_id,
    processing_lease_id,processing_lease_expires_at,source_summary)
   VALUES(target.discovery_batch_id,slot,p_kind,'api_directory',source,p.canonical_name,p.canonical_domain,
    coalesce(p.mail_intake->>'productName',(SELECT display_name FROM public.worker_products WHERE id=l.product_id),p.canonical_name||' API'),
    coalesce(docs,'https://'||p.canonical_domain||'/'),p.canonical_domain,p.id,l.product_id,l.id,
    gen_random_uuid(),clock_timestamp()+interval '5 minutes','Retained research input; API qualification and official contact evidence must be independently verified.')
   RETURNING * INTO c;
  meta:=meta||jsonb_build_object('attempts',coalesce((meta->>'attempts')::integer,0)+1,'state','active',
    'candidateId',c.id,'retryAfter',clock_timestamp()+interval '1 hour');
  IF p_kind='legacy' THEN UPDATE public.worker_providers SET mail_intake=meta WHERE id=p.id;
  ELSE UPDATE public.worker_leads SET mail_refresh=meta WHERE id=l.id; END IF;
  ids:=array_append(ids,c.id); slot:=slot+1;
 END LOOP;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.ordinal),'[]') FROM public.worker_candidates x WHERE id=ANY(ids));
END $$;

CREATE FUNCTION public.mahshar_worker_mail_finish_recovery(p_candidate_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.worker_candidates; meta jsonb; paused boolean; complete boolean;
BEGIN
 SELECT * INTO c FROM public.worker_candidates WHERE id=p_candidate_id;
 IF NOT FOUND OR c.mail_recovery_kind IS NULL THEN RETURN; END IF;
 PERFORM 1 FROM public.worker_providers WHERE id=c.provider_id FOR UPDATE;
 IF c.mail_recovery_kind='legacy' THEN SELECT mail_intake INTO meta FROM public.worker_providers WHERE id=c.provider_id;
 ELSE SELECT mail_refresh INTO meta FROM public.worker_leads WHERE id=c.lead_id FOR UPDATE; END IF;
 IF meta->>'candidateId' IS DISTINCT FROM c.id::text OR meta->>'state'<>'active' THEN RETURN; END IF;
 IF c.mail_recovery_kind='contact' AND p_reason='contact_enriched' AND NOT EXISTS(
   SELECT 1 FROM public.worker_contacts x JOIN public.worker_leads ready_lead ON ready_lead.id=x.lead_id
   WHERE x.lead_id=c.lead_id AND ready_lead.email_ready AND ready_lead.contactability_status='verified_email' AND x.contact_type='email' AND x.verification_status='verified'
    AND x.email_ready AND public.mahshar_worker_mail_business_email(x.value,x.purpose)
    AND x.verified_at>=clock_timestamp()-interval '30 days') THEN p_reason:='no_email'; END IF;
 paused:=p_reason ~ '(budget_exhausted|claim_replayed|run_budget_exhausted|acquisition_stopped)';
 complete:=p_reason IN ('qualified','review_candidate','fit_below_threshold','contact_enriched','existing_human_state')
   OR (c.mail_recovery_kind='legacy' AND c.status IN ('persisted','filtered','blocked','duplicate'));
 meta:=meta||jsonb_build_object('state',CASE WHEN complete THEN 'complete' WHEN (meta->>'attempts')::integer>=3 AND NOT paused THEN 'exhausted' ELSE 'ready' END,
   'attempts',greatest(0,(meta->>'attempts')::integer-CASE WHEN paused THEN 1 ELSE 0 END),
   'lastReason',left(p_reason,80),'completedAt',clock_timestamp(),'retryAfter',clock_timestamp()+CASE WHEN paused THEN interval '0 seconds' ELSE interval '1 hour' END);
 -- Track this attempt's observations so its own writes cannot reset the retry cap.
 IF c.mail_recovery_kind='legacy' THEN UPDATE public.worker_providers SET mail_intake=meta WHERE id=c.provider_id;
 ELSE
  meta:=meta||jsonb_build_object('evidenceKey',(SELECT max(verified_at)::text FROM public.worker_contacts WHERE lead_id=c.lead_id));
  UPDATE public.worker_leads SET mail_refresh=meta WHERE id=c.lead_id;
 END IF;
 PERFORM public.mahshar_worker_mail_sync(c.provider_id);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_mail_business_email(text,text),
 public.mahshar_worker_mail_block_reason(uuid),public.mahshar_worker_mail_candidate(uuid),
 public.mahshar_worker_mail_sync(uuid),public.mahshar_worker_mail_refresh_trigger(),
 public.mahshar_worker_mail_reservation_guard(),public.mahshar_worker_mail_mark_sent(uuid,text),
 public.mahshar_worker_mail_list(uuid,integer),public.mahshar_worker_mail_reconcile(uuid,integer,boolean,uuid[]),
 public.mahshar_worker_mail_discovery_state(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_mail_mark_sent(uuid,text),
 public.mahshar_worker_mail_list(uuid,integer),public.mahshar_worker_mail_reconcile(uuid,integer,boolean,uuid[]),
 public.mahshar_worker_mail_discovery_state(text[]) TO service_role;

REVOKE ALL ON FUNCTION public.mahshar_worker_mail_seed_legacy(jsonb,boolean),
 public.mahshar_worker_mail_checkpoint_recovery(uuid,uuid,uuid),
 public.mahshar_worker_mail_recover(uuid,integer),public.mahshar_worker_mail_claim_recovery(uuid,text,integer),
 public.mahshar_worker_mail_finish_recovery(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_mail_seed_legacy(jsonb,boolean),
 public.mahshar_worker_mail_checkpoint_recovery(uuid,uuid,uuid),
 public.mahshar_worker_mail_recover(uuid,integer),public.mahshar_worker_mail_claim_recovery(uuid,text,integer),
 public.mahshar_worker_mail_finish_recovery(uuid,text) TO service_role;

-- Preserve native control/run ordering; acquire a provider before its leads.
-- Only the two claimants previously selected/locked a lead first. No global
-- gate, Stop rewrite, inbound rewrite or operational-table statement trigger.
DO $mail_provider_order$
DECLARE signature text; definition text; needle text; prefix text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.mahshar_acquisition_claim_next(uuid,uuid)',
  'public.mahshar_acquisition_claim_draft(uuid,uuid)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  needle:='LIMIT 1 FOR UPDATE OF l SKIP LOCKED;';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'mail_claim_lock_baseline_mismatch: %',signature; END IF;
  definition:=replace(definition,needle,'LIMIT 1 FOR UPDATE OF p SKIP LOCKED;');
  needle:='INSERT INTO public.admin_acquisition_attempts';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'mail_claim_insert_baseline_mismatch: %',signature; END IF;
  EXECUTE replace(definition,needle,E'PERFORM 1 FROM public.worker_leads WHERE id=picked.lead_id FOR UPDATE SKIP LOCKED;\n  IF NOT FOUND THEN RETURN NULL; END IF;\n  INSERT INTO public.admin_acquisition_attempts');
 END LOOP;
 -- Entity-editing Outreach routines share provider -> thread -> message order.
 -- Incoming events and finish_send do not need a provider and stay independent.
 FOREACH signature IN ARRAY ARRAY['public.mahshar_admin_outreach_edit_draft(uuid,text,text)',
  'public.mahshar_admin_outreach_approve_draft(uuid,text)',
  'public.mahshar_admin_outreach_mark_sent(uuid,text)',
  'public.mahshar_admin_outreach_edit_reply_draft(uuid,text,text)',
  'public.mahshar_admin_outreach_mark_reply_sent(uuid,text)',
  'public.mahshar_admin_outreach_reserve_send(uuid)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  prefix:=E'BEGIN\n -- Provider/thread locks precede message/lead locks.\n PERFORM 1 FROM public.worker_providers WHERE id=(SELECT t.provider_id FROM public.admin_outreach_threads t JOIN public.admin_outreach_messages m ON m.thread_id=t.id WHERE m.id=p_message_id) FOR UPDATE;\n PERFORM 1 FROM public.admin_outreach_threads WHERE id=(SELECT thread_id FROM public.admin_outreach_messages WHERE id=p_message_id) FOR UPDATE;\n';
  EXECUTE regexp_replace(definition,'\mBEGIN\M',prefix);
 END LOOP;
 signature:='public.mahshar_admin_outreach_set_status(uuid,uuid,text)';
 definition:=pg_get_functiondef(signature::regprocedure);
 EXECUTE regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n PERFORM 1 FROM public.worker_providers WHERE id=p_provider_id FOR UPDATE;\n');
 -- Recording a reserved transport result must not acquire a provider or wait on
 -- qualification. Thread first also agrees with entity-editing RPCs above.
 signature:='public.mahshar_admin_outreach_finish_send(uuid,text)';
 definition:=pg_get_functiondef(signature::regprocedure);
 needle:='SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'mail_finish_lock_baseline_mismatch'; END IF;
 EXECUTE replace(definition,needle,E'PERFORM 1 FROM public.admin_outreach_threads WHERE id=(SELECT thread_id FROM public.admin_outreach_messages WHERE id=p_message_id) FOR UPDATE;\n  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;');
END $mail_provider_order$;

-- Function settings are exposed by PostgREST before RPC execution. Direct SQL
-- callers must also set a statement timeout before invoking an RPC. Lock timeout
-- applies to each wait; all automatic synchronization uses SKIP LOCKED first.
DO $mail_timeouts$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.mahshar_worker_mail_mark_sent(uuid,text)',
  'public.mahshar_worker_mail_list(uuid,integer)',
  'public.mahshar_worker_mail_reconcile(uuid,integer,boolean,uuid[])',
  'public.mahshar_worker_mail_discovery_state(text[])',
  'public.mahshar_worker_mail_seed_legacy(jsonb,boolean)',
  'public.mahshar_worker_mail_recover(uuid,integer)',
  'public.mahshar_worker_mail_checkpoint_recovery(uuid,uuid,uuid)',
  'public.mahshar_worker_mail_claim_recovery(uuid,text,integer)',
  'public.mahshar_worker_mail_finish_recovery(uuid,text)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET lock_timeout TO %L',signature,'250ms');
  EXECUTE format('ALTER FUNCTION %s SET statement_timeout TO %L',signature,'2s');
 END LOOP;
END $mail_timeouts$;
