-- No history is imported, normalized in place, merged or deleted. Existing collisions require review.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE status IN ('pending','manual_sent')
  GROUP BY lower(btrim(email_address)) HAVING count(*)>1)
 THEN RAISE EXCEPTION 'worker_mail_existing_email_collision_requires_review'; END IF;
END $$;
CREATE UNIQUE INDEX worker_mail_unique_recipient ON public.admin_worker_mail_registry(lower(btrim(email_address)))
 WHERE status IN ('pending','manual_sent');
CREATE INDEX worker_contact_email_identity ON public.worker_contacts(lower(btrim(value)),provider_id)
 WHERE contact_type='email' AND verification_status='verified';
CREATE INDEX worker_outreach_email_history ON public.admin_outreach_messages(lower(btrim(recipient_email))) WHERE direction='outbound';
CREATE INDEX worker_acquisition_email_history ON public.admin_acquisition_attempts(lower(btrim(recipient_email)));
CREATE INDEX worker_legacy_email_history ON public.outreach_log(lower(btrim(email)));
CREATE INDEX worker_legacy_invited_email ON public.discovered_apis(lower(btrim(owner_email))) WHERE invited;

CREATE FUNCTION public.mahshar_worker_mail_email_reason(p_provider_id uuid,p_email text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE recipient_key text:=lower(btrim(p_email));
BEGIN
 IF EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE lower(btrim(email_address))=recipient_key AND status='manual_sent')
  OR EXISTS(SELECT 1 FROM public.worker_contacts c JOIN public.worker_leads l ON l.provider_id=c.provider_id
    WHERE c.contact_type='email' AND c.verification_status='verified' AND lower(btrim(c.value))=recipient_key
      AND l.status IN ('contacted','replied','interested','listed','closed'))
  OR EXISTS(SELECT 1 FROM public.admin_outreach_messages WHERE direction='outbound' AND lower(btrim(recipient_email))=recipient_key
    AND (status='sent' OR send_reserved_at IS NOT NULL OR send_uncertain_at IS NOT NULL
      OR acquisition_dispatch_started_at IS NOT NULL OR provider_message_id IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.admin_acquisition_attempts WHERE lower(btrim(recipient_email))=recipient_key
    AND status<>'simulated_sent' AND (status IN ('reserved','uncertain') OR reserved_at IS NOT NULL OR dispatched_at IS NOT NULL OR provider_message_id IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.outreach_log WHERE lower(btrim(outreach_log.email))=recipient_key)
  OR EXISTS(SELECT 1 FROM public.discovered_apis WHERE invited AND lower(btrim(owner_email))=recipient_key)
 THEN RETURN 'email_contact_history'; END IF;
 IF EXISTS(SELECT 1 FROM public.admin_worker_mail_registry WHERE provider_id<>p_provider_id AND lower(btrim(email_address))=recipient_key AND status='pending')
  OR EXISTS(SELECT 1 FROM public.worker_contacts WHERE provider_id<>p_provider_id AND contact_type='email'
    AND verification_status='verified' AND lower(btrim(value))=recipient_key)
 THEN RETURN 'email_identity_conflict'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_worker_mail_email_reason(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_mail_email_reason(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.mahshar_worker_mail_candidate(p_provider_id uuid)
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
 reason:=public.mahshar_worker_mail_email_reason(p_provider_id,picked.value);
 IF reason IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'reason',reason); END IF;
 variables:=public.mahshar_acquisition_template_context(picked.lead_id)->'templateVariables';
 RETURN jsonb_build_object('eligible',true,'providerId',provider.id,'identityKey',provider.canonical_domain,
  'leadId',picked.lead_id,'contactId',picked.contact_id,'email',picked.value,
  'sourceUrl',picked.source_url,'verifiedAt',picked.verified_at,
  'apiName',coalesce(variables->>'product',provider.canonical_name));
END $$;

-- Never wait for a second provider while holding the current provider's row lock.
-- Busy claims are skipped without a terminal row; ordinary reconciliation can retry them.
CREATE FUNCTION public.mahshar_worker_mail_guard_recipient()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE reason text;
BEGIN
 IF NEW.status='pending' THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('worker-mail-email:'||lower(btrim(NEW.email_address)),19370002)) THEN RETURN NULL; END IF;
  reason:=public.mahshar_worker_mail_email_reason(NEW.provider_id,NEW.email_address);
  IF reason IS NOT NULL THEN NEW.status:='excluded'; NEW.reason_code:=reason; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_worker_mail_guard_recipient() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER worker_mail_recipient_guard BEFORE INSERT OR UPDATE OF email_address,status ON public.admin_worker_mail_registry
 FOR EACH ROW EXECUTE FUNCTION public.mahshar_worker_mail_guard_recipient();

-- The application probes this before reconciliation, candidate writes or external requests.
CREATE FUNCTION public.mahshar_worker_discovery_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='worker_mail_unique_recipient' AND i.indisvalid AND i.indisunique)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.admin_worker_mail_registry'::regclass
   AND tgname='worker_mail_recipient_guard' AND tgenabled='O')
  AND pg_catalog.to_regprocedure('public.mahshar_worker_claim_discovery_request(uuid,text,uuid)') IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.mahshar_worker_discovery_ready() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_discovery_ready() TO service_role;
