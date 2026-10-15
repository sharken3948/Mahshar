-- Preparation only: no existing rows, flags, drafts, controls or authorizations are activated.
CREATE TABLE public.admin_acquisition_delivery_control (
  id integer PRIMARY KEY CHECK (id=1),
  enabled boolean NOT NULL DEFAULT false,
  sender_email text NOT NULL DEFAULT 'support@mahshar.xyz' CHECK (sender_email='support@mahshar.xyz'),
  template_version text NOT NULL DEFAULT 'mahshar-provider-invitation-v2' CHECK (template_version='mahshar-provider-invitation-v2'),
  sender_verified_at timestamptz,
  policy_reviewed_at timestamptz,
  policy_reference text CHECK (length(btrim(policy_reference)) BETWEEN 8 AND 500),
  reviewed_by text CHECK (reviewed_by ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz,
  CHECK (NOT enabled OR (sender_verified_at IS NOT NULL AND policy_reviewed_at IS NOT NULL
    AND policy_reference IS NOT NULL AND reviewed_by IS NOT NULL AND expires_at IS NOT NULL
    AND expires_at>policy_reviewed_at AND expires_at<=policy_reviewed_at+interval '30 days'))
);
INSERT INTO public.admin_acquisition_delivery_control(id) VALUES(1);
ALTER TABLE public.admin_acquisition_delivery_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_acquisition_delivery_control FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.admin_acquisition_delivery_control TO service_role;

ALTER TABLE public.admin_acquisition_eligibility
  DROP CONSTRAINT admin_acquisition_eligibility_channel_check,
  ADD CONSTRAINT admin_acquisition_eligibility_channel_check CHECK (channel IN ('mock','brevo')),
  ADD COLUMN permission_basis text,
  ADD COLUMN permission_reference text,
  ADD COLUMN reviewed_by text,
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT admin_acquisition_brevo_permission CHECK (channel='mock' OR (
    permission_basis IS NOT NULL AND permission_basis IN ('explicit_consent','requested_invitation')
    AND permission_reference IS NOT NULL AND length(btrim(permission_reference)) BETWEEN 8 AND 500
    AND reviewed_by IS NOT NULL AND reviewed_by ~ '^0x[0-9a-f]{40}$'
    AND reviewed_at IS NOT NULL AND expires_at>reviewed_at AND expires_at<=reviewed_at+interval '30 days'));

ALTER TABLE public.admin_outreach_messages
  ADD COLUMN acquisition_attempt_id uuid UNIQUE REFERENCES public.admin_acquisition_attempts(id),
  ADD COLUMN acquisition_run_id uuid REFERENCES public.worker_runs(id),
  ADD COLUMN acquisition_epoch uuid,
  ADD COLUMN acquisition_dispatch_started_at timestamptz,
  ADD COLUMN acquisition_failure_at timestamptz,
  ADD COLUMN acquisition_failure_code text,
  ADD CONSTRAINT admin_outreach_acquisition_link CHECK (
    (acquisition_attempt_id IS NULL AND acquisition_run_id IS NULL AND acquisition_epoch IS NULL
      AND acquisition_dispatch_started_at IS NULL AND acquisition_failure_at IS NULL AND acquisition_failure_code IS NULL)
    OR (acquisition_attempt_id IS NOT NULL AND acquisition_run_id IS NOT NULL AND acquisition_epoch IS NOT NULL
      AND direction='outbound' AND reply_to_message_id IS NULL AND sender_email='support@mahshar.xyz'
      AND (acquisition_dispatch_started_at IS NULL OR send_reserved_at IS NOT NULL)
      AND ((acquisition_failure_at IS NULL AND acquisition_failure_code IS NULL)
        OR (acquisition_failure_at IS NOT NULL AND send_reserved_at IS NOT NULL AND acquisition_failure_code IS NOT NULL
          AND acquisition_failure_code ~ '^(dispatch_blocked|brevo_(400|401|402|403|404|405|413|415|422|429)_[a-z_]{1,40})$'))));

CREATE FUNCTION public.mahshar_acquisition_immutable_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.acquisition_attempt_id IS NOT NULL THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'acquisition_delivery_immutable'; END IF;
    IF (NEW.thread_id,NEW.direction,NEW.recipient_email,NEW.sender_email,NEW.subject,NEW.body,
      NEW.reply_to_message_id,NEW.approved_at,NEW.approved_by,NEW.acquisition_attempt_id,NEW.acquisition_run_id,NEW.acquisition_epoch)
      IS DISTINCT FROM (OLD.thread_id,OLD.direction,OLD.recipient_email,OLD.sender_email,OLD.subject,OLD.body,
      OLD.reply_to_message_id,OLD.approved_at,OLD.approved_by,OLD.acquisition_attempt_id,OLD.acquisition_run_id,OLD.acquisition_epoch)
      OR (OLD.acquisition_dispatch_started_at IS NOT NULL AND NEW.acquisition_dispatch_started_at IS DISTINCT FROM OLD.acquisition_dispatch_started_at)
      OR (OLD.send_reserved_at IS NOT NULL AND NEW.send_reserved_at IS DISTINCT FROM OLD.send_reserved_at)
      OR (OLD.acquisition_failure_at IS NOT NULL AND (NEW.acquisition_failure_at,NEW.acquisition_failure_code)
        IS DISTINCT FROM (OLD.acquisition_failure_at,OLD.acquisition_failure_code))
      THEN RAISE EXCEPTION 'acquisition_delivery_immutable'; END IF;
    IF NEW.status='sent' AND (NEW.acquisition_dispatch_started_at IS NULL OR NEW.acquisition_failure_at IS NOT NULL
      OR NEW.provider_message_id IS NULL OR length(btrim(NEW.provider_message_id))=0
      OR NEW.provider_message_id ~* '^[[:space:]]*<?simulated:')
      THEN RAISE EXCEPTION 'acquisition_delivery_invalid_receipt'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_acquisition_delivery_immutable BEFORE UPDATE OR DELETE ON public.admin_outreach_messages
  FOR EACH ROW EXECUTE FUNCTION public.mahshar_acquisition_immutable_delivery();

CREATE FUNCTION public.mahshar_acquisition_brevo_eligible(p_attempt_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts; context jsonb; variables jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.admin_acquisition_delivery_control WHERE id=1 AND enabled
    AND sender_verified_at<=statement_timestamp() AND policy_reviewed_at<=statement_timestamp()
    AND expires_at>statement_timestamp()) THEN RETURN false; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=p_attempt_id AND draft_only AND status='prepared'
    AND draft_generator='template' AND draft_template_version='mahshar-provider-invitation-v2'
    AND draft_prepared_at IS NOT NULL AND draft_variables IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  context:=public.mahshar_acquisition_template_context(item.lead_id); variables:=context->'templateVariables';
  -- Draft context excludes every Outreach thread. A linked reserved delivery has
  -- its own thread, so recheck the same suppression/qualification predicates here.
  IF context IS NULL OR context->>'identityVerified' IS DISTINCT FROM 'true' OR context->>'contactVerified' IS DISTINCT FROM 'true'
    OR NOT EXISTS(SELECT 1 FROM public.worker_leads l JOIN public.worker_providers p ON p.id=l.provider_id
      WHERE l.id=item.lead_id AND l.provider_id=item.provider_id AND l.qualification_status IN ('qualified','review_candidate')
      AND l.status NOT IN ('rejected','do_not_contact','closed') AND p.status NOT IN ('rejected','do_not_contact')
      AND NOT EXISTS(SELECT 1 FROM public.worker_products WHERE id=l.product_id AND status='rejected')
      AND NOT EXISTS(SELECT 1 FROM public.worker_decisions WHERE provider_id=p.id AND decision IN ('rejected','do_not_contact')))
    OR NOT EXISTS(SELECT 1 FROM public.worker_leads l JOIN public.admin_acquisition_eligibility e
      ON e.provider_id=l.provider_id AND e.recipient_email=l.preferred_email
      WHERE l.id=item.lead_id AND l.preferred_email=item.recipient_email AND e.channel='brevo'
      AND e.reviewed_at<=statement_timestamp() AND e.expires_at>statement_timestamp()) THEN RETURN false; END IF;
  RETURN coalesce(item.subject='Invitation to list your API on Mahshar' AND item.body IN (
    public.mahshar_invitation_render_v2(variables->>'company',variables->>'product')->>'body',
    public.mahshar_invitation_render_v2(variables->>'company',NULL)->>'body',
    public.mahshar_invitation_render_v2(NULL,variables->>'product')->>'body',
    public.mahshar_invitation_render_v2(NULL,NULL)->>'body'),false);
END $$;

CREATE FUNCTION public.mahshar_acquisition_assert_brevo(p_message_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages; item public.admin_acquisition_attempts;
BEGIN
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id;
  IF message.acquisition_attempt_id IS NULL THEN RAISE EXCEPTION 'acquisition_delivery_missing'; END IF;
  SELECT * INTO item FROM public.admin_acquisition_attempts WHERE id=message.acquisition_attempt_id;
  IF NOT public.mahshar_acquisition_brevo_eligible(item.id) OR message.acquisition_failure_at IS NOT NULL
    OR (message.recipient_email,message.subject,message.body) IS DISTINCT FROM (item.recipient_email,item.subject,item.body)
    OR NOT EXISTS(SELECT 1 FROM public.admin_outreach_threads WHERE id=message.thread_id
      AND provider_id=item.provider_id AND lead_id=item.lead_id AND status='draft' AND last_reply_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.admin_outreach_messages other JOIN public.admin_outreach_threads t ON t.id=other.thread_id
      WHERE t.provider_id=item.provider_id AND other.id<>message.id AND other.direction='outbound'
      AND other.reply_to_message_id IS NULL AND (other.status='sent' OR other.send_reserved_at IS NOT NULL))
    OR NOT EXISTS(SELECT 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running'
      AND operating_mode='continuous' AND epoch=message.acquisition_epoch)
    OR NOT EXISTS(SELECT 1 FROM public.worker_control WHERE id=1 AND desired_state='running')
    OR NOT EXISTS(SELECT 1 FROM public.worker_runs WHERE id=message.acquisition_run_id AND status='running'
      AND deadline_at>statement_timestamp()) THEN RAISE EXCEPTION 'acquisition_delivery_not_authorized'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.mahshar_acquisition_daily_reserved()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT (SELECT count(*) FROM public.admin_acquisition_attempts
    WHERE status IN ('reserved','simulated_sent','uncertain')
    AND reserved_at>=date_trunc('day',statement_timestamp(),'UTC')
    AND reserved_at<date_trunc('day',statement_timestamp(),'UTC')+interval '1 day')
  + (SELECT count(*) FROM public.admin_outreach_messages WHERE acquisition_attempt_id IS NOT NULL
    AND send_reserved_at>=date_trunc('day',statement_timestamp(),'UTC')
    AND send_reserved_at<date_trunc('day',statement_timestamp(),'UTC')+interval '1 day')
$$;

CREATE FUNCTION public.mahshar_acquisition_reserve_brevo(p_run_id uuid,p_epoch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.admin_acquisition_attempts; permission public.admin_acquisition_eligibility;
  thread_id uuid; message_id uuid;
BEGIN
  PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 AND desired_state='running'
    AND operating_mode='continuous' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_control WHERE id=1 AND desired_state='running' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_runs WHERE id=p_run_id AND status='running' AND deadline_at>clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT a.* INTO item FROM public.admin_acquisition_attempts a
    WHERE public.mahshar_acquisition_brevo_eligible(a.id)
    AND NOT EXISTS(SELECT 1 FROM public.admin_outreach_threads t WHERE t.provider_id=a.provider_id)
    AND NOT EXISTS(SELECT 1 FROM public.admin_outreach_messages m WHERE m.acquisition_attempt_id=a.id)
    ORDER BY a.draft_prepared_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.worker_providers WHERE id=item.provider_id FOR UPDATE;
  PERFORM 1 FROM public.worker_leads WHERE id=item.lead_id FOR UPDATE;
  IF NOT public.mahshar_acquisition_brevo_eligible(item.id)
    OR EXISTS(SELECT 1 FROM public.admin_outreach_threads WHERE provider_id=item.provider_id) THEN RETURN NULL; END IF;
  IF public.mahshar_acquisition_daily_reserved()>=25 THEN RAISE EXCEPTION 'acquisition_daily_send_limit'; END IF;
  SELECT * INTO permission FROM public.admin_acquisition_eligibility WHERE provider_id=item.provider_id
    AND recipient_email=item.recipient_email AND channel='brevo' AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.admin_outreach_threads(lead_id,provider_id,status) VALUES(item.lead_id,item.provider_id,'draft') RETURNING id INTO thread_id;
  INSERT INTO public.admin_outreach_messages(thread_id,status,recipient_email,subject,body,approved_by,approved_at,
    acquisition_attempt_id,acquisition_run_id,acquisition_epoch)
    VALUES(thread_id,'ready_to_send',item.recipient_email,item.subject,item.body,permission.reviewed_by,permission.reviewed_at,
      item.id,p_run_id,p_epoch) RETURNING id INTO message_id;
  -- Reuse the existing single-invitation reservation, DNC/contact checks and Product Name Integrity V2.
  PERFORM public.mahshar_admin_outreach_reserve_send(message_id);
  RETURN jsonb_build_object('id',message_id,'recipient',item.recipient_email,'subject',item.subject,'body',item.body);
END $$;

CREATE FUNCTION public.mahshar_admin_outreach_begin_transport(p_message_id uuid,p_recipient text,p_subject text,p_body text,
  p_acquisition_enabled boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages;
BEGIN
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id;
  IF message.acquisition_attempt_id IS NOT NULL THEN
    IF p_acquisition_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'acquisition_delivery_disabled'; END IF;
    PERFORM 1 FROM public.admin_acquisition_control WHERE id=1 FOR UPDATE;
    SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
    IF message.acquisition_dispatch_started_at IS NOT NULL THEN RETURN false; END IF;
    PERFORM public.mahshar_acquisition_assert_brevo(p_message_id);
  END IF;
  PERFORM public.mahshar_admin_outreach_assert_invitation_integrity(p_message_id,p_recipient,p_subject,p_body);
  IF message.acquisition_attempt_id IS NOT NULL THEN
    UPDATE public.admin_outreach_messages SET acquisition_dispatch_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_message_id;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.mahshar_acquisition_reject_brevo(p_message_id uuid,p_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages;
BEGIN
  IF p_code IS NULL OR p_code !~ '^(dispatch_blocked|brevo_(400|401|402|403|404|405|413|415|422|429)_[a-z_]{1,40})$'
    THEN RAISE EXCEPTION 'acquisition_rejection_invalid'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.acquisition_attempt_id IS NULL OR message.send_reserved_at IS NULL OR message.status='sent'
    OR message.send_uncertain_at IS NOT NULL THEN RAISE EXCEPTION 'acquisition_rejection_invalid'; END IF;
  IF message.acquisition_failure_at IS NOT NULL THEN
    IF message.acquisition_failure_code IS DISTINCT FROM p_code THEN RAISE EXCEPTION 'acquisition_rejection_conflict'; END IF;
    RETURN true;
  END IF;
  UPDATE public.admin_outreach_messages SET acquisition_failure_at=clock_timestamp(),acquisition_failure_code=p_code,
    updated_at=clock_timestamp() WHERE id=p_message_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_acquisition_immutable_delivery(),public.mahshar_acquisition_brevo_eligible(uuid),
  public.mahshar_acquisition_assert_brevo(uuid),public.mahshar_acquisition_daily_reserved() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_reserve_brevo(uuid,uuid),
  public.mahshar_admin_outreach_begin_transport(uuid,text,text,text,boolean),public.mahshar_acquisition_reject_brevo(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_reserve_brevo(uuid,uuid),
  public.mahshar_admin_outreach_begin_transport(uuid,text,text,text,boolean),public.mahshar_acquisition_reject_brevo(uuid,text)
  TO service_role;

-- Keep the existing shared daily ceiling of 25, counting real and mock reservations.
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
  IF public.mahshar_acquisition_daily_reserved()>=25
    THEN RAISE EXCEPTION 'acquisition_daily_send_limit'; END IF;
  UPDATE public.admin_acquisition_attempts SET status='reserved',recipient_email=p_email,subject=p_subject,body=p_body,
    reserved_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE id=p_attempt_id;
  RETURN p_attempt_id;
END $$;

-- Keep the existing shared daily ceiling of 25, counting real and mock reservations.
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
    'daily_sends',public.mahshar_acquisition_daily_reserved(),
    'daily_simulated_sent',(SELECT count(*) FROM public.admin_acquisition_attempts
      WHERE status='simulated_sent' AND dispatched_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND dispatched_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day'),
    'daily_runs',(SELECT count(*) FROM public.worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')
      AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')
  )
$$;
