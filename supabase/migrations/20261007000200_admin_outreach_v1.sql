-- Admin Outreach V1. Drafting is manual and no mail transport is configured.
-- Tables remain private; authenticated Admin API routes call the service-role-only RPCs.

CREATE TABLE public.admin_outreach_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'contact_ready' CHECK (status IN (
    'contact_ready','draft','sent','needs_reply','interested','rejected','do_not_contact','closed'
  )),
  last_outreach_at timestamptz,
  last_reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id),
  FOREIGN KEY (lead_id, provider_id) REFERENCES public.worker_leads(id, provider_id)
);

CREATE TABLE public.admin_outreach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.admin_outreach_threads(id),
  direction text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','ready_to_send','sent','failed','received'
  )),
  recipient_email text NOT NULL CHECK (
    length(recipient_email) BETWEEN 3 AND 254 AND recipient_email=lower(recipient_email)
    AND recipient_email ~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  sender_email text NOT NULL DEFAULT 'support@mahshar.xyz' CHECK (
    length(sender_email) BETWEEN 3 AND 254 AND sender_email=lower(sender_email)
    AND sender_email ~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 512),
  approved_by text CHECK (approved_by IS NULL OR approved_by ~ '^0x[0-9a-f]{40}$'),
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('ready_to_send','sent')) = (approved_at IS NOT NULL)),
  CHECK ((status='sent') = (sent_at IS NOT NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);

CREATE INDEX admin_outreach_threads_status_updated
  ON public.admin_outreach_threads(status, updated_at DESC);
CREATE INDEX admin_outreach_messages_thread_created
  ON public.admin_outreach_messages(thread_id, created_at DESC);
CREATE UNIQUE INDEX admin_outreach_one_editable_draft
  ON public.admin_outreach_messages(thread_id) WHERE status='draft';

ALTER TABLE public.admin_outreach_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_outreach_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.admin_outreach_threads, public.admin_outreach_messages
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_outreach_threads, public.admin_outreach_messages TO service_role;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_save_draft(
  p_provider_id uuid,
  p_lead_id uuid,
  p_recipient_email text,
  p_subject text,
  p_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  provider public.worker_providers;
  lead public.worker_leads;
  thread public.admin_outreach_threads;
  message public.admin_outreach_messages;
BEGIN
  IF p_provider_id IS NULL OR p_lead_id IS NULL
    OR p_recipient_email IS NULL OR p_recipient_email<>lower(p_recipient_email)
    OR p_recipient_email !~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    OR coalesce(length(btrim(p_subject)),0) NOT BETWEEN 1 AND 200
    OR coalesce(length(btrim(p_body)),0) NOT BETWEEN 1 AND 5000
  THEN RAISE EXCEPTION 'admin_outreach_draft_invalid'; END IF;

  SELECT * INTO provider FROM public.worker_providers WHERE id=p_provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads
    WHERE id=p_lead_id AND provider_id=p_provider_id FOR UPDATE;
  IF provider.id IS NULL OR lead.id IS NULL THEN RAISE EXCEPTION 'admin_outreach_identity_invalid'; END IF;

  IF provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR lead.qualification_status NOT IN ('qualified','review_candidate')
    OR lead.contactability_status<>'verified_email' OR NOT lead.email_ready
    OR lead.preferred_email IS DISTINCT FROM p_recipient_email
    OR EXISTS (SELECT 1 FROM public.worker_decisions
      WHERE (lead_id=p_lead_id OR (provider_id=p_provider_id AND lead_id IS NULL))
        AND decision IN ('rejected','do_not_contact'))
    OR NOT EXISTS (SELECT 1 FROM public.worker_contacts
      WHERE provider_id=p_provider_id AND lead_id=p_lead_id AND contact_type='email'
        AND value=p_recipient_email AND verification_status='verified' AND preferred AND email_ready
        AND purpose NOT IN ('security','privacy','abuse','legal','dmca','copyright','compliance','reporting'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;

  INSERT INTO public.admin_outreach_threads(lead_id,provider_id,status)
  VALUES(p_lead_id,p_provider_id,'contact_ready')
  ON CONFLICT(lead_id) DO NOTHING;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE lead_id=p_lead_id FOR UPDATE;
  IF thread.status IN ('sent','needs_reply','interested','rejected','do_not_contact','closed')
    OR EXISTS(SELECT 1 FROM public.admin_outreach_messages
      WHERE thread_id=thread.id AND status='ready_to_send')
  THEN RAISE EXCEPTION 'admin_outreach_thread_blocked'; END IF;

  SELECT * INTO message FROM public.admin_outreach_messages
    WHERE thread_id=thread.id AND status='draft' FOR UPDATE;
  IF FOUND THEN
    UPDATE public.admin_outreach_messages SET recipient_email=p_recipient_email,
      subject=btrim(p_subject),body=btrim(p_body),updated_at=clock_timestamp()
      WHERE id=message.id RETURNING * INTO message;
  ELSE
    INSERT INTO public.admin_outreach_messages(thread_id,recipient_email,subject,body)
    VALUES(thread.id,p_recipient_email,btrim(p_subject),btrim(p_body)) RETURNING * INTO message;
  END IF;
  UPDATE public.admin_outreach_threads SET status='draft',updated_at=clock_timestamp()
    WHERE id=thread.id;
  RETURN jsonb_build_object('id',message.id,'threadId',thread.id,'status',message.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_edit_draft(
  p_message_id uuid,
  p_subject text,
  p_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  message public.admin_outreach_messages;
  thread public.admin_outreach_threads;
  provider public.worker_providers;
  lead public.worker_leads;
BEGIN
  IF p_message_id IS NULL OR coalesce(length(btrim(p_subject)),0) NOT BETWEEN 1 AND 200
    OR coalesce(length(btrim(p_body)),0) NOT BETWEEN 1 AND 5000
  THEN RAISE EXCEPTION 'admin_outreach_draft_invalid'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.status<>'draft' THEN RAISE EXCEPTION 'admin_outreach_draft_not_editable'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads
    WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status<>'draft' OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR EXISTS (SELECT 1 FROM public.worker_decisions
      WHERE (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL))
        AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  UPDATE public.admin_outreach_messages SET subject=btrim(p_subject),body=btrim(p_body),
    updated_at=clock_timestamp() WHERE id=p_message_id RETURNING * INTO message;
  RETURN jsonb_build_object('id',message.id,'threadId',thread.id,'status',message.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_approve_draft(
  p_message_id uuid,
  p_admin_wallet text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  message public.admin_outreach_messages;
  thread public.admin_outreach_threads;
  provider public.worker_providers;
  lead public.worker_leads;
BEGIN
  IF p_message_id IS NULL OR p_admin_wallet IS NULL OR p_admin_wallet<>lower(p_admin_wallet)
    OR p_admin_wallet !~ '^0x[0-9a-f]{40}$'
  THEN RAISE EXCEPTION 'admin_outreach_approval_invalid'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.status<>'draft' THEN RAISE EXCEPTION 'admin_outreach_draft_not_approvable'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads
    WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status<>'draft' OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR NOT lead.email_ready OR lead.contactability_status<>'verified_email'
    OR lead.preferred_email IS DISTINCT FROM message.recipient_email
    OR EXISTS (SELECT 1 FROM public.worker_decisions
      WHERE (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL))
        AND decision IN ('rejected','do_not_contact'))
    OR NOT EXISTS (SELECT 1 FROM public.worker_contacts
      WHERE provider_id=provider.id AND lead_id=lead.id AND contact_type='email'
        AND value=message.recipient_email AND verification_status='verified' AND preferred AND email_ready
        AND purpose NOT IN ('security','privacy','abuse','legal','dmca','copyright','compliance','reporting'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  UPDATE public.admin_outreach_messages SET status='ready_to_send',approved_by=p_admin_wallet,
    approved_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=p_message_id RETURNING * INTO message;
  UPDATE public.admin_outreach_threads SET updated_at=clock_timestamp() WHERE id=thread.id;
  RETURN jsonb_build_object('id',message.id,'threadId',thread.id,'status',message.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_set_status(
  p_provider_id uuid,
  p_lead_id uuid,
  p_status text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  thread public.admin_outreach_threads;
  lead public.worker_leads;
  allowed boolean:=false;
BEGIN
  IF p_provider_id IS NULL OR p_lead_id IS NULL OR p_status NOT IN (
    'contact_ready','draft','sent','needs_reply','interested','rejected','do_not_contact','closed'
  ) THEN RAISE EXCEPTION 'admin_outreach_status_invalid'; END IF;
  SELECT * INTO lead FROM public.worker_leads
    WHERE id=p_lead_id AND provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin_outreach_identity_invalid'; END IF;
  INSERT INTO public.admin_outreach_threads(lead_id,provider_id,status)
    SELECT p_lead_id,p_provider_id,'contact_ready'
    WHERE p_status IN ('do_not_contact','closed')
    ON CONFLICT(lead_id) DO NOTHING;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE lead_id=p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin_outreach_thread_missing'; END IF;
  IF lead.status IN ('rejected','do_not_contact','closed')
    OR EXISTS (SELECT 1 FROM public.worker_decisions
      WHERE (lead_id=lead.id OR (provider_id=lead.provider_id AND lead_id IS NULL))
        AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;

  allowed := thread.status=p_status
    OR (thread.status='contact_ready' AND p_status IN ('draft','do_not_contact','closed'))
    OR (thread.status='draft' AND p_status IN ('contact_ready','do_not_contact','closed'))
    OR (thread.status='sent' AND p_status IN ('needs_reply','interested','rejected','do_not_contact','closed'))
    OR (thread.status='needs_reply' AND p_status IN ('sent','interested','rejected','do_not_contact','closed'))
    OR (thread.status='interested' AND p_status IN ('needs_reply','rejected','do_not_contact','closed'))
    OR (thread.status='rejected' AND p_status IN ('do_not_contact','closed'));
  IF NOT allowed THEN RAISE EXCEPTION 'admin_outreach_transition_invalid'; END IF;
  UPDATE public.admin_outreach_threads SET status=p_status,updated_at=clock_timestamp()
    WHERE id=thread.id RETURNING * INTO thread;
  RETURN jsonb_build_object('id',thread.id,'leadId',thread.lead_id,'status',thread.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_mark_sent(
  p_message_id uuid,
  p_provider_message_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  message public.admin_outreach_messages;
  thread public.admin_outreach_threads;
  provider public.worker_providers;
  lead public.worker_leads;
BEGIN
  IF p_message_id IS NULL OR coalesce(length(p_provider_message_id),0) NOT BETWEEN 1 AND 512
  THEN RAISE EXCEPTION 'admin_outreach_delivery_invalid'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin_outreach_message_missing'; END IF;
  IF message.status='sent' THEN
    IF message.provider_message_id IS DISTINCT FROM p_provider_message_id
      THEN RAISE EXCEPTION 'admin_outreach_delivery_conflict'; END IF;
    RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,'status',message.status);
  END IF;
  IF message.status<>'ready_to_send' THEN RAISE EXCEPTION 'admin_outreach_message_not_approved'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads
    WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status<>'draft' OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR EXISTS (SELECT 1 FROM public.worker_decisions
      WHERE (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL))
        AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  UPDATE public.admin_outreach_messages SET status='sent',provider_message_id=p_provider_message_id,
    sent_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=p_message_id RETURNING * INTO message;
  UPDATE public.admin_outreach_threads SET status='sent',last_outreach_at=message.sent_at,
    updated_at=clock_timestamp() WHERE id=thread.id;
  RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,'status',message.status);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_save_draft(uuid,uuid,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_edit_draft(uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_approve_draft(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_set_status(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_mark_sent(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_save_draft(uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_edit_draft(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_approve_draft(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_set_status(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_mark_sent(uuid,text) TO service_role;
