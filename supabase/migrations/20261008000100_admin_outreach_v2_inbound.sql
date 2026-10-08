-- Admin Outreach V2: compact inbound replies and manually approved reply drafts.
-- The mailbox bridge is external; this migration performs no network or mailbox work.

ALTER TABLE public.admin_outreach_messages
  ALTER COLUMN thread_id DROP NOT NULL,
  ADD COLUMN in_reply_to text CHECK (in_reply_to IS NULL OR length(in_reply_to) BETWEEN 1 AND 512),
  ADD COLUMN reference_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN received_at timestamptz,
  ADD COLUMN classification text CHECK (classification IS NULL OR classification IN (
    'interested','payment_question','technical_question','not_interested','do_not_contact','other'
  )),
  ADD COLUMN classification_confidence numeric(4,3)
    CHECK (classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 1),
  ADD COLUMN classification_reason text
    CHECK (classification_reason IS NULL OR length(classification_reason) BETWEEN 1 AND 500),
  ADD COLUMN processing_state text NOT NULL DEFAULT 'not_applicable' CHECK (processing_state IN (
    'not_applicable','received','unmatched','classified','suggested','suggestion_failed'
  )),
  ADD COLUMN matched_by text CHECK (matched_by IS NULL OR matched_by IN (
    'in_reply_to','reference','subject_context','sender_unambiguous'
  )),
  ADD COLUMN reply_to_message_id uuid REFERENCES public.admin_outreach_messages(id),
  ADD CONSTRAINT admin_outreach_message_direction_shape CHECK (
    (direction='outbound' AND thread_id IS NOT NULL AND processing_state='not_applicable')
    OR (direction='inbound' AND status='received' AND provider_message_id IS NOT NULL
      AND received_at IS NOT NULL AND processing_state<>'not_applicable')
  ),
  ADD CONSTRAINT admin_outreach_reference_count CHECK (cardinality(reference_ids) <= 12),
  ADD CONSTRAINT admin_outreach_reply_draft_shape CHECK (
    reply_to_message_id IS NULL OR direction='outbound'
  );

CREATE UNIQUE INDEX admin_outreach_inbound_provider_message
  ON public.admin_outreach_messages(provider_message_id)
  WHERE direction='inbound';
CREATE INDEX admin_outreach_inbound_processing
  ON public.admin_outreach_messages(processing_state,received_at DESC)
  WHERE direction='inbound';

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_ingest_inbound(
  p_provider_message_id text,
  p_in_reply_to text,
  p_reference_ids text[],
  p_sender_email text,
  p_recipient_email text,
  p_subject text,
  p_body text,
  p_received_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  existing public.admin_outreach_messages;
  inbound public.admin_outreach_messages;
  candidates uuid[];
  matched_thread_id uuid;
  match_kind text;
  normalized_subject text;
  ambiguous_evidence boolean:=false;
BEGIN
  IF p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 512
    OR p_provider_message_id ~ '[\r\n]'
    OR p_in_reply_to IS NOT NULL AND (length(p_in_reply_to) NOT BETWEEN 1 AND 512 OR p_in_reply_to ~ '[\r\n]')
    OR coalesce(cardinality(p_reference_ids),0) > 12
    OR EXISTS (SELECT 1 FROM unnest(coalesce(p_reference_ids,'{}'::text[])) value
      WHERE length(value) NOT BETWEEN 1 AND 512 OR value ~ '[\r\n]')
    OR p_sender_email IS NULL OR p_sender_email<>lower(p_sender_email)
    OR p_sender_email !~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    OR p_recipient_email IS NULL OR p_recipient_email<>'support@mahshar.xyz'
    OR coalesce(length(btrim(p_subject)),0) NOT BETWEEN 1 AND 200
    OR coalesce(length(btrim(p_body)),0) NOT BETWEEN 1 AND 5000
    OR p_received_at IS NULL
  THEN RAISE EXCEPTION 'admin_outreach_inbound_invalid'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_message_id,80421));
  SELECT * INTO existing FROM public.admin_outreach_messages
    WHERE direction='inbound' AND provider_message_id=p_provider_message_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('id',existing.id,'threadId',existing.thread_id,'matchedBy',existing.matched_by,
      'processingState',existing.processing_state,'duplicate',true);
  END IF;

  IF p_in_reply_to IS NOT NULL THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND lower(btrim(message.provider_message_id,'<> '))=lower(btrim(p_in_reply_to,'<> '));
    IF cardinality(candidates)=1 THEN
      matched_thread_id:=candidates[1]; match_kind:='in_reply_to';
    ELSIF cardinality(candidates)>1 THEN ambiguous_evidence:=true;
    END IF;
  END IF;

  IF matched_thread_id IS NULL AND NOT ambiguous_evidence AND cardinality(p_reference_ids)>0 THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p_reference_ids) reference_id
        WHERE lower(btrim(message.provider_message_id,'<> '))=lower(btrim(reference_id,'<> ')));
    IF cardinality(candidates)=1 THEN
      matched_thread_id:=candidates[1]; match_kind:='reference';
    ELSIF cardinality(candidates)>1 THEN ambiguous_evidence:=true;
    END IF;
  END IF;

  normalized_subject:=regexp_replace(lower(btrim(p_subject)),'^((re|fw|fwd)\s*:\s*)+','','i');
  IF matched_thread_id IS NULL AND NOT ambiguous_evidence THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND message.recipient_email=p_sender_email AND message.sender_email=p_recipient_email
      AND regexp_replace(lower(btrim(message.subject)),'^((re|fw|fwd)\s*:\s*)+','','i')=normalized_subject;
    IF cardinality(candidates)=1 THEN
      matched_thread_id:=candidates[1]; match_kind:='subject_context';
    ELSIF cardinality(candidates)>1 THEN ambiguous_evidence:=true;
    END IF;
  END IF;

  IF matched_thread_id IS NULL AND NOT ambiguous_evidence THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND message.recipient_email=p_sender_email AND message.sender_email=p_recipient_email;
    IF cardinality(candidates)=1 THEN matched_thread_id:=candidates[1]; match_kind:='sender_unambiguous'; END IF;
  END IF;

  INSERT INTO public.admin_outreach_messages(thread_id,direction,status,recipient_email,sender_email,
    subject,body,provider_message_id,in_reply_to,reference_ids,received_at,processing_state,matched_by)
  VALUES(matched_thread_id,'inbound','received',p_recipient_email,p_sender_email,btrim(p_subject),btrim(p_body),
    p_provider_message_id,p_in_reply_to,coalesce(p_reference_ids,'{}'::text[]),p_received_at,
    CASE WHEN matched_thread_id IS NULL THEN 'unmatched' ELSE 'received' END,match_kind)
  RETURNING * INTO inbound;

  IF matched_thread_id IS NOT NULL THEN
    UPDATE public.admin_outreach_threads SET last_reply_at=p_received_at,updated_at=clock_timestamp()
      WHERE id=matched_thread_id;
  END IF;
  RETURN jsonb_build_object('id',inbound.id,'threadId',inbound.thread_id,'matchedBy',inbound.matched_by,
    'processingState',inbound.processing_state,'duplicate',false);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_finalize_inbound(
  p_message_id uuid,
  p_classification text,
  p_confidence numeric,
  p_reason text,
  p_processing_state text,
  p_suggested_subject text,
  p_suggested_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  inbound public.admin_outreach_messages;
  thread public.admin_outreach_threads;
  draft public.admin_outreach_messages;
  actionable boolean;
  allow_suggestion boolean:=false;
BEGIN
  IF p_message_id IS NULL OR p_classification NOT IN (
      'interested','payment_question','technical_question','not_interested','do_not_contact','other')
    OR p_confidence IS NULL OR p_confidence NOT BETWEEN 0 AND 1
    OR coalesce(length(btrim(p_reason)),0) NOT BETWEEN 1 AND 500
    OR p_processing_state NOT IN ('classified','suggested','suggestion_failed')
    OR ((p_suggested_subject IS NULL)<>(p_suggested_body IS NULL))
    OR (p_suggested_subject IS NOT NULL AND coalesce(length(btrim(p_suggested_subject)),0) NOT BETWEEN 1 AND 200)
    OR (p_suggested_body IS NOT NULL AND coalesce(length(btrim(p_suggested_body)),0) NOT BETWEEN 1 AND 5000)
    OR (p_processing_state='suggested' AND p_suggested_body IS NULL)
  THEN RAISE EXCEPTION 'admin_outreach_inbound_classification_invalid'; END IF;

  SELECT * INTO inbound FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR inbound.direction<>'inbound' OR inbound.thread_id IS NULL
    THEN RAISE EXCEPTION 'admin_outreach_inbound_not_matched'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=inbound.thread_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin_outreach_thread_missing'; END IF;

  actionable:=p_classification IN ('interested','payment_question','technical_question','other');
  IF thread.status='closed' THEN NULL;
  ELSIF thread.status='do_not_contact' OR p_classification='do_not_contact' THEN
    UPDATE public.admin_outreach_threads SET status='do_not_contact',updated_at=clock_timestamp() WHERE id=thread.id;
  ELSIF thread.status='rejected' THEN NULL;
  ELSIF p_classification='not_interested' THEN
    UPDATE public.admin_outreach_threads SET status='rejected',updated_at=clock_timestamp() WHERE id=thread.id;
  ELSIF p_classification='interested' AND thread.status IN ('sent','needs_reply','interested') THEN
    UPDATE public.admin_outreach_threads SET status='interested',updated_at=clock_timestamp() WHERE id=thread.id;
    allow_suggestion:=true;
  ELSIF actionable AND thread.status IN ('sent','needs_reply','interested') THEN
    UPDATE public.admin_outreach_threads SET status='needs_reply',updated_at=clock_timestamp() WHERE id=thread.id;
    allow_suggestion:=true;
  END IF;

  IF allow_suggestion AND p_suggested_body IS NOT NULL THEN
    SELECT * INTO draft FROM public.admin_outreach_messages
      WHERE thread_id=thread.id AND status IN ('draft','ready_to_send') ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO public.admin_outreach_messages(thread_id,direction,status,recipient_email,sender_email,
        subject,body,reply_to_message_id)
      VALUES(thread.id,'outbound','draft',inbound.sender_email,'support@mahshar.xyz',
        btrim(p_suggested_subject),btrim(p_suggested_body),inbound.id)
      RETURNING * INTO draft;
    END IF;
  END IF;

  UPDATE public.admin_outreach_messages SET classification=p_classification,
    classification_confidence=p_confidence,classification_reason=btrim(p_reason),
    processing_state=CASE WHEN draft.id IS NOT NULL THEN 'suggested'
      WHEN p_processing_state='suggested' THEN 'suggestion_failed' ELSE p_processing_state END,
    updated_at=clock_timestamp()
    WHERE id=inbound.id RETURNING * INTO inbound;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=inbound.thread_id;
  RETURN jsonb_build_object('id',inbound.id,'threadId',inbound.thread_id,'threadStatus',thread.status,
    'processingState',inbound.processing_state,'draftId',draft.id);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_edit_reply_draft(
  p_message_id uuid,p_subject text,p_body text
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
  IF NOT FOUND OR message.status<>'draft' OR message.reply_to_message_id IS NULL
    THEN RAISE EXCEPTION 'admin_outreach_reply_draft_not_editable'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status NOT IN ('needs_reply','interested') OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE
      (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL)) AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  UPDATE public.admin_outreach_messages SET subject=btrim(p_subject),body=btrim(p_body),updated_at=clock_timestamp()
    WHERE id=message.id RETURNING * INTO message;
  RETURN jsonb_build_object('id',message.id,'threadId',thread.id,'status',message.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_approve_reply_draft(
  p_message_id uuid,p_admin_wallet text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  message public.admin_outreach_messages;
  thread public.admin_outreach_threads;
  provider public.worker_providers;
  lead public.worker_leads;
BEGIN
  IF p_message_id IS NULL OR p_admin_wallet IS NULL OR p_admin_wallet<>lower(p_admin_wallet)
    OR p_admin_wallet !~ '^0x[0-9a-f]{40}$' THEN RAISE EXCEPTION 'admin_outreach_approval_invalid'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.status<>'draft' OR message.reply_to_message_id IS NULL
    THEN RAISE EXCEPTION 'admin_outreach_reply_draft_not_approvable'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status NOT IN ('needs_reply','interested') OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR NOT EXISTS (SELECT 1 FROM public.admin_outreach_messages inbound
      WHERE inbound.id=message.reply_to_message_id AND inbound.thread_id=thread.id
        AND inbound.direction='inbound' AND inbound.sender_email=message.recipient_email)
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE
      (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL)) AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  UPDATE public.admin_outreach_messages SET status='ready_to_send',approved_by=p_admin_wallet,
    approved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=message.id RETURNING * INTO message;
  UPDATE public.admin_outreach_threads SET updated_at=clock_timestamp() WHERE id=thread.id;
  RETURN jsonb_build_object('id',message.id,'threadId',thread.id,'status',message.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_mark_reply_sent(
  p_message_id uuid,p_provider_message_id text
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
  IF NOT FOUND OR message.reply_to_message_id IS NULL THEN RAISE EXCEPTION 'admin_outreach_message_missing'; END IF;
  IF message.status='sent' THEN
    IF message.provider_message_id IS DISTINCT FROM p_provider_message_id
      THEN RAISE EXCEPTION 'admin_outreach_delivery_conflict'; END IF;
    RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,'status',message.status);
  END IF;
  IF message.status<>'ready_to_send' THEN RAISE EXCEPTION 'admin_outreach_message_not_approved'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status NOT IN ('needs_reply','interested') OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE
      (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL)) AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  UPDATE public.admin_outreach_messages SET status='sent',provider_message_id=p_provider_message_id,
    sent_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=message.id RETURNING * INTO message;
  UPDATE public.admin_outreach_threads SET status='sent',last_outreach_at=message.sent_at,
    updated_at=clock_timestamp() WHERE id=thread.id;
  RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,'status',message.status);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_assert_reply_sendable(
  p_message_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  message public.admin_outreach_messages;
  thread public.admin_outreach_threads;
  provider public.worker_providers;
  lead public.worker_leads;
BEGIN
  IF p_message_id IS NULL THEN RAISE EXCEPTION 'admin_outreach_message_missing'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.status<>'ready_to_send' OR message.reply_to_message_id IS NULL
    THEN RAISE EXCEPTION 'admin_outreach_message_not_approved'; END IF;
  SELECT * INTO thread FROM public.admin_outreach_threads WHERE id=message.thread_id FOR UPDATE;
  SELECT * INTO provider FROM public.worker_providers WHERE id=thread.provider_id FOR UPDATE;
  SELECT * INTO lead FROM public.worker_leads WHERE id=thread.lead_id AND provider_id=thread.provider_id FOR UPDATE;
  IF thread.status NOT IN ('needs_reply','interested') OR provider.status IN ('rejected','do_not_contact')
    OR lead.status IN ('rejected','do_not_contact','closed')
    OR EXISTS (SELECT 1 FROM public.worker_decisions WHERE
      (lead_id=lead.id OR (provider_id=provider.id AND lead_id IS NULL)) AND decision IN ('rejected','do_not_contact'))
  THEN RAISE EXCEPTION 'admin_outreach_lead_blocked'; END IF;
  RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,'status',message.status);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_ingest_inbound(text,text,text[],text,text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_finalize_inbound(uuid,text,numeric,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_edit_reply_draft(uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_approve_reply_draft(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_mark_reply_sent(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_assert_reply_sendable(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_ingest_inbound(text,text,text[],text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_finalize_inbound(uuid,text,numeric,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_edit_reply_draft(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_approve_reply_draft(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_mark_reply_sent(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_assert_reply_sendable(uuid) TO service_role;
