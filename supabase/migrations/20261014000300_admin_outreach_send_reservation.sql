-- Audit remediation: reserve the existing approved message before transport.
-- Nullable fields preserve historical rows; uncertain reservations are never reused.
ALTER TABLE public.admin_outreach_messages
  ADD COLUMN send_reserved_at timestamptz,
  ADD COLUMN send_uncertain_at timestamptz;

CREATE FUNCTION public.mahshar_admin_outreach_reserve_send(p_message_id uuid)
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
  UPDATE public.admin_outreach_messages SET send_reserved_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=p_message_id;
  RETURN true;
END $$;

CREATE FUNCTION public.mahshar_admin_outreach_finish_send(p_message_id uuid,p_provider_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages; finished_at timestamptz:=clock_timestamp();
BEGIN
  IF p_provider_message_id IS NOT NULL AND (length(p_provider_message_id) NOT BETWEEN 1 AND 512
    OR p_provider_message_id ~* '^simulated:') THEN RAISE EXCEPTION 'admin_outreach_delivery_invalid'; END IF;
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.direction<>'outbound' THEN RAISE EXCEPTION 'admin_outreach_message_missing'; END IF;
  IF message.status='sent' THEN
    IF p_provider_message_id IS NOT NULL AND message.provider_message_id IS DISTINCT FROM p_provider_message_id
      THEN RAISE EXCEPTION 'admin_outreach_delivery_conflict'; END IF;
    RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,'status',message.status);
  END IF;
  IF message.send_reserved_at IS NULL THEN RAISE EXCEPTION 'admin_outreach_delivery_not_reserved'; END IF;
  IF p_provider_message_id IS NULL THEN
    UPDATE public.admin_outreach_messages SET send_uncertain_at=coalesce(send_uncertain_at,finished_at),
      updated_at=finished_at WHERE id=p_message_id;
  ELSE
    UPDATE public.admin_outreach_messages SET status='sent',provider_message_id=p_provider_message_id,
      sent_at=finished_at,updated_at=finished_at WHERE id=p_message_id;
    -- Record an already dispatched result without undoing suppression or a newer reply.
    UPDATE public.admin_outreach_threads SET
      status=CASE WHEN status IN ('draft','needs_reply') AND
        (last_reply_at IS NULL OR last_reply_at<message.send_reserved_at) THEN 'sent' ELSE status END,
      last_outreach_at=finished_at,updated_at=finished_at WHERE id=message.thread_id;
  END IF;
  RETURN jsonb_build_object('id',message.id,'threadId',message.thread_id,
    'status',CASE WHEN p_provider_message_id IS NULL THEN message.status ELSE 'sent' END);
END $$;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_reserve_send(uuid),
  public.mahshar_admin_outreach_finish_send(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_reserve_send(uuid),
  public.mahshar_admin_outreach_finish_send(uuid,text) TO service_role;
